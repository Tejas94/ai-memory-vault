// get_context: format, no duplicates, categories, short topics and the time budget.
// All data is fictional ("Alex" stands for the Vault owner).
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { writeGraph } from "../src/graph/write";
import { explore } from "../src/tools/explore";
import { formatContext, getContext, setBudget, setShortMinScore } from "../src/tools/get_context";
import { saveConversation } from "../src/tools/save_conversation";
import { searchHistory } from "../src/tools/search_history";
import { embedItem, setEmbedder, setMinScore } from "../src/vectors/embed";
import { fakeEmbedder, SYNONYMS } from "./fake-vectors";

const addFact = async (id: number, fact: string, created = "2026-03-01T10:00:00.000Z") => {
	await env.DB.prepare("INSERT INTO facts (row_id, fact, category, created) VALUES (?, ?, 'other', ?)").bind(id, fact, created).run();
	await embedItem(env, { type: "fact", id: String(id) }, [{ text: fact }]);
};
const ids = (ctx: any) => ctx.facts.map((f: any) => f.id);

afterEach(() => {
	setBudget(1_000);
	setShortMinScore(0.45);
	setMinScore(0.45);
	setEmbedder(fakeEmbedder);
	for (const k of Object.keys(SYNONYMS)) delete SYNONYMS[k];
});

describe("what get_context sends", () => {
	it("Markdown key-value lines with id and date; empty sections left out", () => {
		const text = formatContext({
			profile: {},
			facts: [{ id: 7, fact: "Alex likes tea", date: "2026-03-01" }],
			connections: ["Alex → lives_in → Leeds [chat c1]"],
			projects: [{ id: "garden", name: "Garden", status: "active" }],
			reminder: "Save new things.",
		});
		expect(text).toBe(
			[
				"## Facts",
				"- id: 7 · date: 2026-03-01 · fact: Alex likes tea",
				"",
				"## Connections",
				"- Alex → lives_in → Leeds [chat c1]",
				"",
				"## Projects",
				"- Garden · id: garden · status: active",
				"",
				"Save new things.",
			].join("\n"),
		);
		expect(text).not.toMatch(/Profile|[{}"]/); // no empty profile, no JSON punctuation
	});

	it("the same fact saved twice appears once", async () => {
		await addFact(9601, "Alex plays the ukulele");
		await addFact(9602, "Alex plays the ukulele!");
		const ctx = (await getContext.run(env, "claude", { topic: "ukulele" })) as any;
		expect(ids(ctx).filter((id: number) => id === 9601 || id === 9602)).toHaveLength(1);
	});
});

describe("categories (is_a)", () => {
	it("a thing filed under a category is found by the category word", async () => {
		await addFact(9611, "Alex wants a Fiat Panda by summer");
		await writeGraph(
			env.DB,
			{
				entities: [{ name: "Fiat Panda", type: "thing" }],
				relations: [
					{ from: "me", relation: "wants", to: "Fiat Panda", value: "by summer" },
					{ from: "Fiat Panda", relation: "is_a", to: "cars" }, // plural is fine: filed under "Car"
				],
			},
			{ type: "fact", id: "9611" },
			{ source: "test" },
		);
		const cat = await env.DB.prepare("SELECT name, type FROM entities WHERE id = 'topic:car' AND active = 1").first();
		expect(cat).toEqual({ name: "Car", type: "topic" });

		// "car rental" shares no word with the fact and no meaning match is set up: only the category finds it
		const ctx = (await getContext.run(env, "claude", { topic: "car rental" })) as any;
		expect(ids(ctx)).toContain(9611);
		expect((ctx.connections ?? []).join("\n")).not.toMatch(/is_a/); // category links are not shown as connections

		const ex = (await explore.run(env, "claude", { name: "vehicles" })) as any;
		expect(JSON.stringify(ex)).toMatch(/Fiat Panda → is_a → Car/);
	});

	it("a thing whose name is also a category word is still filed (Trains → Transport)", async () => {
		const r = await writeGraph(
			env.DB,
			{ entities: [{ name: "Trains", type: "thing" }], relations: [{ from: "Trains", relation: "is_a", to: "transport" }] },
			{ type: "fact", id: "9613" },
			{ source: "test" },
		);
		expect(r.relations_added).toBe(1);
		const link = await env.DB.prepare("SELECT from_id, to_id FROM relations WHERE active = 1 AND relation = 'is_a' AND origin_id = '9613'").first();
		expect(link).toEqual({ from_id: "thing:trains", to_id: "topic:transport" });
	});

	it("a category not on the list is skipped and noted for review", async () => {
		const r = await writeGraph(
			env.DB,
			{ entities: [{ name: "Blue Kettle", type: "thing" }], relations: [{ from: "Blue Kettle", relation: "is_a", to: "kitchen appliance" }] },
			{ type: "fact", id: "9612" },
			{ source: "test" },
		);
		expect(r.relations_added).toBe(0);
		expect(r.review.join(" ")).toMatch(/kitchen appliance.*not on the list/);
	});
});

describe("short topics", () => {
	it("one or two words: a meaning-only match must be strong", async () => {
		SYNONYMS.automobile = "fiat";
		setMinScore(0.2);
		await addFact(9621, "Alex dreams about owning a Fiat");
		setShortMinScore(0.99); // stricter than any fake score
		expect(ids(await getContext.run(env, "claude", { topic: "automobile" }))).not.toContain(9621);
		setShortMinScore(0.3);
		expect(ids(await getContext.run(env, "claude", { topic: "automobile" }))).toContain(9621);
		// a longer topic uses the normal cut-off
		setShortMinScore(0.99);
		expect(ids(await getContext.run(env, "claude", { topic: "thinking about an automobile soon" }))).toContain(9621);
	});
});

describe("time budget", () => {
	it("a slow search is left out, the rest still comes back, and the reply says so", async () => {
		await addFact(9631, "Alex keeps bees on the roof");
		setBudget(100);
		setEmbedder(async (e, texts) => {
			await new Promise((r) => setTimeout(r, 600)); // meaning search far too slow
			return fakeEmbedder(e, texts);
		});
		const started = Date.now();
		const ctx = (await getContext.run(env, "claude", { topic: "bees" })) as any;
		expect(Date.now() - started).toBeLessThan(500);
		expect(ids(ctx)).toContain(9631); // keyword search found it in time
		expect(ctx.skipped).toEqual(["meaning"]);
		expect(formatContext(ctx)).toMatch(/left out because it was slow or unavailable this time: meaning search/);
	});

	it("a search that fails is left out too; the others still answer", async () => {
		await addFact(9632, "Alex grows chillies");
		setEmbedder(async () => {
			throw new Error("model down");
		});
		const ctx = (await getContext.run(env, "claude", { topic: "chillies" })) as any;
		expect(ids(ctx)).toContain(9632);
		expect(ctx.skipped).toEqual(["meaning"]);
	});

	it("search_history: a slow meaning search is left out; keyword hits still come back", async () => {
		await saveConversation.run(env, "claude", { title: "Beekeeping", messages: [{ role: "you", text: "How do I start beekeeping on a roof?" }] });
		setBudget(100);
		setEmbedder(async (e, texts) => {
			await new Promise((r) => setTimeout(r, 600));
			return fakeEmbedder(e, texts);
		});
		const found = (await searchHistory.run(env, "claude", { query: "beekeeping" })) as any;
		expect(found.messages.map((m: any) => m.title)).toContain("Beekeeping");
		expect(found.left_out).toMatch(/^meaning search/);
	});
});
