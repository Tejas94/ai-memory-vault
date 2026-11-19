// Catch-up for the Node build's meaning search. New saves are embedded by the server as they arrive;
// this fills in items saved before an embedding model was set, or missed because a model call failed.
//
//   npm run reindex:node              embed whatever has no vectors yet
//   npm run reindex:node -- --redo    embed everything again (after changing AI_EMBED_MODEL)
//
// Uses the same settings as the server (VAULT_DB, AI_BASE_URL, AI_API_KEY, AI_EMBED_MODEL). It can run
// while the server is running. Prints counts only, never content.
import { pathToFileURL } from "node:url";
import type { AiSettings } from "../src/ai/openai";
import { ORIGIN_TYPES } from "../src/graph/schema";
import { embedMissing, pendingItems } from "../src/vectors/catchup";
import { loadSettingsFile, openVault } from "./server";

export async function reindex(opts: { dbPath?: string; ai?: AiSettings; redo?: boolean; log?: (line: string) => void }) {
	const started = new Date().toISOString();
	const vault = openVault({ dbPath: opts.dbPath, ai: opts.ai });
	try {
		if (!vault.vectors) throw new Error("Meaning search is off: set AI_BASE_URL and AI_EMBED_MODEL first.");
		const done = await embedMissing(vault.env, { redo: opts.redo, log: opts.log });
		const failed = await vault.db
			.prepare("SELECT count(*) AS n FROM graph_log WHERE step = 'embed' AND status = 'failed' AND created >= ?")
			.bind(started)
			.first<{ n: number }>();
		const left = (await Promise.all(ORIGIN_TYPES.map((t) => pendingItems(vault.env.DB, t)))).reduce((n, p) => n + p.todo.length, 0);
		return { embedded: done.reduce((n, d) => n + d.items, 0), failed: failed?.n ?? 0, left, vectors: vault.vectors.count() };
	} finally {
		vault.db.close();
		vault.vectors?.close();
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	loadSettingsFile();
	reindex({ dbPath: process.env.VAULT_DB, ai: process.env, redo: process.argv.includes("--redo"), log: console.log }).then(
		(r) => {
			console.log(`Embedded ${r.embedded} item(s); ${r.left} still without vectors; ${r.failed} failed call(s); index holds ${r.vectors} vector(s).`);
			if (r.failed) console.log("Failures are in the graph_log table (step 'embed'). Run again to retry.");
		},
		(e) => {
			console.error(e instanceof Error ? e.message : e);
			process.exit(1);
		},
	);
}
