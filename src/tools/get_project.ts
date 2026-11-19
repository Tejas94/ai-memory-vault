import { z } from "zod";
import { all, clip, first, LIVE_FACT, now } from "../db";
import { defineTool, ToolError } from "./types";

const DOC_PREVIEW = 1_500; // characters of each project document; full text via get_document

export const getProject = defineTool({
	name: "get_project",
	description:
		"Full briefing on one project: description, instructions, project documents (previews; full text via " +
		"get_document), project facts, notes and the last 10 conversations (titles + ids). Coding tools: call this at " +
		"the start of a session.",
	inputSchema: {
		project_id: z.string(),
	},
	async run(env, _source, { project_id }) {
		const db = env.DB;
		const project = await first<Record<string, unknown>>(
			db,
			"SELECT id AS project_id, name, description, instructions, status, created AS updated, source FROM projects WHERE id = ? AND active = 1",
			project_id,
		);
		if (!project) throw new ToolError(`No current project with id ${project_id}. Call list_projects to see ids.`);

		const [documents, facts, notes, conversations] = await Promise.all([
			all<{ document_id: string; name: string; file_type: string | null; content: string }>(
				db,
				"SELECT doc_id AS document_id, name, file_type, content FROM documents WHERE project_id = ? AND scope = 'project' AND active = 1 ORDER BY created DESC",
				project_id,
			),
			all(
				db,
				`SELECT f.row_id AS id, f.fact, f.category, f.kind, f.created FROM facts f
				 WHERE f.project_id = ? AND ${LIVE_FACT} ORDER BY f.created DESC LIMIT 50`,
				project_id,
				now(),
			),
			all<{ path: string; content: string; source: string }>(
				db,
				"SELECT path, content, source FROM memory_notes WHERE project_id = ? AND active = 1 ORDER BY created DESC",
				project_id,
			),
			all(
				db,
				`SELECT id AS conversation_id, title, source, COALESCE(created, saved) AS date FROM conversations
				 WHERE project_id = ? AND active = 1 ORDER BY COALESCE(created, saved) DESC LIMIT 10`,
				project_id,
			),
		]);

		return {
			...project,
			documents: documents.map((d) => ({ ...d, content: clip(d.content, DOC_PREVIEW) })),
			facts,
			notes: notes.map((n) => ({ ...n, content: clip(n.content, DOC_PREVIEW) })),
			recent_conversations: conversations,
		};
	},
});
