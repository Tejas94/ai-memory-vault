import { z } from "zod";
import { first, now, retire } from "../db";
import { retireOrigin, retireOrphans } from "../graph/write";
import { afterForget } from "../sync";
import { defineTool, ToolError } from "./types";

// What can be forgotten, and how each is identified (the id the other tools show)
const TABLES = {
	facts: { table: "facts", key: "row_id" },
	documents: { table: "documents", key: "doc_id" },
	projects: { table: "projects", key: "id" },
	conversations: { table: "conversations", key: "id" },
} as const;

export const forget = defineTool({
	name: "forget",
	description:
		'Hide something from Vault when the user says "Forget …". Nothing is deleted: the item is set inactive and can be ' +
		"restored later. Use the id shown by the other tools: a fact id (number) from get_context/list_facts, a " +
		"document_id, a project_id or a conversation_id. Forgetting a conversation also hides its messages from search.",
	inputSchema: {
		id: z.union([z.number().int(), z.string()]).describe("Fact id, document_id, project_id or conversation_id."),
		table: z.enum(["facts", "documents", "projects", "conversations"]).optional().describe("Default facts."),
	},
	async run(env, _source, { id, table = "facts" }, ctx) {
		const { table: t, key } = TABLES[table];
		const current = await first<{ row_id: number }>(env.DB, `SELECT row_id FROM ${t} WHERE ${key} = ? AND active = 1`, id);
		if (!current) throw new ToolError(`Nothing current in ${table} with id ${id}.`);

		const statements = [retire(env.DB, t, `${key} = ?`, id)];
		if (table === "conversations") {
			statements.push(
				env.DB.prepare("UPDATE messages SET active = 0, deactivated = ? WHERE conversation_id = ? AND active = 1").bind(
					now(),
					id,
				),
			);
		}
		// Links taken from the item go too (a fact's links are retired by a database trigger)
		const origin = { documents: "document", projects: "project", conversations: "conversation" } as const;
		if (table !== "facts") statements.push(retireOrigin(env.DB, { type: origin[table], id: String(id) }));
		statements.push(...retireOrphans(env.DB)); // people/places/things with no link left are retired too
		await env.DB.batch(statements);
		// Its vectors leave the meaning-search index (in the background when running inside Vault)
		const vectorsGone = afterForget(env, ctx, { type: ({ facts: "fact", ...origin } as const)[table], id: String(id) });
		if (!ctx) await vectorsGone;
		return { forgotten: true, table, id, message: "Forgotten ✓ (kept as history, can be restored)" };
	},
});
