// Embeddings ("meaning search"). Every save, update and forget keeps Vectorize in step, in the
// background, using Cloudflare's own model (Workers AI, free tier). The same model embeds stored items
// and questions, so they are always comparable; the one-time backfill (scripts/vector-sync.ts) calls
// the very same code and model through Cloudflare's HTTP API.
//
// Vectorize holds only numbers plus {type, id, part}; the text stays in D1. The `embeddings` table
// says which vectors belong to which item, so updates/forgets remove the right ones and the index can
// be rebuilt from D1 at any time.
import { now } from "../db";
import type { Origin, OriginType } from "../graph/schema";
import { logStatement } from "../graph/write";

export const EMBED_MODEL = "@cf/baai/bge-m3"; // multilingual, 1024 dimensions, cheapest on Workers AI
export const DIMENSIONS = 1024;
export const INDEX_NAME = "vault-embeddings";

const PIECE_CHARS = 1_500; // characters per piece
const OVERLAP = 200; // documents: pieces overlap a little so a sentence isn't cut in two
const AI_LINE = 200; // chats: the AI's replies are shortened; the owner's words are kept whole
const MAX_PIECES = 40; // per save; anything beyond is logged as not embedded
const BATCH = 20; // texts per model call

export type Piece = { text: string; seq_from?: number; seq_to?: number; char_from?: number; char_to?: number };
type Match = { type: OriginType; id: string; part: number; score: number };

// ---- Swappable model and store (tests use fakes; production uses the AI and VECTORS bindings) ----

export type Embedder = (env: Env, texts: string[]) => Promise<number[][]>;
export type VectorStore = {
	upsert(v: { id: string; values: number[]; namespace: string; metadata: Record<string, string | number> }[]): Promise<unknown>;
	deleteByIds(ids: string[]): Promise<unknown>;
	query(values: number[], opts: { topK: number; namespace: string }): Promise<{ id: string; score: number; metadata?: Record<string, unknown> }[]>;
};

const aiEmbed: Embedder = async (env, texts) => {
	if (!env.AI) throw new Error("no AI binding");
	const out = (await env.AI.run(EMBED_MODEL as any, { text: texts } as any)) as { data?: number[][] };
	if (!out?.data || out.data.length !== texts.length) throw new Error("embedding model returned no vectors");
	return out.data;
};
const bindingStore = (env: Env): VectorStore => {
	const index = env.VECTORS;
	if (!index) throw new Error("no VECTORS binding");
	return {
		upsert: (v) => index.upsert(v),
		deleteByIds: (ids) => index.deleteByIds(ids),
		query: async (values, opts) => (await index.query(values, { ...opts, returnMetadata: "all" })).matches,
	};
};

let embedder: Embedder = aiEmbed;
let embedModel: string = EMBED_MODEL; // recorded with every stored vector
let storeFor: (env: Env) => VectorStore = bindingStore;
/** Tests, the backfill script and other AI providers (src/ai/openai.ts) swap these in. */
export const setEmbedder = (fn: Embedder, model: string = EMBED_MODEL) => {
	embedder = fn;
	embedModel = model;
};
export const setVectorStore = (fn: (env: Env) => VectorStore) => (storeFor = fn);
export const resetVectors = () => {
	embedder = aiEmbed;
	embedModel = EMBED_MODEL;
	storeFor = bindingStore;
	enabled = true;
};

// A setup with no embedding model or index (e.g. the Node server before one is configured) switches
// meaning search off: nothing is embedded, nothing is logged as failed, and searches go by keyword.
let enabled = true;
export const setVectorsEnabled = (on: boolean) => (enabled = on);

// ---- Turning items into pieces ----

/** Cutting text can split an emoji in half; the model rejects such broken characters, so drop them. */
const whole = (s: string) => s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

/** Plain text (fact, project, profile, document) → pieces of ~1,500 characters with a little overlap. */
export function piecesForText(head: string, text: string): Piece[] {
	const body = text.trim();
	if (body.length + head.length + 1 <= PIECE_CHARS) return [{ text: `${head}\n${body}`.trim(), char_from: 0, char_to: body.length }];
	const pieces: Piece[] = [];
	const size = PIECE_CHARS - head.length - 1;
	let start = 0;
	while (start < body.length) {
		let end = Math.min(body.length, start + size);
		if (end < body.length) {
			const space = body.lastIndexOf(" ", end);
			if (space > start + size / 2) end = space; // end on a word
		}
		pieces.push({ text: whole(`${head}\n${body.slice(start, end)}`), char_from: start, char_to: end });
		if (end >= body.length) break;
		start = Math.max(end - OVERLAP, start + 1); // the next piece repeats the last ~200 characters
	}
	return pieces;
}

/** A chat → pieces of whole messages. The owner's words are kept whole; the AI's are shortened. */
export function piecesForChat(title: string, messages: { seq: number; role: string; text: string }[]): Piece[] {
	const head = `Chat: ${title}`;
	const pieces: Piece[] = [];
	let cur: Piece | null = null;
	for (const m of messages) {
		const owner = m.role === "you" || m.role === "user";
		const t = m.text.replace(/\s+/g, " ").trim();
		const line = owner ? `Owner: ${t}` : `AI: ${t.length > AI_LINE ? `${t.slice(0, AI_LINE)} …` : t}`;
		for (let i = 0; i < line.length; i += PIECE_CHARS - head.length - 1) {
			const part = line.slice(i, i + PIECE_CHARS - head.length - 1);
			if (!cur || cur.text.length + part.length + 1 > PIECE_CHARS) {
				if (cur) pieces.push(cur);
				cur = { text: head, seq_from: m.seq, seq_to: m.seq };
			}
			cur.text += `\n${part}`;
			cur.seq_to = m.seq;
		}
	}
	if (cur) pieces.push(cur);
	for (const p of pieces) p.text = whole(p.text);
	return pieces;
}

