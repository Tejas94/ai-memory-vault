// The graph writer: the one place that turns "entities + relations" into rows. The auto-update
// (after every save) and the one-time backfill both go through here, so the rules are identical:
//   - names and aliases are matched before an entity is created (never merged silently)
//   - an identical current link is not added twice (safe to run again)
//   - a "single" relation's new value retires the old one, with replaces_id pointing at it, unless
//     the current value is newer (by the date of the item it came from) or came from a fact and the
//     new one doesn't: then the new value is stored as history (inactive) and the current one stays
//   - entities left with no current links are retired, with their names (never the owner)
//   - nothing is deleted or edited: rows are retired (active = 0) and new rows inserted
// Lists travel as one JSON parameter (json_each), so any size stays within D1's 100-parameter
// limit and each write is a handful of statements.
import { now } from "../db";
import {
	categoryEntity,
	categoryOf,
	entityId,
	GraphInput,
	nameKey,
	type Origin,
	type Relation,
	RELATIONS,
	ROOT_ID,
	type EntityType,
} from "./schema";

const ROOT_KEYS = new Set(["me", "i", "myself", "user", "owner"]);

export type WriteResult = {
	entities_created: number;
	names_added: number;
	relations_added: number;
	relations_retired: number;
	kept_as_history: number; // single-value links that lost to a newer or fact-based current value
	skipped_relations: number;
	review: string[]; // short notes for a later review session (no personal content beyond names)
};

type NameRow = { entity_id: string; name_key: string; type: EntityType };
type RelRow = {
	row_id: number;
	from_id: string;
	relation: string;
	to_id: string | null;
	value: string | null;
	origin_type: string;
	origin_id: string;
	valid_from: string | null;
	created: string;
};

const json = (v: unknown) => JSON.stringify(v);
const valueKey = (v: string | null | undefined) => (v ? nameKey(v) : "");
/** "2026-03-04…", "2026-03" or "2026" → comparable string; anything else (e.g. "last spring") → null. */
const isoDate = (v: string | null | undefined) => (v && /^\d{4}(-\d{2}){0,2}/.test(v) ? v.slice(0, 10) : null);

