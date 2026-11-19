// Live check after a deploy: did every save, update and forget made through the real Vault (Claude or
// ChatGPT → /mcp) keep the knowledge graph and the meaning-search index in step, and how long did the
// background work take? Scoring is by ids and log lines only, so it needs no AI and costs nothing.
//
//   npx tsx evals/live-sync.ts <steps.json> --remote --rest [--label live-sync] [--phase "1. saves"] [--append <results.md>]
//   (--append adds this phase to an existing results file, so one test run with several phases is one file)
//
// <steps.json> lists the test items made through Vault, with what should now be true of each:
//   {"items":[{"label":"new fact","origin":{"type":"fact","id":"140"},"expect":"current","query":"cello","reply_ms":420},
//             {"label":"old version after update","origin":{"type":"fact","id":"140"},"expect":"gone"}]}
//   expect "current": saved, graph updated, embedded, and found by meaning with `query`
//   expect "gone"   : switched off, its links retired, its vectors out of the index
// Use made-up test items (and forget them at the end). Writes evals/results-YYYY-MM-DD-HHMM-<label>.md
// with numbers, ids and ✓/✗ only.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { openEnv, restEmbedder, restVectorStore } from "../scripts/d1-rest";
import type { Origin } from "../src/graph/schema";
import { EMBED_MODEL, INDEX_NAME, searchByMeaning, setEmbedder, setVectorStore } from "../src/vectors/embed";

const args = process.argv.slice(2);
const opt = (name: string) => {
	const i = args.indexOf(`--${name}`);
	if (i < 0) return undefined;
	const v = args[i + 1];
	args.splice(i, v && !v.startsWith("--") ? 2 : 1);
	return v && !v.startsWith("--") ? v : "true";
};
const remote = opt("remote") === "true";
const useRest = opt("rest") === "true";
const label = opt("label") ?? "live-sync";
const phase = opt("phase");
const appendTo = opt("append");
const stepsPath = args[0];

type Step = { label: string; origin: Origin; expect: "current" | "gone"; query?: string; reply_ms?: number };
const TABLE = {
	fact: ["facts", "CAST(row_id AS TEXT)"],
	conversation: ["conversations", "id"],
	document: ["documents", "doc_id"],
	project: ["projects", "id"],
	profile: ["profile", "section"],
} as const;

const secs = (from?: string | null, to?: string | null) =>
	from && to ? `${((Date.parse(to) - Date.parse(from)) / 1000).toFixed(1)} s` : "–";
const mark = (ok: boolean) => (ok ? "✓" : "✗");

async function main() {
	if (!stepsPath || !useRest) throw new Error("Usage: live-sync.ts <steps.json> --remote --rest [--label name]");
	const { items } = JSON.parse(readFileSync(stepsPath, "utf8")) as { items: Step[] };
	setEmbedder(restEmbedder(EMBED_MODEL));
	const store = restVectorStore(INDEX_NAME);
	setVectorStore(() => store);
	const proxy = await openEnv("scripts/remote.wrangler.jsonc", remote, useRest);
	const env = proxy.env;
	const db = env.DB;

	const rows: string[] = [];
	let passed = 0;
	for (const s of items) {
		const [table, key] = TABLE[s.origin.type];
		const item = await db
			.prepare(`SELECT max(active) AS active, max(saved) AS saved FROM (SELECT active, ${s.origin.type === "conversation" ? "saved" : "created"} AS saved FROM ${table} WHERE ${key} = ?)`)
			.bind(s.origin.id)
			.first<{ active: number | null; saved: string | null }>();
		const log = (step: string) =>
			db
				.prepare("SELECT status, created FROM graph_log WHERE item_type = ? AND item_id = ? AND step = ? ORDER BY row_id DESC LIMIT 1")
				.bind(s.origin.type, s.origin.id, step)
				.first<{ status: string; created: string }>();
		const [write, embed] = await Promise.all([log("write"), log("embed")]);
		const links = await db
			.prepare("SELECT count(*) AS n FROM relations WHERE active = 1 AND origin_type = ? AND origin_id = ?")
			.bind(s.origin.type, s.origin.id)
			.first<{ n: number }>();
		const vectors = await db
			.prepare("SELECT count(*) AS n FROM embeddings WHERE active = 1 AND item_type = ? AND item_id = ?")
			.bind(s.origin.type, s.origin.id)
			.first<{ n: number }>();
		const found = s.query
			? (await searchByMeaning(env, s.query, s.origin.type, 10)).some((m) => m.id === s.origin.id)
			: undefined;

		const checks =
			s.expect === "current"
				? {
						saved: item?.active === 1,
						graph: !!write && ["ok", "review"].includes(write.status),
						embedded: embed?.status === "ok" && (vectors?.n ?? 0) > 0,
						found: found ?? true,
					}
				: { saved: item?.active === 0, graph: (links?.n ?? 0) === 0, embedded: (vectors?.n ?? 0) === 0, found: found === undefined ? true : !found };
		const ok = Object.values(checks).every(Boolean);
		if (ok) passed++;
		rows.push(
			`| ${s.label} | ${s.origin.type} ${s.origin.id} | ${s.expect} | ${mark(checks.saved)} | ${mark(checks.graph)} (${links?.n ?? 0} links) | ${mark(checks.embedded)} (${vectors?.n ?? 0}) | ${s.query ? mark(checks.found) : "–"} | ${s.reply_ms ?? "–"} | ${s.expect === "current" ? secs(item?.saved, write?.created) : "–"} | ${s.expect === "current" ? secs(item?.saved, embed?.created) : "–"} | ${mark(ok)} |`,
		);
	}
	await proxy.dispose();

	const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
	const out = appendTo ?? `evals/results-${stamp}-${label}.md`;
	const section = `${phase ? `## ${phase}\n\nChecked: ${new Date().toISOString()}\n\n` : ""}Passed: **${passed} / ${items.length}**

| Step | Item | Expect | Saved | Graph | Vectors | Found | Reply ms | Graph after | Embed after | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}
`;
	const text = appendTo
		? `\n${section}`
		: `# Vault live sync check: ${label}

Run: ${new Date().toISOString()}

For "current" items: saved and switched on, graph updated (log line \`write\`), embedded (log line
\`embed\`, vectors tracked), and found by meaning search. For "gone" items: switched off, no current
links, no vectors left, and not found by meaning search. Reply = time until the app had "Saved ✓";
graph / embed = time from the save until that background job finished.

${section}`;
	if (appendTo) appendFileSync(out, text);
	else writeFileSync(out, text);
	console.log(text);
	console.log(`Wrote ${out}`);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
