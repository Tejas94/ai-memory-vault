// One-time backfill and review tool for the knowledge graph. Run by the owner or a Claude Code session they
// started, never by a chat app (there is no MCP tool that writes the graph).
//
//   npx tsx scripts/graph-sync.ts status [--remote]
//   npx tsx scripts/graph-sync.ts export <out-dir> [--type fact|conversation|document|project|profile] [--limit N] [--remote]
//   npx tsx scripts/graph-sync.ts import <file.json> [...more files] [--remote]
//   npx tsx scripts/graph-sync.ts tidy [--remote]   (switch off entities left with no link)
//   npx tsx scripts/graph-sync.ts categories-export <out-dir> | categories-import <file>   (file things under is_a categories)
//
// export writes the text of items not yet in the graph to <out-dir> (keep it OUTSIDE this repo: it is
// personal data). import reads files shaped like
//   {"items":[{"origin":{"type":"fact","id":"42"},"entities":[...],"relations":[...]}]}
// and stores them through the same graph writer the auto-update uses.
// --remote uses the live D1 database (needs CLOUDFLARE_API_TOKEN); without it, the local copy.
// --rest (with --remote) goes over the HTTP API instead, for machines that cannot open wrangler's tunnel.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CATEGORIES, categoryOf, ORIGIN_TYPES, type OriginType } from "../src/graph/schema";
import { retireOrphans, writeGraph } from "../src/graph/write";
import { openEnv } from "./d1-rest";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(`--${name}`);
	if (i < 0) return undefined;
	const v = args[i + 1];
	args.splice(i, v && !v.startsWith("--") ? 2 : 1);
	return v && !v.startsWith("--") ? v : "true";
};
const remote = flag("remote") === "true";
const useRest = flag("rest") === "true"; // --rest: reach the live DB over the HTTP API (scripts/d1-rest.ts)
const onlyType = flag("type") as OriginType | undefined;
const limit = Number(flag("limit") ?? 1e9);
const [command, ...rest] = args;

// Each item kind: how to list current items and their text. "Done" = has a write entry in graph_log.
const SOURCES: Record<OriginType, { list: string; text: (r: any) => string }> = {
	fact: {
		list: "SELECT CAST(row_id AS TEXT) AS id, fact, category, created FROM facts WHERE active = 1",
		text: (r) => `Fact (${r.category}): ${r.fact}`,
	},
	profile: {
		list: "SELECT section AS id, content, created FROM profile WHERE active = 1",
		text: (r) => `Owner's profile, ${r.id}: ${r.content}`,
	},
	project: {
		list: "SELECT id, name, description, status, created FROM projects WHERE active = 1",
		text: (r) => `Project "${r.name}" (id ${r.id}, status ${r.status}): ${r.description ?? ""}`,
	},
	document: {
		list: "SELECT doc_id AS id, name, content, created FROM documents WHERE active = 1",
		text: (r) => `Document: ${r.name}\n${r.content}`,
	},
	conversation: {
		list: "SELECT id, title, source, created FROM conversations WHERE active = 1",
		text: () => "", // filled from messages below
	},
};

async function pending(db: D1Database, type: OriginType) {
	const { results: items } = await db.prepare(SOURCES[type].list).all<any>();
	const { results: done } = await db
		.prepare("SELECT DISTINCT item_id FROM graph_log WHERE item_type = ? AND step = 'write' AND status IN ('ok','review')")
		.bind(type)
		.all<{ item_id: string }>();
	const doneIds = new Set(done.map((d) => d.item_id));
	return { total: items.length, todo: items.filter((i) => !doneIds.has(String(i.id))) };
}

