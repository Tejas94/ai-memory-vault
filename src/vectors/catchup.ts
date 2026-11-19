// Catch-up for meaning search: embeds current items that have no vectors yet (saved before meaning
// search was switched on, or missed because a model call failed), or all of them after a model
// change. Shared by scripts/vector-sync.ts (Cloudflare) and node/reindex.ts (Node build), so both
// produce exactly the text pieces the live save tools do.
import { ORIGIN_TYPES, type OriginType } from "../graph/schema";
import { embedItem, type Piece, piecesForChat, piecesForText } from "./embed";

const PARALLEL = 4; // items embedded at once

// Each item kind: how to list current items, and the same text the live save tools embed
const SOURCES: Record<OriginType, { list: string; head: (r: any) => string; body: (r: any) => string }> = {
	fact: { list: "SELECT CAST(row_id AS TEXT) AS id, fact FROM facts WHERE active = 1", head: (r) => r.fact, body: () => "" },
	profile: {
		list: "SELECT section AS id, content FROM profile WHERE active = 1",
		head: (r) => `Owner's profile, ${r.id}: ${r.content}`.split("\n")[0],
		body: (r) => `Owner's profile, ${r.id}: ${r.content}`.split("\n").slice(1).join("\n"),
	},
	project: {
		list: "SELECT id, name, description, status FROM projects WHERE active = 1",
		head: (r) => `Project "${r.name}" (id ${r.id}, status ${r.status}): ${r.description ?? ""}`.split("\n")[0],
		body: (r) => `Project "${r.name}" (id ${r.id}, status ${r.status}): ${r.description ?? ""}`.split("\n").slice(1).join("\n"),
	},
	document: {
		list: "SELECT doc_id AS id, name, content FROM documents WHERE active = 1",
		head: (r) => `Document: ${r.name}`,
		body: (r) => r.content,
	},
	conversation: { list: "SELECT id, title FROM conversations WHERE active = 1", head: () => "", body: () => "" },
};

/** For one item kind: how many current items there are, how many have vectors, and which still need them. */
export async function pendingItems(db: D1Database, type: OriginType, redo = false) {
	const { results: items } = await db.prepare(SOURCES[type].list).all<any>();
	const { results: done } = await db
		.prepare("SELECT DISTINCT item_id FROM embeddings WHERE active = 1 AND item_type = ?")
		.bind(type)
		.all<{ item_id: string }>();
	const doneIds = new Set(done.map((d) => d.item_id));
	return { total: items.length, done: items.filter((i) => doneIds.has(String(i.id))).length, todo: redo ? items : items.filter((i) => !doneIds.has(String(i.id))) };
}

async function piecesFor(db: D1Database, type: OriginType, row: any): Promise<Piece[]> {
	if (type !== "conversation") return piecesForText(SOURCES[type].head(row), SOURCES[type].body(row));
	const { results } = await db
		.prepare("SELECT seq, role, text FROM messages WHERE conversation_id = ? AND active = 1 ORDER BY seq, row_id")
		.bind(row.id)
		.all<{ seq: number; role: string; text: string }>();
	return piecesForChat(row.title || "Untitled chat", results);
}

/**
 * Embed what is missing (`redo`: everything). Each item logs ok / skipped / failed itself, as a live
 * save does. Returns per-kind counts; `log` gets progress lines (counts only, never content).
 */
export async function embedMissing(
	env: Env,
	opts: { redo?: boolean; type?: OriginType; limit?: number; log?: (line: string) => void } = {},
) {
	const out: { type: OriginType; items: number; pieces: number }[] = [];
	for (const type of opts.type ? [opts.type] : ORIGIN_TYPES) {
		const todo = (await pendingItems(env.DB, type, opts.redo)).todo.slice(0, opts.limit ?? 1e9);
		let items = 0;
		let pieces = 0;
		const queue = [...todo];
		await Promise.all(
			Array.from({ length: PARALLEL }, async () => {
				for (let row = queue.shift(); row; row = queue.shift()) {
					const p = await piecesFor(env.DB, type, row);
					await embedItem(env, { type, id: String(row.id) }, p);
					items++;
					pieces += Math.min(p.length, 40);
					if (items % 25 === 0) opts.log?.(`  ${type}: ${items} / ${todo.length}`);
				}
			}),
		);
		opts.log?.(`${type}: ${items} item(s), ~${pieces} piece(s) sent`);
		out.push({ type, items, pieces });
	}
	return out;
}
