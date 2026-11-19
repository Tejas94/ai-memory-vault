import { z } from "zod";
import { all, ftsQuery, now } from "../db";
import { CATEGORIES } from "./save_memory";
import { defineTool } from "./types";

export const listFacts = defineTool({
	name: "list_facts",
	description:
		'Show what Vault knows so the user can review or correct it ("Show me what Vault has about …"). Always show them the ' +
		"ids, so they can say \"Update Vault: …\" or \"Forget …\". Filter by keywords, category or project. " +
		"include_inactive also shows old and forgotten versions (with the replaces_id chain).",
	inputSchema: {
		query: z.string().optional().describe("Keywords to filter facts, e.g. 'garden'."),
		category: z.enum(CATEGORIES).optional(),
		project_id: z.string().optional(),
		include_inactive: z.boolean().optional(),
		limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
		offset: z.number().int().min(0).optional(),
	},
	async run(env, _source, { query, category, project_id, include_inactive = false, limit = 50, offset = 0 }) {
		const where: string[] = [];
		const params: unknown[] = [];
		const match = query ? ftsQuery(query, "or") : null;
		if (match) {
			where.push("f.row_id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH ?)");
			params.push(match);
		}
		if (!include_inactive) where.push("f.active = 1");
		if (category) {
			where.push("f.category = ?");
			params.push(category);
		}
		if (project_id) {
			where.push("f.project_id = ?");
			params.push(project_id);
		}

		const ts = now();
		const rows = await all<Record<string, unknown> & { active: number; expires: string | null }>(
			env.DB,
			`SELECT f.row_id AS id, f.fact, f.category, f.kind, f.project_id, f.source, f.active, f.replaces_id,
			        f.created, f.expires, f.deactivated
			 FROM facts f ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
			 ORDER BY f.created DESC, f.row_id DESC LIMIT ? OFFSET ?`,
			...params,
			limit,
			offset,
		);

		const facts = rows.map(({ active, ...f }) => ({
			...f,
			status: !active ? "old" : f.expires && f.expires <= ts ? "expired" : "current",
		}));
		return { facts, next_offset: rows.length === limit ? offset + limit : null };
	},
});
