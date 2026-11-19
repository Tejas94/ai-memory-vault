import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { getContext, REMINDER } from "../src/tools/get_context";
import { saveMemory } from "../src/tools/save_memory";
import { searchHistory } from "../src/tools/search_history";
import { newServer, registerTools } from "../src/mcp";

const facts = (sql: string, ...p: unknown[]) => env.DB.prepare(sql).bind(...p).all<Record<string, unknown>>();

async function seedHistory() {
	const ts = "2024-05-01T10:00:00Z";
	const rows = [
		"Hi there",
		"Hello! How can I help?",
		"How much is renting a Fiat in Bologna for a week?",
		"Renting a Fiat Panda is about €400 a week.",
		"Thanks, and insurance?",
		"Insurance adds about €100.",
	];
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO conversations (id, title, source, created, saved) VALUES ('chatgpt:abc', 'Car hire Bologna', 'import_chatgpt', ?, ?)",
		).bind(ts, ts),
		...rows.map((text, seq) =>
			env.DB.prepare(
				"INSERT INTO messages (conversation_id, seq, role, time, text, source, created) VALUES ('chatgpt:abc', ?, ?, ?, ?, 'import_chatgpt', ?)",
			).bind(seq, seq % 2 ? "ai" : "you", ts, text, ts),
		),
		env.DB.prepare(
			"INSERT INTO documents (doc_id, name, scope, content, source, created) VALUES ('doc:1', 'trip-notes.md', 'standalone', 'Packing list for the Bologna trip: passport, charger.', 'claude', ?)",
		).bind(ts),
	]);
}

describe("save_memory", () => {
	it("saves a fact stamped with the server-side source", async () => {
		const r = (await saveMemory.run(env, "claude", { fact: "  I prefer   window seats ", category: "preferences" })) as any;
		expect(r).toMatchObject({ saved: true, message: "Saved ✓" });
		const { results } = await facts("SELECT * FROM facts WHERE row_id = ?", r.id);
		expect(results[0]).toMatchObject({ fact: "I prefer window seats", source: "claude", active: 1, kind: "lasting" });
	});

	it("does not duplicate an identical fact", async () => {
		const a = (await saveMemory.run(env, "claude", { fact: "Alex lives in Northvale", category: "identity" })) as any;
		const b = (await saveMemory.run(env, "chatgpt", { fact: "alex lives  in northvale", category: "identity" })) as any;
		expect(b).toMatchObject({ id: a.id, duplicate: true });
	});

	it("Update Vault: replaces keeps history and only the new version is current (Test D)", async () => {
		const old = (await saveMemory.run(env, "claude", { fact: "Alex lives in Leeds", category: "identity" })) as any;
		const neu = (await saveMemory.run(env, "chatgpt", {
			fact: "Alex has moved to Manchester",
			category: "identity",
			replaces: old.id,
		})) as any;

		const { results } = await facts("SELECT row_id, active, replaces_id, deactivated FROM facts WHERE row_id IN (?, ?) ORDER BY row_id", old.id, neu.id);
		expect(results[0]).toMatchObject({ active: 0 });
		expect(results[0].deactivated).toBeTruthy();
		expect(results[1]).toMatchObject({ active: 1, replaces_id: old.id });

		const ctx = (await getContext.run(env, "claude", {})) as any;
		const ids = ctx.facts.map((f: any) => f.id);
		expect(ids).toContain(neu.id);
		expect(ids).not.toContain(old.id);

		// Replacing an already-replaced fact is refused
		await expect(saveMemory.run(env, "claude", { fact: "x", category: "other", replaces: old.id })).rejects.toThrow(/No current fact/);
	});

	it("rejects empty, too long and secret-looking facts", async () => {
		await expect(saveMemory.run(env, "claude", { fact: "   ", category: "other" })).rejects.toThrow(/empty/);
		await expect(saveMemory.run(env, "claude", { fact: "a".repeat(301), category: "other" })).rejects.toThrow(/shorten/);
		await expect(saveMemory.run(env, "claude", { fact: "My card is 4111 1111 1111 1111", category: "other" })).rejects.toThrow(/card/);
	});
});

describe("database safety triggers", () => {
	it("refuses DELETE and in-place edits", async () => {
		const r = (await saveMemory.run(env, "claude", { fact: "Safety test fact", category: "other" })) as any;
		await expect(env.DB.prepare("DELETE FROM facts WHERE row_id = ?").bind(r.id).run()).rejects.toThrow(/never deletes/);
		await expect(env.DB.prepare("UPDATE facts SET fact = 'changed' WHERE row_id = ?").bind(r.id).run()).rejects.toThrow(/never edits/);
	});
});

