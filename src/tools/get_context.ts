import { z } from "zod";
import { all, ftsQuery, LIVE_FACT, now } from "../db";
import { categoryMembers, factsLinkedTo, findMentioned, ownerRelations, STOP, walk } from "../graph/read";
import { nameKey } from "../graph/schema";
import { MIN_SCORE, searchByMeaning } from "../vectors/embed";
import { linkLine } from "./explore";
import { startBudget } from "./budget";
import { defineTool } from "./types";

export { setBudget } from "./budget";

const MAX_FACTS = 15;
const MAX_CONNECTIONS = 8;
const DEFAULT_TOKENS = 600; // budget for facts + connections; ~4 characters per token
const RRF_K = 60; // Reciprocal Rank Fusion constant

/**
 * Cut-off for meaning matches when the topic is one or two words. Tried 0.50–0.60 on the exam (4 Nov
 * 2026): every stricter value lost answers (89% → 65–74%), because short questions like "car" or
 * "pay" are answered mainly by meaning. So it equals the normal cut-off (MIN_SCORE); kept as a knob.
 */
export let SHORT_MIN_SCORE = 0.45;
export const setShortMinScore = (s: number) => (SHORT_MIN_SCORE = s);

export const REMINDER = "If the user shares anything new or changed, save it to Vault (use `replaces` for changes).";

type Fact = { id: number; fact: string; date: string };
type Context = {
	profile: Record<string, string>;
	facts: Fact[];
	connections?: string[];
	projects: { id: string; name: string; status: string }[];
	skipped?: string[];
	reminder: string;
};

const FACT_COLS = "f.row_id AS id, f.fact, substr(f.created, 1, 10) AS date";

/** Rows for these fact ids, kept in the given order (current facts only). */
async function factsById(db: D1Database, ids: number[], ts: string) {
	if (!ids.length) return [];
	const rows = await all<Fact>(
		db,
		`SELECT ${FACT_COLS} FROM facts f WHERE f.row_id IN (SELECT value FROM json_each(?)) AND ${LIVE_FACT}`,
		JSON.stringify(ids),
		ts,
	);
	return ids.flatMap((id) => rows.filter((r) => r.id === id));
}

/** The reply as Markdown key-value lines: short, and read the same way by every AI app. */
export function formatContext(c: Context): string {
	const out: string[] = [];
	const profile = Object.entries(c.profile);
	if (profile.length) out.push("## Profile", ...profile.map(([k, v]) => `- ${k}: ${v}`), "");
	out.push("## Facts");
	out.push(...(c.facts.length ? c.facts.map((f) => `- id: ${f.id} · date: ${f.date} · fact: ${f.fact}`) : ["- none found"]));
	if (c.connections?.length) out.push("", "## Connections", ...c.connections.map((l) => `- ${l}`));
	if (c.projects.length) out.push("", "## Projects", ...c.projects.map((p) => `- ${p.name} · id: ${p.id} · status: ${p.status}`));
	if (c.skipped?.length) out.push("", `Note: left out because it was slow or unavailable this time: ${c.skipped.join(", ")} search. Ask again if something seems missing.`);
	out.push("", c.reminder);
	return out.join("\n");
}

