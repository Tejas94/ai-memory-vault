import { z } from "zod";
import { first } from "../db";
import { defineTool, ToolError } from "./types";

export const getDocument = defineTool({
	name: "get_document",
	description:
		"Read one document in full. Use the document_id from search_history, get_project or get_conversation.",
	inputSchema: {
		document_id: z.string(),
	},
	async run(env, _source, { document_id }) {
		const doc = await first<Record<string, unknown>>(
			env.DB,
			`SELECT doc_id AS document_id, name, file_type, scope, project_id, conversation_id, source, created, content
			 FROM documents WHERE doc_id = ? AND active = 1`,
			document_id,
		);
		if (!doc) throw new ToolError(`No current document with id ${document_id}.`);
		return doc;
	},
});
