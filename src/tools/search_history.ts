import { z } from "zod";
import { SOURCES } from "../auth";
import { all, clip, ftsQuery, LIVE_FACT, now } from "../db";
import { searchByMeaning } from "../vectors/embed";
import { startBudget } from "./budget";
import { defineTool, ToolError } from "./types";

const NEIGHBOURS = 2;

type Filters = { source?: string; project_id?: string; from?: string; to?: string };

/** "chatgpt" also matches imported ChatGPT history ("import_chatgpt"). */
const sourcesFor = (s: string) => (s.startsWith("import_") ? [s, s] : [s, `import_${s}`]);

/** A bare date as `to` means "up to the end of that day". */
const endOf = (to: string) => (/^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to);

/** Build " AND …" clauses + params for the optional filters. `date` is the SQL date expression. */
function where(f: Filters, cols: { source: string; project: string; date: string }) {
	const sql: string[] = [];
	const params: unknown[] = [];
	if (f.source) {
		sql.push(`${cols.source} IN (?, ?)`);
		params.push(...sourcesFor(f.source));
	}
	if (f.project_id) {
		sql.push(`${cols.project} = ?`);
		params.push(f.project_id);
	}
	if (f.from) {
		sql.push(`${cols.date} >= ?`);
		params.push(f.from);
	}
	if (f.to) {
		sql.push(`${cols.date} <= ?`);
		params.push(endOf(f.to));
	}
	return { sql: sql.map((s) => ` AND ${s}`).join(""), params };
}

type MessageHit = {
	row_id: number;
	conversation_id: string;
	seq: number;
	snippet: string;
	title: string | null;
	source: string;
	date: string | null;
};

async function search(db: D1Database, match: string, f: Filters, limit: number) {
	const msgFilter = where(f, { source: "m.source", project: "c.project_id", date: "COALESCE(m.time, c.created)" });
	const docFilter = where(f, { source: "d.source", project: "d.project_id", date: "d.created" });
	const factFilter = where(f, { source: "f.source", project: "f.project_id", date: "f.created" });

	const [messageRows, documents, facts] = await Promise.all([
		// Over-fetch, then keep the best hit per conversation so results aren't all from one chat
		all<MessageHit>(
			db,
			`SELECT m.row_id, m.conversation_id, m.seq, snippet(messages_fts, 0, '«', '»', '…', 24) AS snippet,
			        c.title, COALESCE(c.source, m.source) AS source, COALESCE(m.time, c.created) AS date
			 FROM messages_fts
			 JOIN messages m ON m.row_id = messages_fts.rowid
			 LEFT JOIN conversations c ON c.id = m.conversation_id AND c.active = 1
			 WHERE messages_fts MATCH ? AND m.active = 1${msgFilter.sql}
			 ORDER BY bm25(messages_fts) LIMIT ?`,
			match,
			...msgFilter.params,
			limit * 4,
		),
		all<{ document_id: string; name: string; snippet: string; source: string; project_id: string | null; date: string }>(
			db,
			`SELECT d.doc_id AS document_id, d.name, snippet(documents_fts, 1, '«', '»', '…', 24) AS snippet,
			        d.source, d.project_id, d.created AS date
			 FROM documents_fts JOIN documents d ON d.row_id = documents_fts.rowid
			 WHERE documents_fts MATCH ? AND d.active = 1${docFilter.sql}
			 ORDER BY bm25(documents_fts) LIMIT ?`,
			match,
			...docFilter.params,
			limit,
		),
		all<{ id: number; fact: string; category: string; created: string }>(
			db,
			`SELECT f.row_id AS id, f.fact, f.category, f.created
			 FROM facts_fts JOIN facts f ON f.row_id = facts_fts.rowid
			 WHERE facts_fts MATCH ? AND ${LIVE_FACT}${factFilter.sql}
			 ORDER BY bm25(facts_fts) LIMIT ?`,
			match,
			now(),
			...factFilter.params,
			limit,
		),
	]);

	const seen = new Set<string>();
	const messages = messageRows.filter((m) => !seen.has(m.conversation_id) && seen.add(m.conversation_id)).slice(0, limit);
	return { messages, documents, facts };
}

