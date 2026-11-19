// Knowledge graph tests. All data is fictional ("Alex" stands for the Vault owner).
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { aiExtract, setExtractor, splitForModel } from "../src/graph/extract";
import { findMentioned } from "../src/graph/read";
import { writeGraph } from "../src/graph/write";
import { explore } from "../src/tools/explore";
import { forget } from "../src/tools/forget";
import { getContext } from "../src/tools/get_context";
import { saveConversation } from "../src/tools/save_conversation";
import { saveDocument } from "../src/tools/save_document";
import { saveMemory } from "../src/tools/save_memory";
import type { ToolContext } from "../src/tools/types";

const rows = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) =>
	env.DB.prepare(sql).bind(...p).all<T>().then((r) => r.results);
const activeLinks = (from: string) =>
	rows<{ relation: string; to_id: string | null; value: string | null; replaces_id: number | null; origin_id: string }>(
		"SELECT relation, to_id, value, replaces_id, origin_id FROM relations WHERE active = 1 AND from_id = ? ORDER BY row_id",
		from,
	);

/** Runs background work and lets the test wait for it, like the Durable Object does in production. */
function backgroundRunner() {
	const work: Promise<unknown>[] = [];
	const ctx: ToolContext = { background: (p) => work.push(p) };
	return { ctx, done: () => Promise.all(work) };
}

/** A fake model: returns the graph listed for the first key found in the text. */
function fakeModel(answers: Record<string, unknown>) {
	setExtractor(async (_env, text) => {
		const key = Object.keys(answers).find((k) => text.includes(k));
		if (!key) return { entities: [], relations: [] };
		const a = answers[key];
		if (a instanceof Error) throw a;
		return a;
	});
}
afterEach(() => setExtractor(aiExtract));

const origin = (id: string) => ({ type: "fact" as const, id });

describe("graph writer", () => {
	it("creates entities, names and links, and is safe to run twice", async () => {
		const g = {
			entities: [{ name: "Priya", type: "person", aliases: ["my sister", "Pri"] }, { name: "Manchester", type: "place" }],
			relations: [
				{ from: "me", relation: "relative_of", to: "Priya", value: "sister" },
				{ from: "Priya", relation: "lives_in", to: "Manchester" },
			],
		};
		const first = await writeGraph(env.DB, g, origin("9001"), { source: "test" });
		expect(first).toMatchObject({ entities_created: 2, relations_added: 2 });

		const again = await writeGraph(env.DB, g, origin("9001"), { source: "test" });
		expect(again).toMatchObject({ entities_created: 0, names_added: 0, relations_added: 0, skipped_relations: 2 });
		expect(await activeLinks("person:priya")).toHaveLength(1);
	});

	it("reuses an entity found by alias instead of creating a duplicate", async () => {
		const r = await writeGraph(
			env.DB,
			{ entities: [{ name: "my sister", type: "person" }], relations: [{ from: "my sister", relation: "uses", value: "Kindle" }] },
			origin("9002"),
			{ source: "test" },
		);
		expect(r.entities_created).toBe(0);
		expect((await activeLinks("person:priya")).map((l) => l.relation)).toContain("uses");
	});

	it("a new value for a single relation retires the old one (moving city)", async () => {
		await writeGraph(
			env.DB,
			{ entities: [{ name: "Leeds", type: "place" }], relations: [{ from: "Priya", relation: "lives_in", to: "Leeds" }] },
			origin("9003"),
			{ source: "test" },
		);
		const lives = (await activeLinks("person:priya")).filter((l) => l.relation === "lives_in");
		expect(lives).toHaveLength(1);
		expect(lives[0]).toMatchObject({ to_id: "place:leeds" });
		expect(lives[0].replaces_id).not.toBeNull();
		const old = await rows("SELECT active FROM relations WHERE row_id = ?", lives[0].replaces_id);
		expect(old[0]).toMatchObject({ active: 0 });
	});

	it("multi relations add up; unknown relations become 'other' and are flagged for review", async () => {
		const r = await writeGraph(
			env.DB,
			{
				entities: [{ name: "Sam", type: "person" }, { name: "Jo", type: "person" }],
				relations: [
					{ from: "me", relation: "friend_of", to: "Sam" },
					{ from: "me", relation: "friend_of", to: "Jo" },
					{ from: "me", relation: "admires", to: "Jo" },
				],
			},
			origin("9004"),
			{ source: "test" },
		);
		expect(r.relations_added).toBe(3);
		expect(r.review.join(" ")).toMatch(/unknown relation "admires"/);
		const mine = await activeLinks("person:me");
		expect(mine.filter((l) => l.relation === "friend_of")).toHaveLength(2);
		expect(mine.find((l) => l.relation === "other")).toMatchObject({ to_id: "person:jo", value: "admires" });
	});

	it("never deletes or edits links in place", async () => {
		await expect(env.DB.prepare("DELETE FROM relations").run()).rejects.toThrow(/never deletes/);
		await expect(env.DB.prepare("UPDATE relations SET to_id = 'x'").run()).rejects.toThrow(/never edits/);
	});
});