describe("get_context", () => {
	it("returns profile, facts, projects and the reminder; skips expired facts", async () => {
		const ts = new Date().toISOString();
		await env.DB.batch([
			env.DB.prepare("INSERT INTO profile (section, content, source, created) VALUES ('about', 'Gardener in Northvale', 'manual', ?)").bind(ts),
			env.DB.prepare("INSERT INTO projects (id, name, source, created) VALUES ('vault', 'Vault', 'manual', ?)").bind(ts),
			env.DB.prepare("INSERT INTO facts (fact, category, kind, source, created, expires) VALUES ('In Paris this week', 'plans', 'temporary', 'claude', ?, '2020-01-01')").bind(ts),
		]);
		const ctx = (await getContext.run(env, "claude", {})) as any;
		expect(ctx.profile).toEqual({ about: "Gardener in Northvale" });
		expect(ctx.projects).toEqual([{ id: "vault", name: "Vault", status: "active" }]);
		expect(ctx.facts.map((f: any) => f.fact)).not.toContain("In Paris this week");
		expect(ctx.reminder).toBe(REMINDER);
	});

	it("puts topic matches first even when older than 15 newer facts", async () => {
		await env.DB.prepare("INSERT INTO facts (fact, category, source, created) VALUES ('Alex loves origami', 'preferences', 'claude', '2020-01-01T00:00:00Z')").run();
		for (let i = 0; i < 16; i++) await saveMemory.run(env, "claude", { fact: `Filler fact ${i}`, category: "other" });
		const plain = (await getContext.run(env, "claude", {})) as any;
		expect(plain.facts).toHaveLength(15);
		expect(plain.facts.map((f: any) => f.fact)).not.toContain("Alex loves origami");
		const topical = (await getContext.run(env, "claude", { topic: "origami?" })) as any;
		expect(topical.facts.map((f: any) => f.fact)).toContain("Alex loves origami");
	});
});

describe("search_history", () => {
	beforeAll(seedHistory);

	it("finds an imported ChatGPT chat with ±2 neighbouring messages (Test B shape)", async () => {
		const r = (await searchHistory.run(env, "claude", { query: "renting a Fiat?", source: "chatgpt" })) as any;
		expect(r.matched).toBe("all words");
		expect(r.messages).toHaveLength(1); // one hit per conversation
		const hit = r.messages[0];
		expect(hit).toMatchObject({ conversation_id: "chatgpt:abc", title: "Car hire Bologna", source: "import_chatgpt" });
		expect(hit.snippet).toMatch(/«Fiat»/i);
		const hitSeq = hit.context.find((c: any) => c.hit).seq;
		expect(hit.context.map((c: any) => c.seq)).toEqual([hitSeq - 2, hitSeq - 1, hitSeq, hitSeq + 1, hitSeq + 2].filter((s) => s >= 0 && s <= 5));
	});

	it("filters by source and date, falls back to any-word, searches documents", async () => {
		expect(((await searchHistory.run(env, "claude", { query: "Fiat", source: "gemini" })) as any).messages).toHaveLength(0);
		expect(((await searchHistory.run(env, "claude", { query: "Fiat", to: "2024-04-30" })) as any).messages).toHaveLength(0);
		expect(((await searchHistory.run(env, "claude", { query: "Fiat", to: "2024-05-01" })) as any).messages).toHaveLength(1);

		const loose = (await searchHistory.run(env, "claude", { query: "Fiat zeppelin" })) as any;
		expect(loose.matched).toBe("any word");
		expect(loose.messages).toHaveLength(1);

		const docs = (await searchHistory.run(env, "claude", { query: "packing passport" })) as any;
		expect(docs.documents[0]).toMatchObject({ document_id: "doc:1", name: "trip-notes.md" });
	});

	it("rejects a query with no words", async () => {
		await expect(searchHistory.run(env, "claude", { query: "?!" })).rejects.toThrow(/no searchable words/);
	});
});

describe("over MCP", () => {
	async function connect(source: "claude" | undefined) {
		const server = newServer();
		registerTools(server, env, () => source);
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const client = new Client({ name: "test", version: "1" });
		await client.connect(b);
		return client;
	}

	it("lists all 14 tools (13 spec + read-only explore) and shares the Vault instructions", async () => {
		const client = await connect("claude");
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual([
			"explore",
			"forget",
			"get_context",
			"get_conversation",
			"get_document",
			"get_project",
			"list_facts",
			"list_projects",
			"save_conversation",
			"save_document",
			"save_memory",
			"save_project",
			"search_history",
			"update_profile",
		]);
		expect(client.getInstructions()).toMatch(/Save to Vault/);
	});

	it("saves and reads back through MCP calls; bad input is a readable error", async () => {
		const client = await connect("claude");
		const saved: any = await client.callTool({ name: "save_memory", arguments: { fact: "I prefer window seats (MCP)", category: "preferences" } });
		const { id } = JSON.parse(saved.content[0].text);
		const ctx: any = await client.callTool({ name: "get_context", arguments: {} });
		// get_context answers in Markdown key-value lines, ids included
		expect(ctx.content[0].text).toContain(`- id: ${id} · date: `);
		expect(ctx.content[0].text).toContain("I prefer window seats (MCP)");
		expect(ctx.content[0].text).toMatch(/^## Facts/m);

		const bad: any = await client.callTool({ name: "save_memory", arguments: { fact: "", category: "preferences" } });
		expect(bad.isError).toBe(true);
	});

	it("refuses to run tools when nobody is signed in", async () => {
		const client = await connect(undefined);
		const r: any = await client.callTool({ name: "get_context", arguments: {} });
		expect(r.isError).toBe(true);
	});
});
