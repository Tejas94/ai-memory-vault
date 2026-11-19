// Embedding ("meaning search") tests. A fake model and an in-memory index stand in for Workers AI and
// Vectorize (test/fake-vectors.ts). All data is fictional ("Alex" stands for the Vault owner).
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setExtractor } from "../src/graph/extract";
import { forget } from "../src/tools/forget";
import { getContext } from "../src/tools/get_context";
import { saveConversation } from "../src/tools/save_conversation";
import { saveDocument } from "../src/tools/save_document";
import { saveMemory } from "../src/tools/save_memory";
import { saveProject } from "../src/tools/save_project";
import { searchHistory } from "../src/tools/search_history";
import type { ToolContext } from "../src/tools/types";
import { piecesForChat, piecesForText, setEmbedder } from "../src/vectors/embed";
import { fakeEmbedder, memoryIndex, SYNONYMS } from "./fake-vectors";

const rows = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) =>
	env.DB.prepare(sql).bind(...p).all<T>().then((r) => r.results);
const vectorsOf = (type: string, id: string) =>
	[...memoryIndex.values()].filter((v) => v.namespace === type && String(v.metadata.id) === id);
const trackedParts = (type: string, id: string) =>
	rows<{ part: number }>("SELECT part FROM embeddings WHERE active = 1 AND item_type = ? AND item_id = ? ORDER BY part", type, id).then((r) =>
		r.map((x) => x.part),
	);

function backgroundRunner() {
	const work: Promise<unknown>[] = [];
	const ctx: ToolContext = { background: (p) => work.push(p) };
	return { ctx, done: () => Promise.all(work) };
}

beforeEach(() => {
	memoryIndex.clear();
	setExtractor(async () => ({ entities: [], relations: [] })); // the graph isn't under test here
});
afterEach(() => {
	for (const k of Object.keys(SYNONYMS)) delete SYNONYMS[k];
	setEmbedder(fakeEmbedder);
});

describe("splitting items into pieces", () => {
	it("short text is one piece; long text is several overlapping pieces", () => {
		expect(piecesForText("Fact", "Alex likes tea")).toHaveLength(1);
		const long = piecesForText("Document: notes", "word ".repeat(1000));
		expect(long.length).toBeGreaterThan(3);
		for (const p of long) expect(p.text.length).toBeLessThanOrEqual(1500);
		expect(long[1].char_from!).toBeLessThan(long[0].char_to!); // overlap
		expect(long.at(-1)!.char_to).toBe("word ".repeat(1000).trim().length);
	});

	it("never cuts an emoji in half (the model rejects broken characters)", () => {
		const [p] = piecesForChat("Fun", [{ seq: 0, role: "ai", text: `${"a".repeat(199)}😀 and more` }]);
		expect(p.text.isWellFormed()).toBe(true);
		const long = piecesForText("Doc", "😀".repeat(2000));
		for (const piece of long) expect(piece.text.isWellFormed()).toBe(true);
	});

	it("chats keep the owner's words whole and shorten the AI's", () => {
		const pieces = piecesForChat("Trip", [
			{ seq: 0, role: "you", text: "Plan a trip to Kyoto in April" },
			{ seq: 1, role: "ai", text: "x".repeat(900) },
		]);
		expect(pieces).toHaveLength(1);
		expect(pieces[0]).toMatchObject({ seq_from: 0, seq_to: 1 });
		expect(pieces[0].text).toContain("Owner: Plan a trip to Kyoto in April");
		expect(pieces[0].text.length).toBeLessThan(300);
	});
});