describe("auto-update after saves", () => {
	it("save_memory replies first, then the graph gets the fact's links", async () => {
		fakeModel({
			"Lumen Pad": {
				entities: [{ name: "Lumen Pad", type: "thing" }],
				relations: [{ from: "me", relation: "wants", to: "Lumen Pad", value: "64GB" }],
			},
		});
		const bg = backgroundRunner();
		const saved = (await saveMemory.run(env, "claude", { fact: "Alex wants a Lumen Pad, 64GB", category: "plans" }, bg.ctx)) as any;
		expect(saved).toMatchObject({ saved: true });
		await bg.done();
		const links = await rows("SELECT * FROM relations WHERE active = 1 AND origin_type = 'fact' AND origin_id = ?", String(saved.id));
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({ to_id: "thing:lumen-pad", source: "graph_auto" });
	});

	it("Update Vault: the old fact's links are retired by the database, the new fact's links added", async () => {
		fakeModel({
			"512GB": {
				entities: [{ name: "Lumen Pad", type: "thing" }],
				relations: [{ from: "me", relation: "wants", to: "Lumen Pad", value: "512GB" }],
			},
		});
		const old = await rows<{ row_id: number }>("SELECT row_id FROM facts WHERE active = 1 AND fact LIKE '%Lumen Pad%'");
		const bg = backgroundRunner();
		const neu = (await saveMemory.run(
			env,
			"claude",
			{ fact: "Alex now wants a Lumen Pad with 512GB", category: "plans", replaces: old[0].row_id },
			bg.ctx,
		)) as any;
		await bg.done();
		const wants = (await activeLinks("person:me")).filter((l) => l.relation === "wants");
		expect(wants).toHaveLength(1);
		expect(wants[0]).toMatchObject({ value: "512GB", origin_id: String(neu.id) });
	});

	it("a failed model call never breaks the save and is logged", async () => {
		fakeModel({ oboe: new Error("model down") });
		const bg = backgroundRunner();
		const saved = (await saveMemory.run(env, "chatgpt", { fact: "Alex is learning the oboe", category: "skills" }, bg.ctx)) as any;
		await bg.done();
		expect(saved).toMatchObject({ saved: true });
		const log = await rows("SELECT step, status, detail FROM graph_log WHERE item_type = 'fact' AND item_id = ? AND step = 'extract'", String(saved.id));
		expect(log[0]).toMatchObject({ step: "extract", status: "failed", detail: "model down" });
	});

	it("bad items from the model are dropped, good ones kept", async () => {
		fakeModel({
			Kyoto: {
				entities: [{ name: "Kyoto", type: "place" }, { name: "", type: "place" }, { name: "X", type: "planet" }],
				relations: [{ from: "me", relation: "plans", to: "Kyoto", value: "trip in April" }, { from: "me" }],
			},
		});
		const bg = backgroundRunner();
		const saved = (await saveMemory.run(env, "claude", { fact: "Alex plans a Kyoto trip in April", category: "plans" }, bg.ctx)) as any;
		await bg.done();
		const links = await rows("SELECT to_id FROM relations WHERE active = 1 AND origin_id = ?", String(saved.id));
		expect(links).toEqual([{ to_id: "place:kyoto" }]);
	});

	it("chats are linked, and forgetting a chat retires its links", async () => {
		fakeModel({
			"car hire": {
				entities: [{ name: "Bologna", type: "place" }, { name: "Fiat Panda", type: "thing" }],
				relations: [
					{ from: "me", relation: "uses", to: "Fiat Panda", value: "rented in Bologna" },
					{ from: "Fiat Panda", relation: "located_in", to: "Bologna" },
				],
			},
		});
		const bg = backgroundRunner();
		const chat = (await saveConversation.run(
			env,
			"chatgpt",
			{ title: "Bologna car hire", messages: [{ role: "user", text: "How much is car hire for a Fiat in Bologna?" }] },
			bg.ctx,
		)) as any;
		await bg.done();
		const linked = () => rows("SELECT 1 FROM relations WHERE active = 1 AND origin_type = 'conversation' AND origin_id = ?", chat.conversation_id);
		expect(await linked()).toHaveLength(2);
		await forget.run(env, "claude", { id: chat.conversation_id, table: "conversations" });
		expect(await linked()).toHaveLength(0);
	});

	it("a new document version drops the links it no longer states", async () => {
		fakeModel({
			"v1 lease": {
				entities: [{ name: "Flat 4B", type: "place" }, { name: "Acme Lettings", type: "organisation" }],
				relations: [
					{ from: "me", relation: "lives_in", to: "Flat 4B" },
					{ from: "Flat 4B", relation: "part_of", to: "Acme Lettings" },
				],
			},
			"v2 lease": {
				entities: [{ name: "Flat 4B", type: "place" }],
				relations: [{ from: "me", relation: "lives_in", to: "Flat 4B" }],
			},
		});
		const bg = backgroundRunner();
		const doc = (await saveDocument.run(env, "claude", { name: "lease.pdf", content: "v1 lease text", scope: "standalone" }, bg.ctx)) as any;
		await bg.done();
		const bg2 = backgroundRunner();
		await saveDocument.run(
			env,
			"claude",
			{ name: "lease.pdf", content: "v2 lease text", scope: "standalone", document_id: doc.document_id },
			bg2.ctx,
		);
		await bg2.done();
		const left = await rows<{ relation: string }>(
			"SELECT relation FROM relations WHERE active = 1 AND origin_type = 'document' AND origin_id = ?",
			doc.document_id,
		);
		expect(left.map((l) => l.relation)).toEqual(["lives_in"]);
	});
});

