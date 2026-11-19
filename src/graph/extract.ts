// Auto-update: after each save, Vault's own small model (Workers AI, free tier) reads the saved item
// and the graph writer stores the links. The chat AI never writes the graph; it only saves as usual.
// Runs in the background after the save has replied, and never makes a save fail.
import { CATEGORIES, ENTITY_TYPES, lenientGraph, type Origin, RELATION_NAMES } from "./schema";
import { logStatement, writeGraph } from "./write";

export const GRAPH_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_INPUT = 6_000; // characters sent to the model per call
const MAX_PARTS = 4; // calls per saved item (free-tier friendly); the rest is logged as not read
const AI_LINE_WHEN_LONG = 300; // in a long chat the AI's replies are shortened so the owner's side fits
const TIMEOUT_MS = 25_000;

export type Extractor = (env: Env, text: string, origin: Origin) => Promise<unknown>;

const PROMPT = `You build a personal knowledge graph for the owner of a memory vault.
From the text, extract lasting entities and the links between them. Return JSON only.

Entity types: ${ENTITY_TYPES.join(", ")}.
Relations (use only these): ${RELATION_NAMES.join(", ")}.

Rules:
- The vault owner is always the entity "me" (the text may say I, me, the owner's name, the user). Don't declare "me".
- Give people other names they go by as aliases, including how the owner refers to them ("my sister", "gran").
- Use "to" for a link to another entity, "value" for a detail (a number, date, size, short description).
- relative_of: put the family role in value, e.g. {"from":"me","relation":"relative_of","to":"Priya","value":"sister"}.
- has: attributes as "name: detail", e.g. {"from":"me","relation":"has","value":"height: 180 cm"}.
- Include health, money, work, family, plans, preferences and decisions. Skip greetings and small talk.
- In a chat, "Owner:" lines are the owner's own words: the main source. "AI:" lines are an assistant:
  take from them only lasting decisions, plans and project details (e.g. what a project is, how it is
  built, what was agreed). Skip the assistant's general advice, explanations and suggestions.
- Venting or passing moods are not lasting facts. Past events are fine; mark them as past in value.
- File every thing, place and organisation under one general category with is_a, choosing only from:
  ${Object.keys(CATEGORIES).join(", ")}.
  e.g. {"from":"Fiat Panda","relation":"is_a","to":"car"}, {"from":"Leeds flat","relation":"is_a","to":"property"}.
  Skip is_a when none of these fits.
- Keep names short and canonical ("Fiat Panda", "Leeds"). At most 20 entities and 30 relations.
- If nothing lasting is in the text, return {"entities":[],"relations":[]}.`;

const SCHEMA = {
	type: "object",
	properties: {
		entities: {
			type: "array",
			items: {
				type: "object",
				properties: {
					name: { type: "string" },
					type: { type: "string", enum: [...ENTITY_TYPES] },
					aliases: { type: "array", items: { type: "string" } },
				},
				required: ["name", "type"],
			},
		},
		relations: {
			type: "array",
			items: {
				type: "object",
				properties: {
					from: { type: "string" },
					relation: { type: "string", enum: RELATION_NAMES },
					to: { type: "string" },
					value: { type: "string" },
				},
				required: ["from", "relation"],
			},
		},
	},
	required: ["entities", "relations"],
};

/** Ask Workers AI for entities + relations as JSON. */
export const aiExtract: Extractor = async (env, text) => {
	if (!env.AI) throw new Error("no AI binding");
	const out = (await env.AI.run(GRAPH_MODEL as any, {
		messages: [
			{ role: "system", content: PROMPT },
			{ role: "user", content: text.slice(0, MAX_INPUT) },
		],
		response_format: { type: "json_schema", json_schema: SCHEMA },
		max_tokens: 1500,
	} as any)) as { response?: unknown };
	const r = out?.response;
	return typeof r === "string" ? JSON.parse(r) : r;
};

let extractor: Extractor = aiExtract;
/** Tests swap in a fake model. */
export const setExtractor = (fn: Extractor) => {
	extractor = fn;
};

const withTimeout = <T>(p: Promise<T>, ms: number) =>
	Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`timed out after ${ms} ms`)), ms))]);

/**
 * Split an item into parts the model can read. The first line (e.g. "Chat: <title>") is repeated on
 * every part. A chat too long for MAX_PARTS keeps all the owner's lines and shortens the AI's.
 */
export function splitForModel(text: string, maxParts = MAX_PARTS, size = MAX_INPUT) {
	const [head, ...rest] = text.split("\n");
	let lines = rest;
	if (text.length > maxParts * size) {
		lines = rest.map((l) => (l.startsWith("AI: ") && l.length > AI_LINE_WHEN_LONG ? `${l.slice(0, AI_LINE_WHEN_LONG)} …` : l));
	}
	const parts: string[] = [];
	let cur = head;
	for (let line of lines) {
		while (line.length > size - head.length - 1) {
			// one very long line (a pasted document): cut it
			parts.push(`${head}\n${line.slice(0, size - head.length - 1)}`);
			line = line.slice(size - head.length - 1);
		}
		if (cur.length + line.length + 1 > size) {
			parts.push(cur);
			cur = head;
		}
		cur += `\n${line}`;
	}
	if (cur !== head || !parts.length) parts.push(cur);
	return { parts: parts.slice(0, maxParts), total: parts.length };
}

/** Extract and store links for one saved item. Never throws: failures are logged in graph_log. */
export async function updateGraph(
	env: Env,
	origin: Origin,
	text: string,
	opts: { replaceOrigin?: boolean; asOf?: string } = {},
) {
	if (!text.trim()) return;
	try {
		const { parts, total } = splitForModel(text);
		const answers = await Promise.allSettled(parts.map((p) => withTimeout(extractor(env, p, origin), TIMEOUT_MS)));
		const ok = answers.flatMap((a) => (a.status === "fulfilled" ? [lenientGraph(a.value)] : []));
		if (!ok.length) throw (answers[0] as PromiseRejectedResult).reason;
		// One write for the whole item, so a new version's "links it no longer states" check sees all parts
		const graph = lenientGraph({ entities: ok.flatMap((g) => g.entities), relations: ok.flatMap((g) => g.relations) });
		await writeGraph(env.DB, graph, origin, { source: "graph_auto", replaceOrigin: opts.replaceOrigin, asOf: opts.asOf });
		const missed = total - ok.length;
		if (missed > 0) {
			const note = `read ${ok.length} of ${total} parts${total > parts.length ? ` (limit ${parts.length})` : ""}`;
			await logStatement(env.DB, origin, "extract", "skipped", note).run().catch(() => {});
		}
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		console.error(`Graph update failed for ${origin.type} ${origin.id}:`, reason);
		await logStatement(env.DB, origin, "extract", "failed", reason)
			.run()
			.catch(() => {});
	}
}