/** Chats and documents close in meaning to the query (found even when the words differ). */
async function byMeaning(env: Env, query: string, f: Filters, limit: number) {
	const [chatHits, docHits] = await Promise.all([
		searchByMeaning(env, query, "conversation", limit * 3, undefined, { strict: true }),
		searchByMeaning(env, query, "document", limit * 2, undefined, { strict: true }),
	]);
	const pieces = (hits: { id: string; part: number }[], type: string) =>
		hits.length
			? all<{ item_id: string; part: number; seq_from: number | null; seq_to: number | null; char_from: number | null; char_to: number | null }>(
					env.DB,
					`SELECT item_id, part, seq_from, seq_to, char_from, char_to FROM embeddings
					 WHERE active = 1 AND item_type = ? AND (item_id || '|' || part) IN (SELECT value FROM json_each(?))`,
					type,
					JSON.stringify(hits.map((h) => `${h.id}|${h.part}`)),
				)
			: Promise.resolve([]);
	const [chatPieces, docPieces] = await Promise.all([pieces(chatHits, "conversation"), pieces(docHits, "document")]);

	// Chats: best piece per chat, respecting the same filters as keyword search
	const convFilter = where(f, { source: "c.source", project: "c.project_id", date: "c.created" });
	const chatIds = [...new Set(chatHits.map((h) => h.id))];
	const chats = chatIds.length
		? await all<{ id: string; title: string | null; source: string; date: string | null }>(
				env.DB,
				`SELECT c.id, c.title, c.source, c.created AS date FROM conversations c
				 WHERE c.active = 1 AND c.id IN (SELECT value FROM json_each(?))${convFilter.sql}`,
				JSON.stringify(chatIds),
				...convFilter.params,
			)
		: [];
	const messages = chatIds
		.flatMap((id) => {
			const c = chats.find((x) => x.id === id);
			const hit = chatHits.find((h) => h.id === id)!;
			const p = chatPieces.find((x) => x.item_id === id && x.part === hit.part);
			return c && p ? [{ ...c, seq_from: p.seq_from ?? 0, seq_to: p.seq_to ?? 0, score: hit.score }] : [];
		})
		.slice(0, limit);

	const docFilter = where(f, { source: "d.source", project: "d.project_id", date: "d.created" });
	const docIds = [...new Set(docHits.map((h) => h.id))];
	const docs = docIds.length
		? await all<{ document_id: string; name: string; content: string; source: string; project_id: string | null; date: string }>(
				env.DB,
				`SELECT d.doc_id AS document_id, d.name, d.content, d.source, d.project_id, d.created AS date FROM documents d
				 WHERE d.active = 1 AND d.doc_id IN (SELECT value FROM json_each(?))${docFilter.sql}`,
				JSON.stringify(docIds),
				...docFilter.params,
			)
		: [];
	const documents = docIds
		.flatMap((id) => {
			const d = docs.find((x) => x.document_id === id);
			const hit = docHits.find((h) => h.id === id)!;
			const p = docPieces.find((x) => x.item_id === id && x.part === hit.part);
			if (!d) return [];
			const { content, ...rest } = d;
			return [{ ...rest, snippet: clip(content.slice(p?.char_from ?? 0, p?.char_to ?? 300), 300), found_by: "meaning" }];
		})
		.slice(0, limit);
	return { messages, documents };
}

