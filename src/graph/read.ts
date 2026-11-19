// Reading the graph: find the entities a piece of text mentions, then follow their links.
import { nameKey, ROOT_ID } from "./schema";

// Words that never name an entity on their own
export const STOP = new Set(
	"a an the and or of to in on at for with about from by is are was be my me i our your his her their it this that what who where when how do does did".split(
		" ",
	),
);

const json = (v: unknown) => JSON.stringify(v);

/** Entity ids whose name or alias appears in `text` (1–3 word phrases). The owner is left out: it links to everything. */
export async function findMentioned(db: D1Database, text: string, limit = 8): Promise<string[]> {
	const words = nameKey(text).split(" ").filter(Boolean).slice(0, 40);
	const grams = new Set<string>();
	for (let n = 1; n <= 3; n++) {
		for (let i = 0; i + n <= words.length; i++) {
			const g = words.slice(i, i + n);
			if (g.every((w) => STOP.has(w))) continue;
			grams.add(g.join(" "));
		}
	}
	if (!grams.size) return [];
	const { results } = await db
		.prepare(
			`SELECT n.entity_id, max(length(n.name_key)) AS len FROM entity_names n
			 JOIN entities e ON e.id = n.entity_id AND e.active = 1
			 WHERE n.active = 1 AND n.name_key IN (SELECT value FROM json_each(?)) AND n.entity_id != ?
			 GROUP BY n.entity_id ORDER BY len DESC LIMIT ?`,
		)
		.bind(json([...grams]), ROOT_ID, limit)
		.all<{ entity_id: string }>();
	return results.map((r) => r.entity_id);
}

export type Link = {
	line: string; // "Priya → lives_in → Manchester"
	depth: number;
	origin_type: string;
	origin_id: string;
};
export type Walk = { entities: { id: string; name: string; type: string; summary: string | null }[]; links: Link[] };

type RelRow = { row_id: number; from_id: string; relation: string; to_id: string | null; value: string | null; origin_type: string; origin_id: string };

/** Follow links out from `start` for 1–2 steps. Never walks through the owner (a hub that links to everything). */
export async function walk(db: D1Database, start: string[], depth = 1, maxLinks = 40): Promise<Walk> {
	if (!start.length) return { entities: [], links: [] };
	const seen = new Set<number>();
	const rows: (RelRow & { depth: number })[] = [];
	const visited = new Set(start);
	let frontier = start;
	for (let d = 1; d <= Math.min(depth, 2) && frontier.length; d++) {
		const { results } = await db
			.prepare(
				`SELECT row_id, from_id, relation, to_id, value, origin_type, origin_id FROM relations
				 WHERE active = 1 AND (from_id IN (SELECT value FROM json_each(?1)) OR to_id IN (SELECT value FROM json_each(?1)))
				 ORDER BY origin_type = 'fact' DESC, created DESC LIMIT ?2`,
			)
			.bind(json(frontier), maxLinks * 3)
			.all<RelRow>();
		const next = new Set<string>();
		for (const r of results) {
			if (seen.has(r.row_id)) continue;
			seen.add(r.row_id);
			rows.push({ ...r, depth: d });
			for (const end of [r.from_id, r.to_id]) {
				if (end && end !== ROOT_ID && !visited.has(end)) next.add(end);
			}
		}
		for (const id of next) visited.add(id);
		frontier = [...next].slice(0, 20);
	}

	const ids = new Set<string>(start);
	for (const r of rows) {
		ids.add(r.from_id);
		if (r.to_id) ids.add(r.to_id);
	}
	const { results: ents } = await db
		.prepare("SELECT id, name, type, summary FROM entities WHERE active = 1 AND id IN (SELECT value FROM json_each(?))")
		.bind(json([...ids]))
		.all<{ id: string; name: string; type: string; summary: string | null }>();
	const nameOf = new Map(ents.map((e) => [e.id, e.name]));
	nameOf.set(ROOT_ID, "Me");

	const links = rows
		.filter((r) => nameOf.has(r.from_id) && (!r.to_id || nameOf.has(r.to_id)))
		.sort((a, b) => a.depth - b.depth)
		.slice(0, maxLinks)
		.map((r) => ({
			line: r.to_id
				? `${nameOf.get(r.from_id)} → ${r.relation}${r.value ? ` (${r.value})` : ""} → ${nameOf.get(r.to_id)}`
				: `${nameOf.get(r.from_id)} → ${r.relation} → ${r.value}`,
			depth: r.depth,
			origin_type: r.origin_type,
			origin_id: r.origin_id,
		}));
	return { entities: ents.filter((e) => start.includes(e.id)), links };
}

// Questions about the owner ("where do I live", "my job") name no entity: these words point to the
// owner's own links instead. Kept small and literal; meaning-based matching comes with vectors.
const OWNER_RELATIONS: [RegExp, string[]][] = [
	[/\b(live|lives|living|home|address|located|location|stay|staying)\b/, ["lives_in"]],
	[/\b(job|jobs|work|works|working|role|employer|company|career)\b/, ["works_at", "works_as", "worked_at"]],
	[/\b(grew up|hometown|childhood|born)\b/, ["grew_up_in"]],
	[/\b(family|relatives?|parents?)\b/, ["relative_of"]],
];
export const ownerRelations = (text: string) => {
	const t = nameKey(text);
	return [...new Set(OWNER_RELATIONS.flatMap(([re, rels]) => (re.test(t) ? rels : [])))];
};

/**
 * Fact ids behind the links of the given entities (and the owner's links named by `ownerRels`),
 * most-linked first. These are the facts the graph "found", returned alongside keyword matches.
 */
export async function factsLinkedTo(db: D1Database, entityIds: string[], ownerRels: string[], limit = 15): Promise<number[]> {
	if (!entityIds.length && !ownerRels.length) return [];
	const { results } = await db
		.prepare(
			`SELECT origin_id, count(*) AS n FROM relations
			 WHERE active = 1 AND origin_type = 'fact' AND (
			   from_id IN (SELECT value FROM json_each(?1)) OR to_id IN (SELECT value FROM json_each(?1))
			   OR (from_id = ?2 AND relation IN (SELECT value FROM json_each(?3))))
			 GROUP BY origin_id ORDER BY n DESC, max(created) DESC LIMIT ?4`,
		)
		.bind(json(entityIds), ROOT_ID, json(ownerRels), limit)
		.all<{ origin_id: string }>();
	return results.map((r) => Number(r.origin_id)).filter(Number.isFinite);
}

/** Things filed under any of these categories (is_a), so "car" reaches the Fiat Panda. */
export async function categoryMembers(db: D1Database, ids: string[], limit = 20): Promise<string[]> {
	const cats = ids.filter((id) => id.startsWith("topic:"));
	if (!cats.length) return [];
	const { results } = await db
		.prepare(
			`SELECT DISTINCT from_id FROM relations WHERE active = 1 AND relation = 'is_a' AND to_id IN (SELECT value FROM json_each(?)) LIMIT ?`,
		)
		.bind(json(cats), limit)
		.all<{ from_id: string }>();
	return results.map((r) => r.from_id);
}