async function main() {
	const config = remote || useRest ? "scripts/graph-sync.wrangler.jsonc" : "wrangler.jsonc";
	// envFiles: [] so no .env / .dev.vars file is ever read
	const proxy = await openEnv(config, remote, useRest);
	const db = proxy.env.DB;
	try {
		if (command === "status") {
			for (const type of ORIGIN_TYPES) {
				const { total, todo } = await pending(db, type);
				console.log(`${type.padEnd(13)} ${String(total - todo.length).padStart(6)} / ${total} in the graph`);
			}
			const counts = await db
				.prepare(
					`SELECT (SELECT count(*) FROM entities WHERE active = 1) AS entities,
					        (SELECT count(*) FROM relations WHERE active = 1) AS links,
					        (SELECT count(*) FROM graph_log WHERE status = 'failed') AS failed,
					        (SELECT count(*) FROM graph_log WHERE status = 'review') AS review`,
				)
				.first();
			console.log(counts);
		} else if (command === "export") {
			const out = rest[0];
			if (!out) throw new Error("export needs an output folder (outside the repo)");
			if (!relative(process.cwd(), resolve(out)).startsWith("..")) {
				throw new Error("Refusing to export personal data inside the repo; pass a folder outside it");
			}
			mkdirSync(out, { recursive: true });
			for (const type of onlyType ? [onlyType] : ORIGIN_TYPES) {
				const { todo } = await pending(db, type);
				const items = [];
				for (const row of todo.slice(0, limit)) {
					let text = SOURCES[type].text(row);
					if (type === "conversation") {
						const { results: msgs } = await db
							.prepare("SELECT role, text FROM messages WHERE conversation_id = ? AND active = 1 ORDER BY seq")
							.bind(row.id)
							.all<{ role: string; text: string }>();
						text = `Chat: ${row.title ?? "Untitled"} (${row.source}, ${row.created ?? "?"})\n${msgs
							.map((m) => `${m.role === "you" ? "Owner" : "AI"}: ${m.text}`)
							.join("\n")}`;
					}
					// The item's own date travels with it, so the importer can apply "old never overwrites new"
					items.push({ origin: { type, id: String(row.id) }, date: row.created ?? null, text });
				}
				writeFileSync(join(out, `${type}.json`), JSON.stringify(items, null, 1));
				console.log(`${type}: ${items.length} pending item(s) → ${join(out, `${type}.json`)}`);
			}
		} else if (command === "import") {
			if (!rest.length) throw new Error("import needs at least one file");
			let n = 0;
			const totals = { entities_created: 0, relations_added: 0, relations_retired: 0, review: 0 };
			for (const file of rest) {
				const { items } = JSON.parse(readFileSync(file, "utf8")) as { items: any[] };
				for (const item of items) {
					const r = await writeGraph(db, { entities: item.entities ?? [], relations: item.relations ?? [] }, item.origin, {
						source: "graph_backfill",
						replaceOrigin: true,
						asOf: item.date ?? undefined,
					});
					totals.entities_created += r.entities_created;
					totals.relations_added += r.relations_added;
					totals.relations_retired += r.relations_retired;
					totals.review += r.review.length;
					n++;
				}
			}
			console.log(`Imported ${n} item(s):`, totals);
		} else if (command === "categories-export") {
			// Things, places and organisations not yet filed under a category, with their links for context
			const out = rest[0];
			if (!out || !relative(process.cwd(), resolve(out)).startsWith("..")) throw new Error("categories-export needs a folder outside the repo");
			mkdirSync(out, { recursive: true });
			const { results } = await db
				.prepare(
					`SELECT e.id, e.name, e.type,
					        (SELECT group_concat(r.relation || ': ' || coalesce(r.value, r.to_id, ''), ' | ') FROM
					          (SELECT relation, value, to_id FROM relations WHERE active = 1 AND (from_id = e.id OR to_id = e.id) LIMIT 4) r) AS links
					 FROM entities e WHERE e.active = 1 AND e.type IN ('thing','place','organisation')
					   AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.active = 1 AND r.relation = 'is_a' AND r.from_id = e.id)
					 ORDER BY e.type, e.name`,
				)
				.all<{ id: string; name: string; type: string; links: string | null }>();
			writeFileSync(join(out, "categories-todo.json"), JSON.stringify(results, null, 1));
			console.log(`${results.length} entities without a category → ${join(out, "categories-todo.json")}`);
			console.log(`Allowed categories: ${Object.keys(CATEGORIES).join(", ")}`);
		} else if (command === "categories-import") {
			// {"items":[{"id":"thing:fiat-panda","category":"car"}]}: one is_a link each, stored with the
			// item behind the entity's newest link (a fact if there is one), like any other link
			const { items } = JSON.parse(readFileSync(rest[0], "utf8")) as { items: { id: string; category: string }[] };
			const totals = { filed: 0, skipped: 0 };
			for (const item of items) {
				const e = await db.prepare("SELECT name, type FROM entities WHERE id = ? AND active = 1").bind(item.id).first<{ name: string; type: any }>();
				const origin = await db
					.prepare(
						`SELECT origin_type AS type, origin_id AS id FROM relations WHERE active = 1 AND (from_id = ?1 OR to_id = ?1)
						 ORDER BY origin_type = 'fact' DESC, created DESC LIMIT 1`,
					)
					.bind(item.id)
					.first<{ type: OriginType; id: string }>();
				if (!e || !origin || !categoryOf(item.category)) {
					totals.skipped++;
					console.log(`skipped ${item.id} (${!e ? "not current" : !origin ? "no links" : `"${item.category}" not on the list`})`);
					continue;
				}
				const r = await writeGraph(
					db,
					{ entities: [{ name: e.name, type: e.type }], relations: [{ from: e.name, relation: "is_a", to: item.category }] },
					origin,
					{ source: "graph_backfill" },
				);
				if (r.relations_added) totals.filed++;
				else totals.skipped++;
			}
			console.log("Categories:", totals);
		} else if (command === "tidy") {
			// Retire people/places/things with no current link (normally done on every graph write)
			const count = () => db.prepare(`SELECT count(*) AS n FROM entities WHERE active = 1`).first<{ n: number }>();
			const before = (await count())?.n ?? 0;
			await db.batch(retireOrphans(db));
			console.log(`Entities: ${before} → ${(await count())?.n ?? 0} (leftovers with no link switched off)`);
		} else {
			console.log("Usage: graph-sync.ts status | export <out-dir> | import <file...> | tidy | categories-export <dir> | categories-import <file>  [--remote [--rest]]");
		}
	} finally {
		await proxy.dispose();
	}
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
