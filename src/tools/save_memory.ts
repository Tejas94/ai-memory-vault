import { z } from "zod";
import { cleanText, first, now } from "../db";
import { afterSave } from "../sync";
import { defineTool, ToolError } from "./types";

export const CATEGORIES = [
	"identity",
	"work",
	"goals",
	"plans",
	"preferences",
	"people",
	"projects",
	"skills",
	"other",
] as const;

const MAX_FACT = 300;
// Long digit runs look like card / bank / ID numbers, which Vault must never store.
const LOOKS_SECRET = /(?:\d[ -]?){13,19}/;

export const saveMemory = defineTool({
	name: "save_memory",
	description:
		'Save one short fact about the user to Vault (use when they say "Save to Vault", or share something lasting and new: ' +
		"location, job, decisions, preferences, plans). To change an existing fact, pass its id from get_context as " +
		'`replaces` ("Update Vault: …"); the old version is kept as history. One fact per call, max 300 characters. ' +
		"Never save passwords, card/bank numbers, ID numbers or other secrets.",
	inputSchema: {
		fact: z.string().describe("The fact, one short sentence, e.g. 'Prefers window seats on long journeys'."),
		category: z.enum(CATEGORIES),
		kind: z
			.enum(["lasting", "temporary"])
			.optional()
			.describe("temporary = only true for a while (set `expires`). Default lasting."),
		replaces: z.number().int().optional().describe("Fact id this new version replaces."),
		project_id: z.string().optional().describe("Project slug, if the fact belongs to a project."),
		expires: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}/, "Use an ISO date like 2026-12-31")
			.optional()
			.describe("ISO date when a temporary fact stops being true."),
	},
	async run(env, source, input, ctx) {
		const fact = cleanText(input.fact);
		if (!fact) throw new ToolError("fact is empty.");
		if (fact.length > MAX_FACT) throw new ToolError(`fact is ${fact.length} characters; shorten it to ${MAX_FACT}.`);
		if (LOOKS_SECRET.test(fact)) throw new ToolError("This looks like a card, bank or ID number. Vault does not store those.");

		const kind = input.expires ? "temporary" : (input.kind ?? "lasting");
		const ts = now();

		if (input.replaces === undefined) {
			// No duplicates: an identical current fact is returned as-is
			const same = await first<{ row_id: number }>(
				env.DB,
				"SELECT row_id FROM facts WHERE active = 1 AND lower(fact) = lower(?) LIMIT 1",
				fact,
			);
			if (same) return { saved: true, id: same.row_id, duplicate: true, message: "Already in Vault ✓" };

			const res = await env.DB.prepare(
				"INSERT INTO facts (fact, category, kind, project_id, source, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
				.bind(fact, input.category, kind, input.project_id ?? null, source, ts, input.expires ?? null)
				.run();
			const id = res.meta.last_row_id;
			afterSave(env, ctx, { type: "fact", id: String(id) }, fact);
			return { saved: true, id, message: "Saved ✓" };
		}

		const old = await first<{ project_id: string | null }>(
			env.DB,
			"SELECT project_id FROM facts WHERE row_id = ? AND active = 1",
			input.replaces,
		);
		if (!old) throw new ToolError(`No current fact with id ${input.replaces}. Call get_context to see current ids.`);

		// Deactivate the old version and insert the new one atomically
		const [, inserted] = await env.DB.batch([
			env.DB.prepare("UPDATE facts SET active = 0, deactivated = ? WHERE row_id = ? AND active = 1").bind(
				ts,
				input.replaces,
			),
			env.DB.prepare(
				"INSERT INTO facts (fact, category, kind, project_id, source, replaces_id, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).bind(
				fact,
				input.category,
				kind,
				input.project_id ?? old.project_id,
				source,
				input.replaces,
				ts,
				input.expires ?? null,
			),
		]);
		// The old fact's links were retired by a database trigger; the new fact gets its own
		const id = inserted.meta.last_row_id;
		// …and the old version's vectors leave the search index
		afterSave(env, ctx, { type: "fact", id: String(id) }, fact, { replaced: { type: "fact", id: String(input.replaces) } });
		return { saved: true, id, replaced: input.replaces, message: "Saved ✓" };
	},
});
