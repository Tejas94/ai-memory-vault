import { z } from "zod";
import { first, now, retire } from "../db";
import { afterSave } from "../sync";
import { defineTool, ToolError } from "./types";

const MAX_SECTION = 4_000; // characters; the whole profile should stay under ~400 words

export const updateProfile = defineTool({
	name: "update_profile",
	description:
		"Rewrite one section of the user's profile (about / work / preferences / current_focus) with the full new text. " +
		"The old version is kept as history. Use for broad summaries; single facts go to save_memory.",
	inputSchema: {
		section: z.enum(["about", "work", "preferences", "current_focus"]),
		content: z.string().describe("The complete new text for this section."),
	},
	async run(env, source, { section, content }, ctx) {
		const text = content.trim();
		if (!text) throw new ToolError("content is empty.");
		if (text.length > MAX_SECTION) throw new ToolError(`content is ${text.length} characters; keep it under ${MAX_SECTION}.`);

		const old = await first<{ row_id: number }>(
			env.DB,
			"SELECT row_id FROM profile WHERE section = ? AND active = 1",
			section,
		);
		const insert = env.DB.prepare(
			"INSERT INTO profile (section, content, source, replaces_id, created) VALUES (?, ?, ?, ?, ?)",
		).bind(section, text, source, old?.row_id ?? null, now());
		await (old ? env.DB.batch([retire(env.DB, "profile", "section = ?", section), insert]) : insert.run());
		afterSave(env, ctx, { type: "profile", id: section }, `Owner's profile, ${section}: ${text}`, { replaceOrigin: true });
		return { section, updated: !!old, message: "Saved ✓" };
	},
});
