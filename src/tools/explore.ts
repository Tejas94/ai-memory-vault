import { z } from "zod";
import { findMentioned, type Link, walk } from "../graph/read";
import { nameKey } from "../graph/schema";
import { defineTool } from "./types";

const REF = { fact: "fact", conversation: "chat", document: "doc", project: "project", profile: "profile" } as Record<string, string>;

/** "Priya → lives_in → Manchester [fact 42]": the link plus where it came from, so it can be opened or corrected. */
export const linkLine = (l: Link) => `${l.line} [${REF[l.origin_type] ?? l.origin_type} ${l.origin_id}]`;

export const explore = defineTool({
	name: "explore",
	description:
		"Follow Vault's knowledge graph from a person, place, project or thing: who and what it is linked to, in short " +
		"lines like 'Priya → lives_in → Manchester [fact 42]'. Use after get_context for follow-up connections. " +
		"depth 2 also follows the linked items' own links. Read-only.",
	inputSchema: {
		name: z.string().describe("A name or alias, e.g. 'Priya', 'my sister', 'Lumen Pad'."),
		depth: z.number().int().min(1).max(2).optional().describe("1 (default) or 2."),
		max_lines: z.number().int().min(1).max(60).optional().describe("Default 30."),
	},
	async run(env, _source, { name, depth = 1, max_lines = 30 }) {
		let ids = await findMentioned(env.DB, name, 3);
		if (!ids.length) {
			// No exact name: try names that contain it ("lumen" → "lumen pad")
			const key = nameKey(name);
			if (key.length >= 3) {
				const { results } = await env.DB.prepare(
					`SELECT DISTINCT n.entity_id FROM entity_names n JOIN entities e ON e.id = n.entity_id AND e.active = 1
					 WHERE n.active = 1 AND n.name_key LIKE ? LIMIT 3`,
				)
					.bind(`%${key}%`)
					.all<{ entity_id: string }>();
				ids = results.map((r) => r.entity_id);
			}
		}
		if (!ids.length) return { found: false, message: `Nothing in Vault's graph is called "${name}". Try search_history.` };
		const w = await walk(env.DB, ids, depth, max_lines);
		return {
			found: true,
			entities: w.entities.map((e) => ({ id: e.id, name: e.name, type: e.type, summary: e.summary ?? undefined })),
			links: w.links.map(linkLine),
		};
	},
});