export const searchHistory = defineTool({
	name: "search_history",
	description:
		"Search the user's saved conversations (from every AI app, including imported ChatGPT/Claude/Gemini history), " +
		"documents and facts. Use it for questions like 'what did I ask ChatGPT about X?'. Finds matching words and " +
		"also chats/documents close in meaning (marked found_by: meaning), so a short description works too. " +
		"Each message hit includes the 2 messages before and after it.",
	inputSchema: {
		query: z.string().describe("Keywords to search for."),
		source: z.enum(SOURCES).optional().describe("Only this app, e.g. 'chatgpt' (includes imported ChatGPT history)."),
		project_id: z.string().optional().describe("Only this project."),
		from: z.string().optional().describe("ISO date, earliest."),
		to: z.string().optional().describe("ISO date, latest (inclusive)."),
		limit: z.number().int().min(1).max(20).optional().describe("Max results per kind. Default 5."),
	},
	async run(env, _source, { query, limit = 5, ...filters }) {
		// Try "all words" first for precision, then "any word" so something useful still comes back
		const strict = ftsQuery(query, "and");
		if (!strict) throw new ToolError("query has no searchable words.");
		// Keyword and meaning search run at once under the same time budget (see budget.ts)
		const { timed, done, skipped, failed } = startBudget("search_history");
		const none = { messages: [], documents: [], facts: [] } as Awaited<ReturnType<typeof search>>;
		const [keyword, meaning] = await Promise.all([
			timed(
				"keyword",
				(async () => {
					const all = await search(env.DB, strict, filters, limit);
					if (all.messages.length || all.documents.length || all.facts.length) return { found: all, matched: "all words" };
					return { found: await search(env.DB, ftsQuery(query, "or")!, filters, limit), matched: "any word" };
				})(),
				{ found: none, matched: "none (keyword search left out)" },
			),
			timed("meaning", byMeaning(env, query, filters, limit), { messages: [], documents: [] } as Awaited<ReturnType<typeof byMeaning>>),
		]);
		done();
		if (skipped.includes("keyword") && skipped.includes("meaning") && failed.length) throw failed[0]; // nothing works: say so
		const found = keyword.found;
		let matched = keyword.matched;
		// Add meaning matches for chats/documents the keyword search didn't find, up to the limit
		const haveChats = new Set(found.messages.map((m) => m.conversation_id));
		const extraChats = meaning.messages.filter((m) => !haveChats.has(m.id)).slice(0, Math.max(0, limit - found.messages.length));
		const haveDocs = new Set(found.documents.map((d) => d.document_id));
		const extraDocs = meaning.documents.filter((d) => !haveDocs.has(d.document_id)).slice(0, Math.max(0, limit - found.documents.length));
		if (extraChats.length || extraDocs.length) matched += " + meaning";
		const extraContexts = extraChats.length
			? await env.DB.batch<{ seq: number; role: string; time: string | null; text: string }>(
					extraChats.map((m) =>
						env.DB.prepare(
							"SELECT seq, role, time, text FROM messages WHERE conversation_id = ? AND active = 1 AND seq BETWEEN ? AND ? ORDER BY seq, row_id LIMIT 6",
						).bind(m.id, m.seq_from, m.seq_to),
					),
				)
			: [];

		// Fetch ±2 neighbouring messages for every hit in one round trip
		const contexts = found.messages.length
			? await env.DB.batch<{ seq: number; role: string; time: string | null; text: string }>(
					found.messages.map((m) =>
						env.DB.prepare(
							"SELECT seq, role, time, text FROM messages WHERE conversation_id = ? AND active = 1 AND seq BETWEEN ? AND ? ORDER BY seq, row_id",
						).bind(m.conversation_id, m.seq - NEIGHBOURS, m.seq + NEIGHBOURS),
					),
				)
			: [];

		return {
			matched,
			...(skipped.length ? { left_out: `${skipped.join(", ")} search (slow or unavailable this time; ask again if something seems missing)` } : {}),
			messages: [
				...found.messages.map((m, i) => ({
				conversation_id: m.conversation_id,
				title: m.title,
				source: m.source,
				date: m.date,
				snippet: m.snippet,
				context: contexts[i].results.map((c) => ({
					seq: c.seq,
					role: c.role,
					hit: c.seq === m.seq,
					text: clip(c.text, 500),
				})),
				found_by: "words",
			})),
				...extraChats.map((m, i) => ({
					conversation_id: m.id,
					title: m.title,
					source: m.source,
					date: m.date,
					snippet: clip(extraContexts[i].results.find((c) => c.role === "you")?.text ?? extraContexts[i].results[0]?.text ?? "", 200),
					context: extraContexts[i].results.map((c) => ({ seq: c.seq, role: c.role, hit: true, text: clip(c.text, 500) })),
					found_by: "meaning",
				})),
			],
			documents: [...found.documents.map((d) => ({ ...d, found_by: "words" })), ...extraDocs],
			facts: found.facts,
		};
	},
});