export const getContext = defineTool({
	name: "get_context",
	description:
		"Who the user is and what matters now: their profile, the most relevant current facts (with ids), connections from " +
		"Vault's knowledge graph, and their active projects. Call this before answering anything personal or about their " +
		"work, plans, projects or past conversations. Pass a `topic` of a few descriptive words, as specific as the " +
		"conversation allows (e.g. 'my car plans and budget', not just 'car'), and/or a `project_id`; without either " +
		"you get the newest facts.",
	inputSchema: {
		topic: z.string().optional().describe("A few words on what the conversation is about, e.g. 'renting a car in Italy' or 'my sister's wedding'."),
		project_id: z.string().optional().describe("Project slug to focus on."),
		max_tokens: z.number().int().min(100).max(4000).optional().describe("Size budget for facts + connections. Default 600."),
	},
	format: formatContext,
	async run(env, _source, { topic, project_id, max_tokens = DEFAULT_TOKENS }): Promise<Context> {
		const ts = now();
		const db = env.DB;
		const focused = !!(topic || project_id);
		const { timed, done, skipped, failed } = startBudget("get_context");

		// Short topics: meaning search only counts strong matches (keyword and graph do the rest)
		const words = topic ? nameKey(topic).split(" ").filter((w) => w && !STOP.has(w)) : [];
		const minScore = words.length <= 2 ? Math.max(SHORT_MIN_SCORE, MIN_SCORE) : MIN_SCORE;

		// All searches at once, each with the same deadline: keyword, meaning, graph, project
		const match = topic ? ftsQuery(topic, "or") : null;
		const [keyword, meaningFacts, graph, project, profile, projects, newest] = await Promise.all([
			timed(
				"keyword",
				match
					? all<Fact>(
							db,
							`SELECT ${FACT_COLS} FROM facts_fts JOIN facts f ON f.row_id = facts_fts.rowid
							 WHERE facts_fts MATCH ? AND ${LIVE_FACT} ORDER BY bm25(facts_fts) LIMIT ?`,
							match,
							ts,
							MAX_FACTS,
						)
					: Promise.resolve([]),
				[] as Fact[],
			),
			timed(
				"meaning",
				topic
					? searchByMeaning(env, topic, "fact", MAX_FACTS, minScore, { strict: true }).then((m) => factsById(db, m.map((x) => Number(x.id)), ts))
					: Promise.resolve([]),
				[] as Fact[],
			),
			timed(
				"graph",
				topic
					? (async () => {
							const named = await findMentioned(db, topic);
							// a category named in the topic ("car") brings in everything filed under it (the Fiat Panda)
							const ids = [...named, ...(await categoryMembers(db, named))];
							const [w, linked] = await Promise.all([
								walk(db, named, 2, MAX_CONNECTIONS * 3),
								factsLinkedTo(db, ids, ownerRelations(topic), MAX_FACTS),
							]);
							// facts linked directly to what the topic names first, then facts behind the walked links
							const factIds = [...new Set([...linked, ...w.links.filter((l) => l.origin_type === "fact").map((l) => Number(l.origin_id))])];
							return { links: w.links, facts: await factsById(db, factIds, ts) };
						})()
					: Promise.resolve(null),
				null,
			),
			timed(
				"project",
				project_id
					? all<Fact>(db, `SELECT ${FACT_COLS} FROM facts f WHERE f.project_id = ? AND ${LIVE_FACT} ORDER BY f.created DESC LIMIT ?`, project_id, ts, MAX_FACTS)
					: Promise.resolve([]),
				[] as Fact[],
			),
			timed("profile", all<{ section: string; content: string }>(db, "SELECT section, content FROM profile WHERE active = 1 ORDER BY section"), []),
			timed(
				"projects",
				all<{ id: string; name: string; status: string }>(db, "SELECT id, name, status FROM projects WHERE active = 1 AND status != 'done' ORDER BY created DESC"),
				[],
			),
			// No topic: the newest facts
			timed(
				"newest",
				focused ? Promise.resolve([]) : all<Fact>(db, `SELECT ${FACT_COLS} FROM facts f WHERE ${LIVE_FACT} ORDER BY f.created DESC LIMIT ?`, ts, MAX_FACTS),
				[] as Fact[],
			),
		]);
		done();
		// If even the plain profile and project reads failed, the database itself is down: say so
		if (failed.length && skipped.includes("profile") && skipped.includes("projects")) throw failed[0];

		// Merge with Reciprocal Rank Fusion: found by several searches, or near the top of one, ranks higher
		const score = new Map<number, { row: Fact; score: number }>();
		for (const list of [keyword, meaningFacts, graph?.facts ?? [], project, newest]) {
			list.forEach((row, rank) => {
				const s = score.get(row.id) ?? { row, score: 0 };
				s.score += 1 / (RRF_K + rank + 1);
				score.set(row.id, s);
			});
		}
		// No duplicates: the same text saved twice appears once
		const seenText = new Set<string>();
		let facts = [...score.values()]
			.sort((a, b) => b.score - a.score)
			.map((s) => s.row)
			.filter((f) => {
				const k = nameKey(f.fact);
				if (seenText.has(k)) return false;
				seenText.add(k);
				return true;
			})
			.slice(0, MAX_FACTS);

		// Connections only when they add something: not the category links, not a fact already listed
		const connectionsFor = (shown: Fact[]) => {
			const shownIds = new Set(shown.map((f) => String(f.id)));
			const seen = new Set<string>();
			return (graph?.links ?? [])
				.filter((l) => !/ → is_a → /.test(l.line) && !(l.origin_type === "fact" && shownIds.has(l.origin_id)))
				.map(linkLine)
				.filter((line) => !seen.has(line) && !!seen.add(line))
				.slice(0, MAX_CONNECTIONS);
		};
		let connections = connectionsFor(facts);

		// Size budget: drop the lowest-ranked lines until facts + connections fit
		const budget = max_tokens * 4;
		const size = () => facts.reduce((n, f) => n + f.fact.length + 30, 0) + connections.reduce((n, l) => n + l.length + 3, 0);
		while (size() > budget && (facts.length > 1 || connections.length > 0)) {
			if (connections.length && connections.length >= facts.length / 2) connections = connections.slice(0, -1);
			else facts = facts.slice(0, -1);
		}

		return {
			profile: Object.fromEntries(profile.map((p) => [p.section, p.content])),
			facts,
			...(connections.length ? { connections } : {}),
			projects,
			...(skipped.length ? { skipped } : {}),
			reminder: REMINDER,
		};
	},
});