// ---- Keeping the index in step ----

async function vectorId(type: OriginType, id: string, part: number) {
	const bytes = new TextEncoder().encode(`${type}|${id}|${part}`);
	const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${type[0]}:${hash.slice(0, 40)}`; // e.g. "f:3a9c…", 42 bytes
}

/**
 * Embed one item's pieces and store them. Without `append`, the item's previous vectors are replaced
 * (new version of a fact, document, project, profile section). With `append` (new messages added to
 * a saved chat), the new pieces are added after the existing ones. Never throws: failures are logged.
 */
export async function embedItem(env: Env, origin: Origin, pieces: Piece[], opts: { append?: boolean } = {}) {
	if (!enabled || !pieces.length) return;
	try {
		const db = env.DB;
		const store = storeFor(env);
		let start = 0;
		if (opts.append) {
			const last = await db
				.prepare("SELECT max(part) AS p FROM embeddings WHERE active = 1 AND item_type = ? AND item_id = ?")
				.bind(origin.type, origin.id)
				.first<{ p: number | null }>();
			start = (last?.p ?? -1) + 1;
		} else {
			await retireItemVectors(env, origin);
		}
		const todo = pieces.slice(0, MAX_PIECES);
		const vectors: number[][] = [];
		for (let i = 0; i < todo.length; i += BATCH) vectors.push(...(await embedder(env, todo.slice(i, i + BATCH).map((p) => p.text))));
		const ids = await Promise.all(todo.map((_, i) => vectorId(origin.type, origin.id, start + i)));
		await store.upsert(
			todo.map((_, i) => ({
				id: ids[i],
				values: vectors[i],
				namespace: origin.type,
				metadata: { type: origin.type, id: origin.id, part: start + i },
			})),
		);
		const ts = now();
		const rows = todo.map((p, i) => ({
			item_id: origin.id,
			part: start + i,
			vector_id: ids[i],
			seq_from: p.seq_from ?? null,
			seq_to: p.seq_to ?? null,
			char_from: p.char_from ?? null,
			char_to: p.char_to ?? null,
		}));
		const statements = [
			// a re-run of the same piece replaces its tracking row (Vectorize upsert replaced the vector)
			db
				.prepare("UPDATE embeddings SET active = 0, deactivated = ? WHERE active = 1 AND vector_id IN (SELECT value FROM json_each(?))")
				.bind(ts, JSON.stringify(ids)),
			db
				.prepare(
					`INSERT INTO embeddings (item_type, item_id, part, vector_id, seq_from, seq_to, char_from, char_to, model, created)
					 SELECT ?, json_extract(value,'$.item_id'), json_extract(value,'$.part'), json_extract(value,'$.vector_id'),
					        json_extract(value,'$.seq_from'), json_extract(value,'$.seq_to'), json_extract(value,'$.char_from'),
					        json_extract(value,'$.char_to'), ?, ? FROM json_each(?)`,
				)
				.bind(origin.type, embedModel, ts, JSON.stringify(rows)),
			logStatement(db, origin, "embed", pieces.length > todo.length ? "skipped" : "ok",
				pieces.length > todo.length ? `embedded ${todo.length} of ${pieces.length} pieces` : `${todo.length} piece(s)`),
		];
		await db.batch(statements);
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		console.error(`Embedding failed for ${origin.type} ${origin.id}:`, reason);
		await logStatement(env.DB, origin, "embed", "failed", reason)
			.run()
			.catch(() => {});
	}
}

/** Take an item's vectors out of the index (forget, or a fact replaced by a new one). Never throws. */
export async function retireItemVectors(env: Env, origin: Origin) {
	if (!enabled) return;
	try {
		const { results } = await env.DB.prepare("SELECT vector_id FROM embeddings WHERE active = 1 AND item_type = ? AND item_id = ?")
			.bind(origin.type, origin.id)
			.all<{ vector_id: string }>();
		if (!results.length) return;
		const ids = results.map((r) => r.vector_id);
		await storeFor(env).deleteByIds(ids);
		await env.DB.prepare(
			"UPDATE embeddings SET active = 0, deactivated = ? WHERE active = 1 AND vector_id IN (SELECT value FROM json_each(?))",
		)
			.bind(now(), JSON.stringify(ids))
			.run();
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		console.error(`Removing vectors failed for ${origin.type} ${origin.id}:`, reason);
		await logStatement(env.DB, origin, "unembed", "failed", reason)
			.run()
			.catch(() => {});
	}
}

/**
 * Items whose meaning is closest to `text`, best first. Matches below `minScore` are dropped.
 * Returns [] (never throws) if the model or index is unavailable, so searches still work by keyword.
 */
export async function searchByMeaning(
	env: Env,
	text: string,
	type: OriginType,
	topK = 10,
	minScore = MIN_SCORE,
	opts: { strict?: boolean } = {}, // strict: report a failure to the caller instead of returning []
): Promise<Match[]> {
	if (!enabled) return [];
	try {
		const [values] = await embedder(env, [text]);
		const matches = await storeFor(env).query(values, { topK, namespace: type });
		return matches
			.filter((m) => m.score >= minScore && m.metadata)
			.map((m) => ({ type, id: String(m.metadata!.id), part: Number(m.metadata!.part ?? 0), score: m.score }));
	} catch (e) {
		if (opts.strict) throw e;
		console.error("Meaning search unavailable:", e instanceof Error ? e.message : String(e));
		return [];
	}
}
/** Cosine similarity below this is treated as unrelated (tuned with the eval). */
export let MIN_SCORE = 0.45;
export const setMinScore = (s: number) => (MIN_SCORE = s);