export async function writeGraph(
	db: D1Database,
	raw: unknown,
	origin: Origin,
	opts: { source: string; replaceOrigin?: boolean; asOf?: string },
): Promise<WriteResult> {
	const input = GraphInput.parse(raw);
	const ts = now();
	// When the information is from: the item's own date (a chat's last message, a fact's save time)
	const asOf = isoDate(opts.asOf) ?? ts.slice(0, 10);
	const result: WriteResult = {
		entities_created: 0,
		names_added: 0,
		relations_added: 0,
		relations_retired: 0,
		kept_as_history: 0,
		skipped_relations: 0,
		review: [],
	};

	// 0. Categories: an is_a link must point at a category on the fixed list; the category entity is
	//    declared here so it is created once and shared by everything filed under it
	const categories = new Set<string>();
	input.relations = input.relations.filter((r) => {
		if (r.relation.toLowerCase().replace(/[\s-]+/g, "_") !== "is_a") return true;
		const c = r.to ? categoryOf(r.to) : null;
		if (!c) {
			result.skipped_relations++;
			result.review.push(`category "${r.to ?? r.value}" is not on the list; skipped`);
			return false;
		}
		r.relation = "is_a";
		r.to = categoryEntity(c).name;
		r.value = undefined;
		categories.add(c);
		return true;
	});
	for (const c of categories) input.entities.push(categoryEntity(c));

	// 1. Look up every name mentioned, in one query
	const mentioned = new Set<string>();
	for (const e of input.entities) for (const n of [e.name, ...(e.aliases ?? [])]) mentioned.add(nameKey(n));
	for (const r of input.relations) {
		mentioned.add(nameKey(r.from));
		if (r.to) mentioned.add(nameKey(r.to));
	}
	mentioned.delete("");
	const { results: known } = await db
		.prepare(
			`SELECT n.entity_id, n.name_key, e.type FROM entity_names n
			 JOIN entities e ON e.id = n.entity_id AND e.active = 1
			 WHERE n.active = 1 AND n.name_key IN (SELECT value FROM json_each(?))`,
		)
		.bind(json([...mentioned]))
		.all<NameRow>();
	const byKey = new Map<string, NameRow[]>();
	for (const row of known) byKey.set(row.name_key, [...(byKey.get(row.name_key) ?? []), row]);

	// 2. Resolve each declared entity to an existing one or a new id
	const local = new Map<string, string>(); // name key → entity id, for this payload
	const newEntities = new Map<string, { id: string; name: string; type: EntityType; summary: string | null }>();
	const newNames: { entity_id: string; name_key: string }[] = [];
	const hasName = new Set(known.map((k) => `${k.entity_id}\u0000${k.name_key}`));

	const candidateIds = input.entities.map((e) => entityId(e.type, e.name));
	const { results: existingIds } = await db
		.prepare("SELECT id FROM entities WHERE active = 1 AND id IN (SELECT value FROM json_each(?))")
		.bind(json(candidateIds))
		.all<{ id: string }>();
	const idExists = new Set(existingIds.map((r) => r.id));

	for (const e of input.entities) {
		const keys = [e.name, ...(e.aliases ?? [])].map(nameKey).filter(Boolean);
		if (keys.some((k) => ROOT_KEYS.has(k))) {
			for (const k of keys) local.set(k, ROOT_ID);
			continue;
		}
		const matches = keys.flatMap((k) => byKey.get(k) ?? []);
		const sameType = [...new Set(matches.filter((m) => m.type === e.type).map((m) => m.entity_id))];
		let id: string;
		if (sameType.length >= 1) {
			const exact = (byKey.get(keys[0]) ?? []).find((m) => m.type === e.type);
			id = exact?.entity_id ?? sameType[0];
			if (sameType.length > 1) result.review.push(`"${e.name}" matched several ${e.type}s: ${sameType.join(", ")}`);
		} else {
			id = entityId(e.type, e.name);
			if (matches.length) result.review.push(`"${e.name}" (${e.type}) shares a name with ${matches[0].entity_id}; kept separate`);
			if (!idExists.has(id) && !newEntities.has(id)) {
				newEntities.set(id, { id, name: e.name, type: e.type, summary: e.summary ?? null });
			}
		}
		const isCategory = e.type === "topic" && categories.has(nameKey(e.name));
		for (const k of new Set(keys)) {
			// a category's extra words ("trains" for Transport) never take over a thing's own name
			if (!(isCategory && k !== keys[0] && local.has(k))) local.set(k, id);
			if (!hasName.has(`${id}\u0000${k}`)) {
				hasName.add(`${id}\u0000${k}`);
				newNames.push({ entity_id: id, name_key: k });
			}
		}
	}

	const resolve = (n: string): string | null => {
		const k = nameKey(n);
		if (ROOT_KEYS.has(k)) return ROOT_ID;
		if (local.has(k)) return local.get(k)!;
		const ids = [...new Set((byKey.get(k) ?? []).map((m) => m.entity_id))];
		if (ids.length > 1) result.review.push(`"${n}" is ambiguous: ${ids.join(", ")}`);
		return ids[0] ?? null;
	};

	// 3. Turn relations into rows
	type NewRel = { from_id: string; relation: Relation; to_id: string | null; value: string | null; valid_from: string | null };
	const wanted: NewRel[] = [];
	for (const r of input.relations) {
		const from = resolve(r.from);
		if (!from) {
			result.skipped_relations++;
			result.review.push(`relation from unknown "${r.from}" skipped`);
			continue;
		}
		let to = r.to ? resolve(r.to) : null;
		let value = r.value ?? null;
		if (r.to && !to) value = value ? `${r.to} (${value})` : r.to; // unknown target: keep it as a detail
		let relation = r.relation.toLowerCase().replace(/[\s-]+/g, "_") as Relation;
		if (!(relation in RELATIONS)) {
			result.review.push(`unknown relation "${r.relation}" stored as other`);
			value = value ? `${r.relation}: ${value}` : r.relation;
			relation = "other";
		}
		if (to === from) to = null;
		if (!to && !value) {
			result.skipped_relations++;
			continue;
		}
		wanted.push({ from_id: from, relation, to_id: to, value, valid_from: isoDate(r.valid_from) ? r.valid_from! : asOf });
	}

	// 4. Compare with what's already current
	const fromIds = [...new Set(wanted.map((w) => w.from_id))];
	const { results: current } = await db
		.prepare(
			`SELECT row_id, from_id, relation, to_id, value, origin_type, origin_id, valid_from, created FROM relations
			 WHERE active = 1 AND from_id IN (SELECT value FROM json_each(?))`,
		)
		.bind(json(fromIds))
		.all<RelRow>();
	const same = (a: { to_id: string | null; value: string | null }, b: { to_id: string | null; value: string | null }) =>
		a.to_id === b.to_id && valueKey(a.value) === valueKey(b.value);

	const retire = new Set<number>();
	const inserts: (NewRel & { replaces_id: number | null })[] = [];
	const history: NewRel[] = []; // stored inactive: lost to a newer or fact-based current value
	const keep = new Set<number>(); // current rows this payload re-states
	for (const w of wanted) {
		const sameRel = current.filter((c) => c.from_id === w.from_id && c.relation === w.relation);
		const dup = sameRel.find((c) => same(c, w));
		if (dup || inserts.some((i) => i.from_id === w.from_id && i.relation === w.relation && same(i, w))) {
			if (dup) keep.add(dup.row_id);
			result.skipped_relations++;
			continue;
		}
		let replaces: number | null = null;
		if (RELATIONS[w.relation] === "single") {
			// Old information never overwrites new, and a chat or document never overwrites a fact
			const factWins = origin.type !== "fact" && sameRel.some((c) => c.origin_type === "fact");
			const newer = sameRel.some((c) => (isoDate(c.valid_from) ?? c.created.slice(0, 10)) > asOf);
			if (factWins || newer) {
				history.push(w);
				result.kept_as_history++;
				if (factWins) result.review.push(`${w.relation} from ${origin.type} not applied: current value comes from a fact`);
				continue;
			}
			for (const c of sameRel) {
				retire.add(c.row_id);
				replaces = c.row_id;
			}
			// two new values for a single relation in one payload: the last one wins
			for (let i = inserts.length - 1; i >= 0; i--) {
				if (inserts[i].from_id === w.from_id && inserts[i].relation === w.relation) inserts.splice(i, 1);
			}
		}
		inserts.push({ ...w, replaces_id: replaces });
	}

	// 5. A new version of a document / project / profile: links it no longer states are retired
	if (opts.replaceOrigin) {
		const { results: fromOrigin } = await db
			.prepare("SELECT row_id FROM relations WHERE active = 1 AND origin_type = ? AND origin_id = ?")
			.bind(origin.type, origin.id)
			.all<{ row_id: number }>();
		for (const r of fromOrigin) if (!keep.has(r.row_id)) retire.add(r.row_id);
	}

	// 6. Write everything in one batch
	const statements: D1PreparedStatement[] = [];
	if (newEntities.size) {
		statements.push(
			db
				.prepare(
					`INSERT INTO entities (id, name, type, summary, source, created)
					 SELECT json_extract(value,'$.id'), json_extract(value,'$.name'), json_extract(value,'$.type'),
					        json_extract(value,'$.summary'), ?, ? FROM json_each(?)`,
				)
				.bind(opts.source, ts, json([...newEntities.values()])),
		);
	}
	if (newNames.length) {
		statements.push(
			db
				.prepare(
					`INSERT INTO entity_names (entity_id, name_key, created)
					 SELECT json_extract(value,'$.entity_id'), json_extract(value,'$.name_key'), ? FROM json_each(?)`,
				)
				.bind(ts, json(newNames)),
		);
	}
	if (retire.size) {
		statements.push(
			db
				.prepare("UPDATE relations SET active = 0, deactivated = ? WHERE active = 1 AND row_id IN (SELECT value FROM json_each(?))")
				.bind(ts, json([...retire])),
		);
	}
	if (inserts.length) {
		statements.push(
			db
				.prepare(
					`INSERT INTO relations (from_id, relation, to_id, value, origin_type, origin_id, valid_from, source, replaces_id, created)
					 SELECT json_extract(value,'$.from_id'), json_extract(value,'$.relation'), json_extract(value,'$.to_id'),
					        json_extract(value,'$.value'), ?, ?, json_extract(value,'$.valid_from'), ?,
					        json_extract(value,'$.replaces_id'), ? FROM json_each(?)`,
				)
				.bind(origin.type, origin.id, opts.source, ts, json(inserts)),
		);
	}
	result.entities_created = newEntities.size;
	result.names_added = newNames.length;
	result.relations_added = inserts.length;
	if (history.length) {
		// Re-running the same item doesn't store the same history line twice
		const { results: past } = await db
			.prepare("SELECT from_id, relation, to_id, value FROM relations WHERE active = 0 AND origin_type = ? AND origin_id = ?")
			.bind(origin.type, origin.id)
			.all<{ from_id: string; relation: string; to_id: string | null; value: string | null }>();
		for (let i = history.length - 1; i >= 0; i--) {
			const h = history[i];
			if (past.some((p) => p.from_id === h.from_id && p.relation === h.relation && same(p, h))) history.splice(i, 1);
		}
	}
	if (history.length) {
		statements.push(
			db
				.prepare(
					`INSERT INTO relations (from_id, relation, to_id, value, origin_type, origin_id, valid_from, source, active, created, deactivated)
					 SELECT json_extract(value,'$.from_id'), json_extract(value,'$.relation'), json_extract(value,'$.to_id'),
					        json_extract(value,'$.value'), ?, ?, json_extract(value,'$.valid_from'), ?, 0, ?, ? FROM json_each(?)`,
				)
				.bind(origin.type, origin.id, opts.source, ts, ts, json(history)),
		);
	}
	statements.push(...retireOrphans(db, ts));
	result.relations_retired = retire.size;
	statements.push(logStatement(db, origin, "write", result.review.length ? "review" : "ok", summarise(result)));
	await db.batch(statements);
	return result;
}

