import { z } from "zod";
import type { Source } from "../auth";
import { capText, cleanText, first, newId, now, retire } from "../db";
import { afterSave } from "../sync";
import { defineTool, ToolError } from "./types";

export const MAX_DOCUMENT = 200_000; // characters (~200 KB)

export type DocumentInput = {
	name: string;
	content: string;
	file_type?: string;
	scope: "project" | "conversation" | "standalone";
	project_id?: string | null;
	conversation_id?: string | null;
};

/** INSERT statement for one document version, plus what was stored. Shared with save_conversation. */
export function documentInsert(db: D1Database, source: Source, doc: DocumentInput, docId: string, replacesId?: number) {
	const name = cleanText(doc.name);
	if (!name) throw new ToolError("Document name is empty.");
	if (!doc.content.trim()) throw new ToolError(`Document "${name}" has no text.`);
	const { text, truncated } = capText(doc.content, MAX_DOCUMENT);
	const statement = db
		.prepare(
			`INSERT INTO documents (doc_id, name, file_type, scope, content, project_id, conversation_id, source, replaces_id, created)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			docId,
			name,
			doc.file_type ?? name.split(".").pop()?.toLowerCase() ?? null,
			doc.scope,
			text,
			doc.project_id ?? null,
			doc.conversation_id ?? null,
			source,
			replacesId ?? null,
			now(),
		);
	return { statement, document_id: docId, name, truncated, text };
}

export const saveDocument = defineTool({
	name: "save_document",
	description:
		'Save a document\'s text to Vault ("Save this document to Vault"). Never send the original file: send its ' +
		"extracted text; for images, a description plus any visible text. Long files may be shortened (max ~200,000 " +
		"characters). scope: project (belongs to a project), conversation (attached to a saved chat) or standalone. " +
		"To update an existing document, pass its document_id; the old version is kept as history.",
	inputSchema: {
		name: z.string().describe("File name, e.g. 'lease-agreement.pdf'."),
		content: z.string().describe("The document's text."),
		file_type: z.string().optional().describe("e.g. pdf, docx, png. Guessed from the name if missing."),
		scope: z.enum(["project", "conversation", "standalone"]),
		project_id: z.string().optional().describe("Required when scope is project."),
		conversation_id: z.string().optional().describe("Required when scope is conversation."),
		document_id: z.string().optional().describe("Existing document to replace with this new version."),
	},
	async run(env, source, input, ctx) {
		if (input.scope === "project" && !input.project_id) throw new ToolError("scope project needs a project_id.");
		if (input.scope === "conversation" && !input.conversation_id)
			throw new ToolError("scope conversation needs a conversation_id.");

		if (!input.document_id) {
			const doc = documentInsert(env.DB, source, input, newId("doc"));
			await doc.statement.run();
			afterSave(env, ctx, { type: "document", id: doc.document_id }, `Document: ${doc.name}\n${doc.text}`);
			return { document_id: doc.document_id, truncated: doc.truncated, message: "Saved ✓" };
		}

		const old = await first<{ row_id: number }>(
			env.DB,
			"SELECT row_id FROM documents WHERE doc_id = ? AND active = 1",
			input.document_id,
		);
		if (!old) throw new ToolError(`No current document with id ${input.document_id}.`);
		const doc = documentInsert(env.DB, source, input, input.document_id, old.row_id);
		await env.DB.batch([retire(env.DB, "documents", "doc_id = ?", input.document_id), doc.statement]);
		// New version: links the document no longer states are retired once the new ones are in
		// (the document keeps its id, so its old vectors are replaced by the new version's)
		afterSave(env, ctx, { type: "document", id: doc.document_id }, `Document: ${doc.name}\n${doc.text}`, { replaceOrigin: true });
		return { document_id: doc.document_id, replaced: old.row_id, truncated: doc.truncated, message: "Saved ✓" };
	},
});
