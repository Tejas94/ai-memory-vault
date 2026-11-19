import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { forget } from "../src/tools/forget";
import { getContext } from "../src/tools/get_context";
import { getConversation } from "../src/tools/get_conversation";
import { getDocument } from "../src/tools/get_document";
import { getProject } from "../src/tools/get_project";
import { listFacts } from "../src/tools/list_facts";
import { listProjects } from "../src/tools/list_projects";
import { saveConversation } from "../src/tools/save_conversation";
import { saveDocument } from "../src/tools/save_document";
import { saveMemory } from "../src/tools/save_memory";
import { saveProject } from "../src/tools/save_project";
import { searchHistory } from "../src/tools/search_history";
import { updateProfile } from "../src/tools/update_profile";

const rows = async (sql: string, ...p: unknown[]) =>
	(await env.DB.prepare(sql).bind(...p).all<Record<string, any>>()).results;

describe("save_conversation", () => {
	it("saves both sides in order, maps roles, attaches documents, and is searchable", async () => {
		const r = (await saveConversation.run(env, "chatgpt", {
			title: "Planning a Lisbon trip",
			messages: [
				{ role: "user", text: "Should I take the train to Lisbon from Porto?" },
				{ role: "assistant", text: "Yes, the Alfa Pendular takes about three hours." },
			],
			documents: [{ name: "itinerary.txt", content: "Day 1 Porto, Day 2 Lisbon" }],
		})) as any;

		expect(r).toMatchObject({ saved_messages: 2, skipped_already_saved: 0, message: "Saved ✓" });
		expect(r.conversation_id).toMatch(/^vault:/);
		expect(r.documents[0]).toMatchObject({ name: "itinerary.txt", truncated: false });

		const msgs = await rows("SELECT seq, role, source FROM messages WHERE conversation_id = ? ORDER BY seq", r.conversation_id);
		expect(msgs).toEqual([
			{ seq: 0, role: "you", source: "chatgpt" },
			{ seq: 1, role: "ai", source: "chatgpt" },
		]);
		const [doc] = await rows("SELECT scope, conversation_id, file_type FROM documents WHERE doc_id = ?", r.documents[0].document_id);
		expect(doc).toEqual({ scope: "conversation", conversation_id: r.conversation_id, file_type: "txt" });

		const found = (await searchHistory.run(env, "claude", { query: "Alfa Pendular" })) as any;
		expect(found.messages[0]).toMatchObject({ conversation_id: r.conversation_id, title: "Planning a Lisbon trip", source: "chatgpt" });
	});

	it("appending adds only new messages and versions the conversation row", async () => {
		const first = (await saveConversation.run(env, "claude", {
			title: "Gym plan",
			messages: [
				{ role: "you", text: "Three days a week?" },
				{ role: "ai", text: "Yes, full body each time." },
			],
		})) as any;
		const again = (await saveConversation.run(env, "claude", {
			title: "Gym plan (updated)",
			conversation_id: first.conversation_id,
			messages: [
				{ role: "you", text: "Three days a week?" },
				{ role: "ai", text: "Yes, full body each time." },
				{ role: "you", text: "And cardio?" },
			],
		})) as any;
		expect(again).toMatchObject({ conversation_id: first.conversation_id, saved_messages: 1, skipped_already_saved: 2 });

		const versions = await rows("SELECT row_id, title, active, replaces_id FROM conversations WHERE id = ? ORDER BY row_id", first.conversation_id);
		expect(versions).toHaveLength(2);
		expect(versions[0]).toMatchObject({ active: 0 });
		expect(versions[1]).toMatchObject({ active: 1, title: "Gym plan (updated)", replaces_id: versions[0].row_id });

		const read = (await getConversation.run(env, "claude", { conversation_id: first.conversation_id })) as any;
		expect(read.messages.map((m: any) => [m.seq, m.text])).toEqual([
			[0, "Three days a week?"],
			[1, "Yes, full body each time."],
			[2, "And cardio?"],
		]);
	});

	it("rejects empty chats and unknown ids; trims huge messages with a note", async () => {
		await expect(saveConversation.run(env, "claude", { title: "x", messages: [{ role: "you", text: "  " }] })).rejects.toThrow(/empty/);
		await expect(
			saveConversation.run(env, "claude", { title: "x", conversation_id: "vault:nope", messages: [{ role: "you", text: "hi" }] }),
		).rejects.toThrow(/No current conversation/);

		const r = (await saveConversation.run(env, "claude", { title: "Long", messages: [{ role: "ai", text: "x".repeat(60_000) }] })) as any;
		const [m] = await rows("SELECT text FROM messages WHERE conversation_id = ?", r.conversation_id);
		expect(m.text.length).toBeLessThan(51_000);
		expect(m.text).toMatch(/trimmed by Vault: original was 60000 characters/);
	});
});

