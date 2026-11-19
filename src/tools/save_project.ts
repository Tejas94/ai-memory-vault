import { z } from "zod";
import { cleanText, first, now, retire, slug } from "../db";
import { PROJECT_STATUSES } from "./list_projects";
import { afterSave } from "../sync";
import { defineTool, ToolError } from "./types";

type ProjectRow = { row_id: number; name: string; description: string | null; instructions: string | null; status: string };

export const saveProject = defineTool({
	name: "save_project",
	description:
		"Create a project, or update one by passing its project_id. Fields you leave out keep their current value; " +
		"the old version is kept as history. status: active / paused / done.",
	inputSchema: {
		project_id: z.string().optional().describe("Existing project to update. Leave out to create a new one."),
		name: z.string(),
		description: z.string().optional(),
		instructions: z.string().optional().describe("How AIs should work on this project."),
		status: z.enum(PROJECT_STATUSES).optional(),
	},
	async run(env, source, input, ctx) {
		const name = cleanText(input.name);
		if (!name) throw new ToolError("name is empty.");
		const id = slug(input.project_id ?? name);
		if (!id) throw new ToolError("Project id needs at least one letter or number.");

		const old = await first<ProjectRow>(
			env.DB,
			"SELECT row_id, name, description, instructions, status FROM projects WHERE id = ? AND active = 1",
			id,
		);
		if (old && !input.project_id) {
			throw new ToolError(`A project with id "${id}" already exists. Pass project_id "${id}" to update it.`);
		}

		const insert = env.DB.prepare(
			"INSERT INTO projects (id, name, description, instructions, status, source, replaces_id, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).bind(
			id,
			name,
			input.description ?? old?.description ?? null,
			input.instructions ?? old?.instructions ?? null,
			input.status ?? old?.status ?? "active",
			source,
			old?.row_id ?? null,
			now(),
		);
		await (old ? env.DB.batch([retire(env.DB, "projects", "id = ?", id), insert]) : insert.run());
		const description = input.description ?? old?.description ?? "";
		afterSave(env, ctx, { type: "project", id }, `Project "${name}" (id ${id}, status ${input.status ?? old?.status ?? "active"}): ${description}`, {
			replaceOrigin: true,
		});
		return { project_id: id, updated: !!old, message: "Saved ✓" };
	},
});