describe("every save keeps the index in step", () => {
	it("a new fact is embedded and tracked", async () => {
		const bg = backgroundRunner();
		const saved = (await saveMemory.run(env, "claude", { fact: "Alex wants a Fiat 500", category: "plans" }, bg.ctx)) as any;
		await bg.done();
		expect(vectorsOf("fact", String(saved.id))).toHaveLength(1);
		expect(await trackedParts("fact", String(saved.id))).toEqual([0]);
		const log = await rows("SELECT status FROM graph_log WHERE step = 'embed' AND item_id = ?", String(saved.id));
		expect(log).toEqual([{ status: "ok" }]);
	});

	it("updating a fact removes the old version's vectors", async () => {
		let bg = backgroundRunner();
		const old = (await saveMemory.run(env, "claude", { fact: "Alex drinks green tea", category: "food" }, bg.ctx)) as any;
		await bg.done();
		bg = backgroundRunner();
		const next = (await saveMemory.run(env, "claude", { fact: "Alex drinks black coffee", category: "food", replaces: old.id }, bg.ctx)) as any;
		await bg.done();
		expect(vectorsOf("fact", String(old.id))).toHaveLength(0);
		expect(await trackedParts("fact", String(old.id))).toEqual([]);
		expect(vectorsOf("fact", String(next.id))).toHaveLength(1);
		// the history row stays (retired, never deleted)
		expect(await rows("SELECT active FROM embeddings WHERE item_type = 'fact' AND item_id = ?", String(old.id))).toEqual([{ active: 0 }]);
	});

	it("forgetting removes the vectors", async () => {
		let bg = backgroundRunner();
		const saved = (await saveMemory.run(env, "claude", { fact: "Alex plays chess", category: "hobbies" }, bg.ctx)) as any;
		await bg.done();
		bg = backgroundRunner();
		await forget.run(env, "claude", { id: saved.id }, bg.ctx);
		await bg.done();
		expect(vectorsOf("fact", String(saved.id))).toHaveLength(0);
		expect(await trackedParts("fact", String(saved.id))).toEqual([]);
	});

	it("new messages added to a saved chat get new pieces; the earlier ones stay", async () => {
		let bg = backgroundRunner();
		const chat = (await saveConversation.run(
			env,
			"claude",
			{ title: "Garden", messages: [{ role: "you", text: "Which tomatoes grow well in pots?" }, { role: "ai", text: "Cherry tomatoes." }] },
			bg.ctx,
		)) as any;
		await bg.done();
		bg = backgroundRunner();
		await saveConversation.run(
			env,
			"claude",
			{ title: "Garden", conversation_id: chat.conversation_id, messages: [{ role: "you", text: "And basil?" }] },
			bg.ctx,
		);
		await bg.done();
		expect(await trackedParts("conversation", chat.conversation_id)).toEqual([0, 1]);
		expect(vectorsOf("conversation", chat.conversation_id)).toHaveLength(2);
		const second = await rows("SELECT seq_from, seq_to FROM embeddings WHERE active = 1 AND item_id = ? AND part = 1", chat.conversation_id);
		expect(second).toEqual([{ seq_from: 2, seq_to: 2 }]);
	});

	it("a new document version replaces the old version's vectors", async () => {
		let bg = backgroundRunner();
		const doc = (await saveDocument.run(env, "claude", { name: "notes.txt", content: "word ".repeat(1000), scope: "standalone" }, bg.ctx)) as any;
		await bg.done();
		const before = (await trackedParts("document", doc.document_id)).length;
		expect(before).toBeGreaterThan(1);
		bg = backgroundRunner();
		await saveDocument.run(env, "claude", { document_id: doc.document_id, name: "notes.txt", content: "Short now", scope: "standalone" }, bg.ctx);
		await bg.done();
		expect(await trackedParts("document", doc.document_id)).toEqual([0]);
		expect(vectorsOf("document", doc.document_id)).toHaveLength(1);
	});

	it("projects are embedded too", async () => {
		const bg = backgroundRunner();
		await saveProject.run(env, "claude", { name: "Allotment", description: "Growing vegetables" }, bg.ctx);
		await bg.done();
		expect(vectorsOf("project", "allotment")).toHaveLength(1);
	});

	it("a save replies straight away; the graph and embeddings finish afterwards", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		setExtractor(async () => (await gate, { entities: [], relations: [] })); // a model that is still thinking
		setEmbedder(async (e, texts) => (await gate, fakeEmbedder(e, texts)));
		const bg = backgroundRunner();
		let finished = false;
		const background = bg.ctx.background;
		bg.ctx.background = (w) => background(w.finally(() => (finished = true)));
		const saved = (await saveMemory.run(env, "claude", { fact: "Alex is learning the cello", category: "skills" }, bg.ctx)) as any;
		expect(saved).toMatchObject({ saved: true, message: "Saved ✓" }); // the chat already has its answer…
		expect(finished).toBe(false); // …while the background work is still running
		expect(vectorsOf("fact", String(saved.id))).toHaveLength(0);
		release();
		await bg.done();
		expect(vectorsOf("fact", String(saved.id))).toHaveLength(1);
	});

	it("a failed embedding never breaks the save and is logged", async () => {
		setEmbedder(async () => {
			throw new Error("model down");
		});
		const bg = backgroundRunner();
		const saved = (await saveMemory.run(env, "claude", { fact: "Alex collects stamps", category: "hobbies" }, bg.ctx)) as any;
		await bg.done();
		expect(saved).toMatchObject({ saved: true });
		const log = await rows("SELECT status, detail FROM graph_log WHERE step = 'embed' AND item_id = ?", String(saved.id));
		expect(log).toEqual([{ status: "failed", detail: "model down" }]);
	});
});

describe("searching by meaning", () => {
	it("get_context finds a fact that shares no words with the question", async () => {
		SYNONYMS.car = "fiat"; // the fake model treats "car" and "Fiat" as the same idea
		const bg = backgroundRunner();
		const saved = (await saveMemory.run(env, "claude", { fact: "Alex dreams of a Fiat", category: "plans" }, bg.ctx)) as any;
		await bg.done();
		const ctx = (await getContext.run(env, "claude", { topic: "car" })) as any;
		expect(ctx.facts.map((f: any) => f.id)).toContain(saved.id);
	});

	it("search_history adds chats found by meaning and says so", async () => {
		SYNONYMS.car = "fiat";
		const bg = backgroundRunner();
		const chat = (await saveConversation.run(env, "claude", { title: "Fiat", messages: [{ role: "you", text: "Fiat 500" }] }, bg.ctx)) as any;
		await bg.done();
		const found = (await searchHistory.run(env, "claude", { query: "car" })) as any;
		const hit = found.messages.find((m: any) => m.conversation_id === chat.conversation_id);
		expect(hit).toMatchObject({ found_by: "meaning" });
		expect(found.matched).toContain("meaning");
	});

	it("searches still work by keyword when the model is unavailable", async () => {
		const bg = backgroundRunner();
		const saved = (await saveMemory.run(env, "claude", { fact: "Alex owns a kayak", category: "hobbies" }, bg.ctx)) as any;
		await bg.done();
		setEmbedder(async () => {
			throw new Error("model down");
		});
		const ctx = (await getContext.run(env, "claude", { topic: "kayak" })) as any;
		expect(ctx.facts.map((f: any) => f.id)).toContain(saved.id);
	});
});