describe("reading the graph", () => {
	it("explore follows a chain two steps: sister → Priya → Leeds → rail strike", async () => {
		await writeGraph(
			env.DB,
			{
				entities: [{ name: "Leeds", type: "place" }, { name: "Rail strike", type: "event" }],
				relations: [{ from: "Rail strike", relation: "located_in", to: "Leeds" }, { from: "Rail strike", relation: "happened_on", value: "Friday" }],
			},
			origin("9005"),
			{ source: "test" },
		);
		const one = (await explore.run(env, "claude", { name: "my sister" })) as any;
		expect(one.entities[0]).toMatchObject({ name: "Priya" });
		expect(one.links).toContain("Priya → lives_in → Leeds [fact 9003]");
		expect(one.links.join("\n")).not.toMatch(/Rail strike/);

		const two = (await explore.run(env, "claude", { name: "my sister", depth: 2 })) as any;
		expect(two.links).toContain("Rail strike → located_in → Leeds [fact 9005]");
	});

	it("explore finds partial names and says clearly when nothing matches", async () => {
		const part = (await explore.run(env, "claude", { name: "lumen" })) as any;
		expect(part.entities[0]).toMatchObject({ name: "Lumen Pad" });
		const none = (await explore.run(env, "claude", { name: "Zanzibar" })) as any;
		expect(none).toMatchObject({ found: false });
	});

	it("names are found inside a longer topic; the owner is never a starting point", async () => {
		const ids = await findMentioned(env.DB, "is my sister affected by the strike?");
		expect(ids).toContain("person:priya");
		expect(ids).not.toContain("person:me");
	});

	it("get_context with a topic: graph connections and linked facts, no unrelated padding", async () => {
		await env.DB.batch([
			env.DB.prepare("INSERT INTO facts (row_id, fact, category, created) VALUES (9003, 'Priya moved to Leeds', 'people', '2026-01-01')"),
			env.DB.prepare("INSERT INTO facts (fact, category, created) VALUES ('Alex collects postcards', 'preferences', '2099-01-01')"),
		]);
		const ctx = (await getContext.run(env, "claude", { topic: "my sister" })) as any;
		expect(ctx.facts.map((f: any) => f.fact)).toContain("Priya moved to Leeds");
		// no duplicates: a link whose fact is already listed is not repeated as a connection
		expect(ctx.connections ?? []).not.toContain("Priya → lives_in → Leeds [fact 9003]");
		expect(JSON.stringify(ctx.facts)).not.toMatch(/postcards/);

		const plain = (await getContext.run(env, "claude", {})) as any;
		expect(plain.facts[0].fact).toMatch(/postcards/); // no topic: newest facts, as before
		expect(plain.connections).toBeUndefined();
	});

	it("get_context stays within its size budget", async () => {
		const small = (await getContext.run(env, "claude", { topic: "my sister Lumen Pad Kyoto oboe", max_tokens: 100 })) as any;
		const size = small.facts.reduce((n: number, f: any) => n + f.fact.length + 30, 0) + (small.connections ?? []).join("   ").length;
		expect(size).toBeLessThanOrEqual(100 * 4 + 300); // at least one fact is always kept
	});
});

