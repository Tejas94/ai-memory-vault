// One-time backfill (and catch-up) for meaning search. Run by the owner or a Claude Code session they started.
// New saves are embedded automatically by the Worker; this fills in items saved before that, or any the
// Worker missed (a failed model call is logged in graph_log with step 'embed').
//
//   npx tsx scripts/vector-sync.ts status        --remote --rest
//   npx tsx scripts/vector-sync.ts create-index  --remote --rest   (once: makes the Vectorize index)
//   npx tsx scripts/vector-sync.ts run           --remote --rest [--type fact] [--limit N] [--redo]
//   npx tsx scripts/vector-sync.ts tidy          --remote --rest   (remove vectors of items no longer current)
//   npx tsx scripts/vector-sync.ts query "<text>" --remote --rest [--type fact]
//
// It uses the same piece-splitting, model (Workers AI @cf/baai/bge-m3) and index as the live Worker,
// through Cloudflare's HTTP API, so backfilled and newly saved items are directly comparable.
// Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI + Vectorize + D1 edit).
import { ORIGIN_TYPES, type OriginType } from "../src/graph/schema";
import { embedMissing, pendingItems } from "../src/vectors/catchup";
import { DIMENSIONS, EMBED_MODEL, INDEX_NAME, retireItemVectors, searchByMeaning, setEmbedder, setVectorStore } from "../src/vectors/embed";
import { openEnv, restEmbedder, restVectorStore } from "./d1-rest";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(`--${name}`);
	if (i < 0) return undefined;
	const v = args[i + 1];
	args.splice(i, v && !v.startsWith("--") ? 2 : 1);
	return v && !v.startsWith("--") ? v : "true";
};
const remote = flag("remote") === "true";
const useRest = flag("rest") === "true";
const redo = flag("redo") === "true";
const onlyType = flag("type") as OriginType | undefined;
const limit = Number(flag("limit") ?? 1e9);
const [command, ...rest] = args;

async function main() {
	if (!useRest) throw new Error("Use --remote --rest (the Worker's own bindings embed new saves; this script is for the live index)");
	const store = restVectorStore(INDEX_NAME);
	setEmbedder(restEmbedder(EMBED_MODEL));
	setVectorStore(() => store);
	const proxy = await openEnv("scripts/remote.wrangler.jsonc", remote, useRest);
	const env = proxy.env;
	const db = env.DB;

	if (command === "status") {
		for (const type of ORIGIN_TYPES) {
			const { total, done } = await pendingItems(db, type);
			console.log(`${type.padEnd(13)} ${String(done).padStart(6)} / ${total} embedded`);
		}
		const counts = await db
			.prepare(
				`SELECT (SELECT count(*) FROM embeddings WHERE active = 1) AS vectors,
				        (SELECT count(*) FROM graph_log WHERE step IN ('embed','unembed') AND status = 'failed') AS failed,
				        (SELECT count(*) FROM graph_log WHERE step = 'embed' AND status = 'skipped') AS partly`,
			)
			.first();
		console.log(counts);
		console.log("index:", JSON.stringify((await store.info()) as object));
	} else if (command === "create-index") {
		console.log(await store.create(DIMENSIONS));
	} else if (command === "tidy") {
		// Vectors of items that were updated or forgotten while the Worker wasn't keeping the index in step
		const { results: stale } = await db
			.prepare(
				`SELECT DISTINCT e.item_type AS type, e.item_id AS id FROM embeddings e WHERE e.active = 1 AND NOT EXISTS (
				   SELECT 1 FROM facts WHERE e.item_type = 'fact' AND CAST(row_id AS TEXT) = e.item_id AND active = 1
				   UNION ALL SELECT 1 FROM conversations WHERE e.item_type = 'conversation' AND id = e.item_id AND active = 1
				   UNION ALL SELECT 1 FROM documents WHERE e.item_type = 'document' AND doc_id = e.item_id AND active = 1
				   UNION ALL SELECT 1 FROM projects WHERE e.item_type = 'project' AND id = e.item_id AND active = 1
				   UNION ALL SELECT 1 FROM profile WHERE e.item_type = 'profile' AND section = e.item_id AND active = 1)`,
			)
			.all<{ type: OriginType; id: string }>();
		for (const item of stale) await retireItemVectors(env, item);
		console.log(`Removed the vectors of ${stale.length} item(s) that are no longer current`);
	} else if (command === "run") {
		await embedMissing(env, { redo, type: onlyType, limit, log: console.log });
		const failed = await db
			.prepare("SELECT item_type, item_id, detail FROM graph_log WHERE step = 'embed' AND status = 'failed' ORDER BY row_id DESC LIMIT 5")
			.all();
		if (failed.results.length) console.log("Latest failures:", failed.results);
	} else if (command === "query") {
		const text = rest.join(" ");
		if (!text) throw new Error('query needs some text, e.g. query "car"');
		for (const m of await searchByMeaning(env, text, onlyType ?? "fact", 10, 0)) console.log(m.score.toFixed(3), m.type, m.id, m.part);
	} else {
		console.log("Usage: vector-sync.ts status | create-index | run | tidy | query <text>   --remote --rest [--type T] [--limit N] [--redo]");
	}
	await proxy.dispose();
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