/** Append one line to graph_log. Details are counts or short notes, never message text. */
export const logStatement = (db: D1Database, origin: Origin, step: string, status: string, detail: string | null) =>
	db
		.prepare("INSERT INTO graph_log (item_type, item_id, step, status, detail, created) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(origin.type, origin.id, step, status, detail?.slice(0, 1000) ?? null, now());

const summarise = (r: WriteResult) =>
	`+${r.entities_created} entities, +${r.names_added} names, +${r.relations_added} links, -${r.relations_retired} retired, ${r.kept_as_history} kept as history, ${r.skipped_relations} skipped` +
	(r.review.length ? ` | review: ${r.review.join("; ")}` : "");

/** Entities (and their names) with no current link left are retired. The owner always stays. */
const ORPHAN = `active = 1 AND id != '${ROOT_ID}' AND NOT EXISTS (
	SELECT 1 FROM relations r WHERE r.active = 1 AND (r.from_id = entities.id OR r.to_id = entities.id))`;
export const retireOrphans = (db: D1Database, ts = now()) => [
	db
		.prepare(`UPDATE entity_names SET active = 0, deactivated = ? WHERE active = 1 AND entity_id IN (SELECT id FROM entities WHERE ${ORPHAN})`)
		.bind(ts),
	db.prepare(`UPDATE entities SET active = 0, deactivated = ? WHERE ${ORPHAN}`).bind(ts),
];

/** Retire every current link taken from one item (used when a document, project or chat is forgotten). */
export const retireOrigin = (db: D1Database, origin: Origin) =>
	db
		.prepare("UPDATE relations SET active = 0, deactivated = ? WHERE active = 1 AND origin_type = ? AND origin_id = ?")
		.bind(now(), origin.type, origin.id);
