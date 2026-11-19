// The Node build end to end: a real MCP client over HTTP against a temporary SQLite file.
// Made-up data only. Run with: npm run test:node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startVault } from "./server";
import { applyMigrations, SqliteD1 } from "./sqlite-d1";

const KEY = "test-key-0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "vault-node-"));
let vault: Awaited<ReturnType<typeof startVault>>;
let client: Client;

const text = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

before(async () => {
	vault = await startVault({ key: KEY, dbPath: join(dir, "vault.db"), port: 0 });
	client = new Client({ name: "Claude Code", version: "test" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(vault.url), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }),
	);
});
after(async () => {
	await client.close();
	await vault.close();
	rmSync(dir, { recursive: true, force: true });
});

test("refuses callers without the key, and with a wrong one", async () => {
	const post = (headers: Record<string, string>) =>
		fetch(vault.url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" });
	assert.equal((await post({})).status, 401);
	assert.equal((await post({ Authorization: "Bearer wrong-key-0123456789" })).status, 401);
	assert.equal((await fetch(vault.url.replace("/mcp", "/other"))).status, 404);
});

test("won't start without a proper key", async () => {
	await assert.rejects(startVault({ key: "short", dbPath: ":memory:", port: 0 }), /VAULT_KEY/);
});

test("serves every tool and the shared instructions", async () => {
	const { tools } = await client.listTools();
	assert.equal(tools.length, 14);
	assert.match(client.getInstructions() ?? "", /Save to Vault/);
});

test("saves a fact, stamps the app, and finds it again", async () => {
	const saved = text(await call("save_memory", { fact: "Alex keeps a cello in the spare room", category: "other" }));
	assert.match(saved, /"saved":\s*true|Saved|id/i);
	const row = await vault.db.prepare("SELECT source, active FROM facts WHERE fact LIKE '%cello%'").first<{ source: string; active: number }>();
	assert.deepEqual(row, { source: "claude_code", active: 1 }); // from the client's name, not from the AI
	assert.match(text(await call("get_context", { topic: "cello in the spare room" })), /cello/);
	assert.match(text(await call("list_facts", { query: "cello" })), /cello/);
});

test("an update keeps the old version, and the database refuses deletes", async () => {
	const old = await vault.db.prepare("SELECT row_id FROM facts WHERE fact LIKE '%cello%' AND active = 1").first<{ row_id: number }>();
	await call("save_memory", { fact: "Alex keeps a cello in the hallway", category: "other", replaces: old!.row_id });
	const rows = (await vault.db.prepare("SELECT active, replaces_id FROM facts WHERE fact LIKE '%cello%' ORDER BY row_id").all<any>()).results;
	assert.deepEqual(rows, [{ active: 0, replaces_id: null }, { active: 1, replaces_id: old!.row_id }]);
	await assert.rejects(vault.db.prepare("DELETE FROM facts").run(), /never deletes/i);
});

test("saves a chat and finds it by keyword", async () => {
	await call("save_conversation", {
		title: "Planning the allotment",
		messages: [
			{ role: "user", text: "Which vegetables suit a shady allotment?" },
			{ role: "assistant", text: "Rhubarb, chard and kale cope well with shade." },
		],
	});
	assert.match(text(await call("search_history", { query: "rhubarb shade" })), /allotment/i);
});

test("nothing is logged as failed while the AI parts are off", async () => {
	await new Promise((r) => setTimeout(r, 50));
	const failed = await vault.db.prepare("SELECT count(*) AS n FROM graph_log WHERE status = 'failed'").first<{ n: number }>();
	assert.equal(failed!.n, 0);
});

test("batch is all-or-nothing, and migrations apply once", async () => {
	const db = new SqliteD1(":memory:");
	assert.equal(applyMigrations(db, "migrations").length, 3);
	assert.equal(applyMigrations(db, "migrations").length, 0);
	const insert = (section: string) =>
		db.prepare("INSERT INTO profile (section, content, created) VALUES (?, 'x', '2026-01-01')").bind(section);
	await assert.rejects(db.batch([insert("about"), insert("about")])); // second breaks the one-active rule
	assert.equal(await db.prepare("SELECT count(*) AS n FROM profile").first("n"), 0);
	db.close();
});
