import { z } from "zod";
import { all, first } from "../db";
import { defineTool, ToolError } from "./types";

const PAGE_SIZE = 40;

export const getConversation = defineTool({
	name: "get_conversation",
	description:
		"Read one saved chat in full, 40 messages per page, plus the list of documents attached to it. Use the " +
		"conversation_id from search_history or get_project. Ask for the next page if `total_pages` is larger.",
	inputSchema: {
		conversation_id: z.string(),
		page: z.number().int().min(1).optional().describe("Page number, from 1. Default 1."),
	},
	async run(env, _source, { conversation_id, page = 1 }) {
		const conv = await first<{ title: string | null; source: string; project_id: string | null; created: string | null }>(
			env.DB,
			"SELECT title, source, project_id, created FROM conversations WHERE id = ? AND active = 1",
			conversation_id,
		);
		if (!conv) throw new ToolError(`No current conversation with id ${conversation_id}.`);

		const [count, messages, documents] = await Promise.all([
			first<{ n: number }>(
				env.DB,
				"SELECT count(*) AS n FROM messages WHERE conversation_id = ? AND active = 1",
				conversation_id,
			),
			all<{ seq: number; role: string; time: string | null; text: string }>(
				env.DB,
				"SELECT seq, role, time, text FROM messages WHERE conversation_id = ? AND active = 1 ORDER BY seq, row_id LIMIT ? OFFSET ?",
				conversation_id,
				PAGE_SIZE,
				(page - 1) * PAGE_SIZE,
			),
			all<{ document_id: string; name: string; file_type: string | null }>(
				env.DB,
				"SELECT doc_id AS document_id, name, file_type FROM documents WHERE conversation_id = ? AND active = 1 ORDER BY created",
				conversation_id,
			),
		]);

		return {
			conversation_id,
			...conv,
			page,
			total_pages: Math.max(1, Math.ceil((count?.n ?? 0) / PAGE_SIZE)),
			messages,
			documents,
		};
	},
});
