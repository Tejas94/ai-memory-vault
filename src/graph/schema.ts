// Knowledge graph vocabulary and input shape. Shared by the auto-update (Workers AI), the one-time
// backfill script and the tests, so every link follows the same rules wherever it comes from.
import { z } from "zod";

export const ROOT_ID = "person:me";

export const ENTITY_TYPES = ["person", "project", "organisation", "place", "thing", "goal", "event", "topic"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * Allowed relations. "single" = only one current value per (from, relation): a new value retires the
 * old one (moving city, changing job). "multi" = they add up (friends, things owned).
 */
export const RELATIONS = {
	relative_of: "multi", // value = sister / cousin …
	friend_of: "multi",
	knows: "multi", // colleagues, acquaintances; value = how
	lives_in: "single",
	grew_up_in: "single",
	located_in: "single", // a place or organisation's location
	works_at: "single",
	works_as: "single", // job title
	worked_at: "multi", // past employers
	works_on: "multi",
	part_of: "multi",
	owns: "multi",
	uses: "multi",
	wants: "multi",
	plans: "multi",
	has_goal: "multi",
	decided: "multi",
	prefers: "multi",
	dislikes: "multi",
	has: "multi", // attributes and details: value = "height: 180 cm"
	health: "multi", // conditions, treatments, results
	about: "multi", // a conversation / document is about an entity
	is_a: "multi", // a thing's general category, from CATEGORIES (Fiat Panda → is_a → Car)
	happened_on: "single", // events
	deadline: "single",
	other: "multi", // anything else; logged for review
} as const;
export type Relation = keyof typeof RELATIONS;
export const RELATION_NAMES = Object.keys(RELATIONS) as Relation[];

/**
 * General categories a thing, place or organisation can be filed under (is_a), so a question about
 * "car" or "car rental" reaches every car Vault knows about. A short fixed list keeps the model from
 * inventing categories that are too broad or too narrow. Key = category name; values = other words
 * that mean the same (plurals, synonyms), all matched when a question mentions them.
 */
export const CATEGORIES: Record<string, string[]> = {
	car: ["cars", "vehicle", "vehicles"],
	motorbike: ["motorbikes", "motorcycle", "motorcycles"],
	bicycle: ["bicycles", "bike", "bikes", "cycle"],
	laptop: ["laptops", "notebook"],
	computer: ["computers", "desktop", "pc"],
	phone: ["phones", "mobile", "smartphone"],
	gadget: ["gadgets", "device", "devices", "electronics"],
	app: ["apps", "software", "application"],
	"ai tool": ["ai tools", "ai model", "ai models", "llm", "chatbot"],
	"programming language": ["programming languages", "coding language"],
	website: ["websites"],
	property: ["properties", "flat", "flats", "apartment", "house", "real estate"],
	city: ["cities", "town"],
	country: ["countries"],
	company: ["companies", "employer", "employers", "firm"],
	school: ["schools"],
	university: ["universities", "college"],
	course: ["courses", "class", "classes", "training"],
	certification: ["certifications", "certificate"],
	job: ["jobs", "role", "position"],
	bank: ["banks"],
	investment: ["investments", "stocks", "shares", "fund", "funds", "crypto"],
	loan: ["loans", "mortgage"],
	insurance: [],
	visa: ["visas", "immigration", "residence permit"],
	supplement: ["supplements", "vitamin", "vitamins", "protein"],
	medicine: ["medicines", "medication", "medications"],
	"health condition": ["health conditions", "illness", "disease"],
	food: ["foods", "meal", "meals", "dish"],
	drink: ["drinks", "beverage"],
	restaurant: ["restaurants", "cafe"],
	clothing: ["clothes", "outfit", "outfits"],
	shoes: ["shoe", "trainers", "sneakers"],
	sport: ["sports"],
	exercise: ["workout", "workouts", "gym"],
	hobby: ["hobbies"],
	book: ["books"],
	film: ["films", "movie", "movies"],
	game: ["games"],
	pet: ["pets"],
	trip: ["trips", "holiday", "holidays"],
	transport: ["train", "trains", "flight", "flights", "plane", "planes", "travel", "commute"],
	watch: ["watches"],
	skincare: ["skin care"],
};
const CATEGORY_KEY = new Map<string, string>();
for (const [c, words] of Object.entries(CATEGORIES)) for (const w of [c, ...words]) CATEGORY_KEY.set(w, c);
/** "Cars" / "vehicle" → "car"; anything not on the list → null. */
export const categoryOf = (word: string) => CATEGORY_KEY.get(nameKey(word)) ?? null;
/** The entity a category is stored as: a topic named after it, known by all its words. */
export const categoryEntity = (c: string) => ({
	name: c[0].toUpperCase() + c.slice(1),
	type: "topic" as const,
	aliases: CATEGORIES[c],
});

export const ORIGIN_TYPES = ["fact", "conversation", "document", "project", "profile"] as const;
export type OriginType = (typeof ORIGIN_TYPES)[number];

const name = z.string().trim().min(1).max(120);

export const EntityInput = z.object({
	name,
	type: z.enum(ENTITY_TYPES),
	aliases: z.array(name).max(10).optional(),
	summary: z.string().trim().max(200).optional(),
});
export const RelationInput = z
	.object({
		from: name, // entity name ("me" = the Vault owner)
		relation: z.string().trim().min(1).max(40),
		to: name.optional(),
		value: z.string().trim().min(1).max(200).optional(),
		valid_from: z.string().max(40).optional(),
	})
	.refine((r) => r.to || r.value, "a relation needs `to` or `value`");

export const GraphInput = z.object({
	entities: z.array(EntityInput).max(60).default([]),
	relations: z.array(RelationInput).max(120).default([]),
});

/** Keep only the well-formed items (a small model sometimes gets one wrong; the rest are still useful). */
export function lenientGraph(raw: unknown): GraphInput {
	const g = (raw ?? {}) as { entities?: unknown[]; relations?: unknown[] };
	const ok = <T>(items: unknown[] | undefined, s: z.ZodType<T>, max: number) =>
		(Array.isArray(items) ? items : []).flatMap((i) => {
			const r = s.safeParse(i);
			return r.success ? [r.data] : [];
		}).slice(0, max);
	return { entities: ok(g.entities, EntityInput, 60), relations: ok(g.relations, RelationInput, 120) };
}
export type GraphInput = z.infer<typeof GraphInput>;

export type Origin = { type: OriginType; id: string };

/** "My Sister!" → "my sister". The key every name and alias is matched on. */
export const nameKey = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

/** Stable entity id from type + name: ("person", "Priya Shah") → "person:priya-shah". */
export const entityId = (type: EntityType, n: string) =>
	`${type}:${nameKey(n).replace(/ /g, "-").slice(0, 60) || "unnamed"}`;
