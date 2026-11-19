import { z } from "zod";
import { all, capText, cleanText, first, newId, now, retire } from "../db";
import { documentInsert } from "./save_document";
import { afterSave } from "../sync";
import { piecesForChat } from "../vectors/embed";
import { defineTool, ToolError } from "./types";

const MAX_MESSAGE = 50_000; // characters per message; longer ones are trimmed with a note

// AIs say user/assistant; Vault stores you/ai
const ROLES = { you: "you", user: "you", ai: "ai", assistant: "ai" } as const;

export const saveConversation = defineTool({
	name: "save_conversation",
	description:
		'Save a whole chat to Vault ("Save this conversation to Vault"), both sides, in order. Include the text of any ' +
		"files shared in the chat as `documents` (extracted text only, never originals). To add newer messages to a chat " +
		"saved earlier, pass the conversation_id it returned; messages already saved are skipped. File it under a project " +
		'with project_id when the user says "…under <project>".',
	inputSchema: {
		title: z.string().describe("Short title for the chat."),
		messages: z
			.array(
				z.object({
					role: z.enum(["you", "ai", "user", "assistant"]).describe("you/user = the owner, ai/assistant = the AI."),
					text: z.string(),
					time: z.string().optional().describe("ISO time, if known."),
				}),
			)
			.min(1),
		documents: z
			.array(z.object({ name: z.string(), content: z.string(), file_type: z.string().optional() }))
			.optional()
			.describe("Text of files shared in the chat."),
		project_id: z.string().optional(),
		conversation_id: z.string().optional().describe("Existing saved chat to append to."),
	},
	async run(env, source, input, ctx) {
		const db = env.DB;
		const ts = now();
		const title = cleanText(input.title) || "Untitled chat";
		const incoming = input.messages
			.filter((m) => m.text.trim())
			.map((m) => ({ ...m, role: ROLES[m.role], text: capText(m.text, MAX_MESSAGE).text }));
		if (!incoming.length) throw new ToolError("All messages are empty.");

		let conversationId: string;
		let projectId = input.project_id ?? null;
		let nextSeq = 0;
		let messages = incoming;
		const statements: D1PreparedStatement[] = [];

		if (input.conversation_id) {
			// Append: new version of the conversation row, then only the messages not saved before
			const old = await first<{ row_id: number; project_id: string | null; created: string | null }>(
				db,
				"SELECT row_id, project_id, created FROM conversations WHERE id = ? AND active = 1",
				input.conversation_id,
			);
			if (!old) throw new ToolError(`No current conversation with id ${input.conversation_id}.`);
			conversationId = input.conversation_id;
			projectId = projectId ?? old.project_id;

			const existing = await all<{ seq: number; role: string; text: string }>(
				db,
				"SELECT seq, role, text FROM messages WHERE conversation_id = ? AND active = 1",
				conversationId,
			);
			const seen = new Set(existing.map((m) => `${m.role}\u0000${m.text}`));
			messages = incoming.filter((m) => !seen.has(`${m.role}\u0000${m.text}`));
			nextSeq = existing.reduce((max, m) => Math.max(max, m.seq + 1), 0);

			statements.push(
				retire(db, "conversations", "id = ?", conversationId),
				db
					.prepare(
						"INSERT INTO conversations (id, title, source, project_id, created, saved, replaces_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.bind(conversationId, title, source, projectId, old.created, ts, old.row_id),
			);
		} else {
			conversationId = newId("vault");
			statements.push(
				db
					.prepare("INSERT INTO conversations (id, title, source, project_id, created, saved) VALUES (?, ?, ?, ?, ?, ?)")
					.bind(conversationId, title, source, projectId, ts, ts),
			);
		}

		messages.forEach((m, i) => {
			statements.push(
				db
					.prepare(
						"INSERT INTO messages (conversation_id, seq, role, time, text, source, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.bind(conversationId, nextSeq + i, m.role, m.time ?? null, m.text, source, ts),
			);
		});

		const documents = (input.documents ?? []).map((d) =>
			documentInsert(
				db,
				source,
				{ ...d, scope: "conversation", conversation_id: conversationId, project_id: projectId },
				newId("doc"),
			),
		);
		statements.push(...documents.map((d) => d.statement));

		// One batch: the conversation, its messages and documents are saved together or not at all
		await db.batch(statements);
		if (messages.length) {
			const text = `Chat: ${title}\n${messages.map((m) => `${m.role === "you" ? "Owner" : "AI"}: ${m.text}`).join("\n")}`;
			// The chat's date: its newest message time if the app gave one, otherwise now
			const asOf = messages.map((m) => m.time ?? "").sort().pop() || ts;
			const pieces = piecesForChat(title, messages.map((m, i) => ({ seq: nextSeq + i, role: m.role, text: m.text })));
			afterSave(env, ctx, { type: "conversation", id: conversationId }, text, { asOf, pieces, append: !!input.conversation_id });
		}
		for (const d of documents) {
			afterSave(env, ctx, { type: "document", id: d.document_id }, `Document: ${d.name}\n${d.text}`);
		}
		return {
			conversation_id: conversationId,
			saved_messages: messages.length,
			skipped_already_saved: incoming.length - messages.length,
			documents: documents.map((d) => ({ document_id: d.document_id, name: d.name, truncated: d.truncated })),
			message: "Saved ✓",
		};
	},
});