describe("keeping the graph current (dates, facts first, leftovers)", () => {
	const chat = (id: string) => ({ type: "conversation" as const, id });
	const livesIn = (city: string) => ({
		entities: [{ name: city, type: "place" }],
		relations: [{ from: "me", relation: "lives_in", to: city }],
	});
	const current = async () =>
		(await activeLinks("person:me")).filter((l) => l.relation === "lives_in").map((l) => l.to_id);

	it("a chat never overwrites a one-value link that comes from a fact; it is kept as history", async () => {
		await writeGraph(env.DB, livesIn("Bristol"), origin("9101"), { source: "test" });
		const r = await writeGraph(env.DB, livesIn("Cardiff"), chat("conv:old-cardiff"), { source: "test", asOf: "2030-01-01" });
		expect(r).toMatchObject({ relations_added: 0, kept_as_history: 1 });
		expect(r.review.join()).toMatch(/current value comes from a fact/);
		expect(await current()).toEqual(["place:bristol"]);
		const hist = await rows("SELECT active FROM relations WHERE origin_id = 'conv:old-cardiff' AND relation = 'lives_in'");
		expect(hist).toEqual([{ active: 0 }]);
		// running the same chat again doesn't store the history line twice
		await writeGraph(env.DB, livesIn("Cardiff"), chat("conv:old-cardiff"), { source: "test", asOf: "2030-01-01" });
		expect(await rows("SELECT 1 FROM relations WHERE origin_id = 'conv:old-cardiff'")).toHaveLength(1);
		// a new fact still wins
		await writeGraph(env.DB, livesIn("Cardiff"), origin("9102"), { source: "test" });
		expect(await current()).toEqual(["place:cardiff"]);
	});

	it("older information never replaces newer: an old chat loses, a newer one wins", async () => {
		const worksAt = (org: string) => ({
			entities: [{ name: "Sam", type: "person" }, { name: org, type: "organisation" }],
			relations: [{ from: "Sam", relation: "works_at", to: org }],
		});
		await writeGraph(env.DB, worksAt("Acme"), chat("conv:2026"), { source: "test", asOf: "2026-06-01" });
		const old = await writeGraph(env.DB, worksAt("Globex"), chat("conv:2024"), { source: "test", asOf: "2024-03-01" });
		expect(old).toMatchObject({ relations_added: 0, kept_as_history: 1 });
		const newer = await writeGraph(env.DB, worksAt("Initech"), chat("conv:2027"), { source: "test", asOf: "2027-01-01" });
		expect(newer).toMatchObject({ relations_added: 1, relations_retired: 1 });
		expect((await activeLinks("person:sam")).map((l) => l.to_id)).toEqual(["organisation:initech"]);
	});

	it("chats are read from both sides, with the chat's date, and long chats in parts", async () => {
		const seen: string[] = [];
		setExtractor(async (_env, text) => {
			seen.push(text);
			return { entities: [], relations: [] };
		});
		const bg = backgroundRunner();
		await saveConversation.run(
			env,
			"claude",
			{
				title: "Project Lantern",
				messages: [
					{ role: "user", text: "Should Lantern store data in a graph?", time: "2026-02-01T10:00:00Z" },
					{ role: "assistant", text: "Agreed: Lantern stores links in a graph, vectors later.", time: "2026-02-01T10:01:00Z" },
				],
			},
			bg.ctx,
		);
		await bg.done();
		expect(seen[0]).toMatch(/Owner: Should Lantern/);
		expect(seen[0]).toMatch(/AI: Agreed: Lantern stores links/);

		const long = ["Chat: long", ...Array.from({ length: 60 }, (_, i) => `Owner: question ${i} ${"x".repeat(200)}`), `AI: ${"y".repeat(5000)}`].join("\n");
		const { parts, total } = splitForModel(long, 2, 6000);
		expect(parts.length).toBeLessThanOrEqual(2);
		expect(total).toBeGreaterThanOrEqual(2);
		for (const p of parts) {
			expect(p.length).toBeLessThanOrEqual(6000);
			expect(p.startsWith("Chat: long")).toBe(true);
		}
		expect(parts.join("").includes("y".repeat(400))).toBe(false); // the AI's long reply was shortened
	});

	it("a long chat that doesn't fit is logged as partly read", async () => {
		setExtractor(async () => ({ entities: [], relations: [] }));
		const bg = backgroundRunner();
		const many = Array.from({ length: 40 }, (_, i) => ({ role: "user", text: `point ${i} ${"z".repeat(900)}` }));
		const saved = (await saveConversation.run(env, "claude", { title: "very long", messages: many }, bg.ctx)) as any;
		await bg.done();
		const log = await rows("SELECT step, status, detail FROM graph_log WHERE item_id = ? AND step = 'extract'", saved.conversation_id);
		expect(log[0]).toMatchObject({ status: "skipped" });
		expect(String(log[0].detail)).toMatch(/read 4 of \d+ parts/);
	});

	it("forgetting the last item that mentions someone retires them too (the owner always stays)", async () => {
		const bg = backgroundRunner();
		fakeModel({
			Wendell: { entities: [{ name: "Wendell", type: "person", aliases: ["my landlord"] }], relations: [{ from: "me", relation: "knows", to: "Wendell", value: "landlord" }] },
		});
		const saved = (await saveMemory.run(env, "claude", { fact: "Alex's landlord is Wendell", category: "people" }, bg.ctx)) as any;
		await bg.done();
		expect(await rows("SELECT 1 FROM entities WHERE id = 'person:wendell' AND active = 1")).toHaveLength(1);
		await forget.run(env, "claude", { id: saved.id });
		expect(await rows("SELECT 1 FROM entities WHERE id = 'person:wendell' AND active = 1")).toHaveLength(0);
		expect(await rows("SELECT 1 FROM entity_names WHERE entity_id = 'person:wendell' AND active = 1")).toHaveLength(0);
		expect(await rows("SELECT 1 FROM entities WHERE id = 'person:me' AND active = 1")).toHaveLength(1);
		// mentioned again later: comes back as a fresh entity
		await writeGraph(env.DB, { entities: [{ name: "Wendell", type: "person" }], relations: [{ from: "me", relation: "knows", to: "Wendell" }] }, origin("9103"), { source: "test" });
		expect(await rows("SELECT 1 FROM entities WHERE id = 'person:wendell' AND active = 1")).toHaveLength(1);
	});

	it("get_context returns the facts behind what the graph finds, even with no shared words", async () => {
		await env.DB.prepare("INSERT INTO facts (row_id, fact, category, created) VALUES (9201, 'Her knee surgery went well in March', 'people', '2026-01-02')").run();
		await writeGraph(
			env.DB,
			{ entities: [{ name: "Rosa", type: "person", aliases: ["gran", "my grandmother"] }], relations: [{ from: "Rosa", relation: "health", value: "knee surgery, March" }] },
			origin("9201"),
			{ source: "test" },
		);
		const ctx = (await getContext.run(env, "claude", { topic: "gran" })) as any;
		expect(ctx.facts.map((f: any) => f.id)).toContain(9201);
	});

	it("questions about the owner use the owner's own links (where do I live)", async () => {
		await env.DB.prepare("INSERT INTO facts (row_id, fact, category, created) VALUES (9102, 'Alex moved to Cardiff', 'identity', '2026-01-03')").run();
		const ctx = (await getContext.run(env, "claude", { topic: "where do I live" })) as any;
		expect(ctx.facts.map((f: any) => f.id)).toContain(9102);
	});
});