describe("get_conversation", () => {
	it("pages 40 messages at a time and lists attached documents", async () => {
		const messages = Array.from({ length: 45 }, (_, i) => ({ role: (i % 2 ? "ai" : "you") as "ai" | "you", text: `message ${i}` }));
		const r = (await saveConversation.run(env, "claude", {
			title: "Long chat",
			messages,
			documents: [{ name: "notes.md", content: "notes" }],
		})) as any;

		const p1 = (await getConversation.run(env, "claude", { conversation_id: r.conversation_id })) as any;
		expect(p1).toMatchObject({ title: "Long chat", page: 1, total_pages: 2 });
		expect(p1.messages).toHaveLength(40);
		expect(p1.documents).toEqual([{ document_id: r.documents[0].document_id, name: "notes.md", file_type: "md" }]);

		const p2 = (await getConversation.run(env, "claude", { conversation_id: r.conversation_id, page: 2 })) as any;
		expect(p2.messages.map((m: any) => m.text)).toEqual(["message 40", "message 41", "message 42", "message 43", "message 44"]);
	});
});

describe("save_document / get_document", () => {
	it("saves standalone text, updates by versioning, and returns the newest in full (Test C shape)", async () => {
		const v1 = (await saveDocument.run(env, "chatgpt", {
			name: "lease.pdf",
			content: "Rent is £1,500 per month. Notice period two months.",
			scope: "standalone",
		})) as any;
		expect(v1.document_id).toMatch(/^doc:/);

		const found = (await searchHistory.run(env, "claude", { query: "notice period" })) as any;
		expect(found.documents[0]).toMatchObject({ document_id: v1.document_id, name: "lease.pdf", source: "chatgpt" });

		const v2 = (await saveDocument.run(env, "claude", {
			name: "lease.pdf",
			content: "Rent is £1,600 per month.",
			scope: "standalone",
			document_id: v1.document_id,
		})) as any;
		expect(v2).toMatchObject({ document_id: v1.document_id });

		const doc = (await getDocument.run(env, "claude", { document_id: v1.document_id })) as any;
		expect(doc).toMatchObject({ content: "Rent is £1,600 per month.", file_type: "pdf", source: "claude" });
		const versions = await rows("SELECT active, replaces_id FROM documents WHERE doc_id = ? ORDER BY row_id", v1.document_id);
		expect(versions.map((v) => v.active)).toEqual([0, 1]);
	});

	it("checks scope ids, rejects empty text, trims documents over 200,000 characters", async () => {
		await expect(saveDocument.run(env, "claude", { name: "a", content: "b", scope: "project" })).rejects.toThrow(/project_id/);
		await expect(saveDocument.run(env, "claude", { name: "a", content: "b", scope: "conversation" })).rejects.toThrow(/conversation_id/);
		await expect(saveDocument.run(env, "claude", { name: "a", content: " ", scope: "standalone" })).rejects.toThrow(/no text/);
		await expect(getDocument.run(env, "claude", { document_id: "doc:nope" })).rejects.toThrow(/No current document/);

		const big = (await saveDocument.run(env, "claude", { name: "big.txt", content: "y".repeat(250_000), scope: "standalone" })) as any;
		expect(big.truncated).toBe(true);
	});
});

describe("forget", () => {
	it("hides a fact (kept as history) and refuses unknown ids", async () => {
		const f = (await saveMemory.run(env, "claude", { fact: "My favourite colour is green", category: "preferences" })) as any;
		const r = (await forget.run(env, "claude", { id: f.id })) as any;
		expect(r).toMatchObject({ forgotten: true, table: "facts" });

		const ctx = (await getContext.run(env, "claude", {})) as any;
		expect(ctx.facts.map((x: any) => x.id)).not.toContain(f.id);
		const [row] = await rows("SELECT active, deactivated FROM facts WHERE row_id = ?", f.id);
		expect(row.active).toBe(0);
		expect(row.deactivated).toBeTruthy();

		await expect(forget.run(env, "claude", { id: f.id })).rejects.toThrow(/Nothing current/);
	});

	it("forgetting a conversation hides its messages from search", async () => {
		const c = (await saveConversation.run(env, "claude", { title: "Secret santa", messages: [{ role: "you", text: "Buy a xylophone" }] })) as any;
		expect(((await searchHistory.run(env, "claude", { query: "xylophone" })) as any).messages).toHaveLength(1);
		await forget.run(env, "claude", { id: c.conversation_id, table: "conversations" });
		expect(((await searchHistory.run(env, "claude", { query: "xylophone" })) as any).messages).toHaveLength(0);
	});

	it("forgets documents and projects by their ids", async () => {
		const d = (await saveDocument.run(env, "claude", { name: "old.txt", content: "zebra crossing", scope: "standalone" })) as any;
		await forget.run(env, "claude", { id: d.document_id, table: "documents" });
		expect(((await searchHistory.run(env, "claude", { query: "zebra" })) as any).documents).toHaveLength(0);

		await saveProject.run(env, "claude", { name: "Old Hobby" });
		await forget.run(env, "claude", { id: "old-hobby", table: "projects" });
		expect(((await listProjects.run(env, "claude", {})) as any).projects.map((p: any) => p.project_id)).not.toContain("old-hobby");
	});
});

