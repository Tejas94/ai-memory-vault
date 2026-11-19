import { z } from "zod";
import { all } from "../db";
import { defineTool } from "./types";

export const PROJECT_STATUSES = ["active", "paused", "done"] as const;

export const listProjects = defineTool({
	name: "list_projects",
	description: "List the user's projects (id, name, status, last updated, which app updated it). Filter by status.",
	inputSchema: {
		status: z.enum(PROJECT_STATUSES).optional(),
	},
	async run(env, _source, { status }) {
		const projects = await all<Record<string, unknown>>(
			env.DB,
			`SELECT id AS project_id, name, status, created AS updated, source FROM projects
			 WHERE active = 1${status ? " AND status = ?" : ""} ORDER BY created DESC`,
			...(status ? [status] : []),
		);
		return { projects };
	},
});