describe("projects", () => {
	it("creates, refuses duplicates, updates keeping unchanged fields, filters by status", async () => {
		const created = (await saveProject.run(env, "claude", {
			name: "Job Search 2026",
			description: "Find a senior role in Northvale",
			instructions: "Keep a tracker of applications",
		})) as any;
		expect(created).toMatchObject({ project_id: "job-search-2026", updated: false });

		await expect(saveProject.run(env, "claude", { name: "Job search 2026" })).rejects.toThrow(/already exists/);

		const updated = (await saveProject.run(env, "chatgpt", { project_id: "job-search-2026", name: "Job Search 2026", status: "paused" })) as any;
		expect(updated).toMatchObject({ updated: true });
		const versions = await rows("SELECT active, status, instructions, source FROM projects WHERE id = 'job-search-2026' ORDER BY row_id");
		expect(versions[0].active).toBe(0);
		expect(versions[1]).toMatchObject({ active: 1, status: "paused", instructions: "Keep a tracker of applications", source: "chatgpt" });

		const paused = (await listProjects.run(env, "claude", { status: "paused" })) as any;
		expect(paused.projects.map((p: any) => p.project_id)).toEqual(["job-search-2026"]);
	});

	it("get_project briefs with documents, facts, notes and recent conversations", async () => {
		await saveProject.run(env, "claude", { name: "Vault build", description: "Personal memory server" });
		await saveDocument.run(env, "claude", { name: "spec.md", content: "z".repeat(3_000), scope: "project", project_id: "vault-build" });
		await saveMemory.run(env, "claude", { fact: "Vault uses Cloudflare D1", category: "projects", project_id: "vault-build" });
		await saveConversation.run(env, "claude_code", {
			title: "Session summary",
			project_id: "vault-build",
			messages: [{ role: "ai", text: "Built step 5" }],
		});

		const p = (await getProject.run(env, "claude", { project_id: "vault-build" })) as any;
		expect(p).toMatchObject({ name: "Vault build", description: "Personal memory server", status: "active" });
		expect(p.documents[0].name).toBe("spec.md");
		expect(p.documents[0].content.length).toBeLessThan(1_600); // preview only
		expect(p.facts.map((f: any) => f.fact)).toContain("Vault uses Cloudflare D1");
		expect(p.recent_conversations[0]).toMatchObject({ title: "Session summary", source: "claude_code" });

		await expect(getProject.run(env, "claude", { project_id: "nope" })).rejects.toThrow(/No current project/);
	});
});

describe("update_profile", () => {
	it("writes a section, versions it on update, and get_context shows the newest", async () => {
		const a = (await updateProfile.run(env, "claude", { section: "current_focus", content: "Building Vault" })) as any;
		expect(a).toMatchObject({ updated: false });
		const b = (await updateProfile.run(env, "chatgpt", { section: "current_focus", content: "Job hunting and Vault" })) as any;
		expect(b).toMatchObject({ updated: true });

		const ctx = (await getContext.run(env, "claude", {})) as any;
		expect(ctx.profile.current_focus).toBe("Job hunting and Vault");
		const versions = await rows("SELECT active FROM profile WHERE section = 'current_focus' ORDER BY row_id");
		expect(versions.map((v) => v.active)).toEqual([0, 1]);

		await expect(updateProfile.run(env, "claude", { section: "about", content: " " })).rejects.toThrow(/empty/);
	});
});

describe("list_facts", () => {
	it("filters by keywords and category, shows ids, statuses and the history chain", async () => {
		const old = (await saveMemory.run(env, "claude", { fact: "Alex drives a Golf", category: "other" })) as any;
		const neu = (await saveMemory.run(env, "claude", { fact: "Alex drives an electric Golf", category: "other", replaces: old.id })) as any;
		await env.DB.prepare(
			"INSERT INTO facts (fact, category, kind, source, created, expires) VALUES ('Golf lessons this month', 'plans', 'temporary', 'claude', ?, '2020-01-01')",
		)
			.bind(new Date().toISOString())
			.run();

		const current = (await listFacts.run(env, "claude", { query: "golf" })) as any;
		const byFact = Object.fromEntries(current.facts.map((f: any) => [f.fact, f]));
		expect(byFact["Alex drives an electric Golf"]).toMatchObject({ id: neu.id, status: "current", replaces_id: old.id });
		expect(byFact["Golf lessons this month"].status).toBe("expired");
		expect(byFact["Alex drives a Golf"]).toBeUndefined();

		const history = (await listFacts.run(env, "claude", { query: "golf", include_inactive: true })) as any;
		expect(history.facts.find((f: any) => f.id === old.id)).toMatchObject({ status: "old" });

		const plans = (await listFacts.run(env, "claude", { query: "golf", category: "plans" })) as any;
		expect(plans.facts.map((f: any) => f.fact)).toEqual(["Golf lessons this month"]);
	});
});
