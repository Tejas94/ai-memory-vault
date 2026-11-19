// Meaning search in the Node build: the SQLite-file index, a pretend embedding service standing in
// for OpenAI / Ollama, and the catch-up command. Made-up data only. Run with: npm run test:node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { reindex } from "./reindex";
import { startVault } from "./server";
import { SqliteVectors, vectorsPathFor } from "./sqlite-vectors";

const KEY = "test-key-0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "vault-node-vec-"));

// The pretend model: words are hashed into 64 numbers, and SAME lets two words "mean the same"
const SAME: Record<string, string> = { car: "panda", vehicle: "panda", fiat: "panda", drives: "panda" };
const embed = (text: string) => {
	const v = new Array(64).fill(0);
	for (const w0 of text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2)) {
		const w = SAME[w0] ?? w0;
		let h = 0;
		for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
		v[h % 64] += 1;
	}
	return v;
};
let embedCalls = 0;
const ai = createServer(async (req, res) => {
	let body = "";
	for await (const c of req) body += c;
	embedCalls++;
	const data = (JSON.parse(body).input as string[]).map((t, index) => ({ index, embedding: embed(t) }));
	res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data }));
});
let aiSettings: { AI_BASE_URL: string; AI_EMBED_MODEL: string; AI_EMBED_MIN_SCORE: string };
let vault: Awaited<ReturnType<typeof startVault>>;
let client: Client;

const connect = async (url: string) => {
	const c = new Client({ name: "Claude Code", version: "test" });
	await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
	return c;
};
const text = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");
/** Background embedding finishes a moment after the reply: wait until `sql` returns a row. */
const until = async (v: typeof vault, sql: string) => {
	for (let i = 0; i < 150; i++) {
		if (await v.db.prepare(sql).first()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.fail(`never became true: ${sql}`);
};

before(async () => {
	await new Promise<void>((ok) => ai.listen(0, "127.0.0.1", ok));
	aiSettings = { AI_BASE_URL: `http://127.0.0.1:${(ai.address() as { port: number }).port}/v1`, AI_EMBED_MODEL: "pretend-embed", AI_EMBED_MIN_SCORE: "0.3" };
	vault = await startVault({ key: KEY, dbPath: join(dir, "vault.db"), port: 0, ai: aiSettings });
	client = await connect(vault.url);
});
after(async () => {
	await client.close();
	await vault.close();
	ai.close();
	rmSync(dir, { recursive: true, force: true });
});

test("the index ranks by similarity, replaces on re-save, ignores other sizes, and deletes", async () => {
	const index = new SqliteVectors(":memory:");
	const meta = (id: string) => ({ type: "fact", id, part: 0 });
	await index.upsert([
		{ id: "a", values: [1, 0, 0], namespace: "fact", metadata: meta("1") },
		{ id: "b", values: [0.6, 0.8, 0], namespace: "fact", metadata: meta("2") },
		{ id: "c", values: [1, 0, 0], namespace: "document", metadata: meta("3") }, // another kind
		{ id: "d", values: [1, 0], namespace: "fact", metadata: meta("4") }, // another model's size
	]);
	const hits = await index.query([5, 0, 0], { topK: 10, namespace: "fact" }); // length of the question doesn't matter
	assert.deepEqual(hits.map((h) => [h.id, Math.round(h.score * 100) / 100]), [["a", 1], ["b", 0.6]]);
	assert.deepEqual(hits[0].metadata, meta("1"));
	await index.upsert([{ id: "a", values: [0, 0, 1], namespace: "fact", metadata: meta("1") }]);
	assert.equal((await index.query([1, 0, 0], { topK: 1, namespace: "fact" }))[0].id, "b");
	await index.deleteByIds(["a", "b"]);
	assert.equal(index.count(), 2);
	assert.equal(vectorsPathFor("/data/vault.db"), "/data/vault.vectors.db");
	index.close();
});

test("a fact is found by meaning, with no shared words", async () => {
	assert.equal(vault.meaning, true);
	await client.callTool({ name: "save_memory", arguments: { fact: "Alex drives a Fiat Panda", category: "other" } });
	await until(vault, "SELECT 1 FROM embeddings WHERE active = 1 AND item_type = 'fact'");
	assert.equal(vault.vectors!.count(), 1);
	assert.match(text(await client.callTool({ name: "get_context", arguments: { topic: "vehicle" } })), /Fiat Panda/);
});

test("an update swaps the vector and a forget removes it", async () => {
	const old = await vault.db.prepare("SELECT row_id FROM facts WHERE active = 1").first<{ row_id: number }>();
	await client.callTool({ name: "save_memory", arguments: { fact: "Alex sold the Fiat Panda", category: "other", replaces: old!.row_id } });
	await until(vault, `SELECT 1 FROM embeddings WHERE active = 1 AND item_id != '${old!.row_id}'`);
	await until(vault, `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM embeddings WHERE active = 1 AND item_id = '${old!.row_id}')`);
	assert.equal(vault.vectors!.count(), 1);
	const now = await vault.db.prepare("SELECT row_id FROM facts WHERE active = 1").first<{ row_id: number }>();
	await client.callTool({ name: "forget", arguments: { id: String(now!.row_id) } });
	await until(vault, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM embeddings WHERE active = 1)");
	assert.equal(vault.vectors!.count(), 0);
});

test("items saved before a model was set are picked up by the catch-up", async () => {
	const dbPath = join(dir, "later.db");
	const plain = await startVault({ key: KEY, dbPath, port: 0 }); // no AI model
	const c = await connect(plain.url);
	assert.equal(plain.meaning, false);
	await c.callTool({ name: "save_memory", arguments: { fact: "Alex drives a Fiat Panda", category: "other" } });
	await c.callTool({ name: "save_document", arguments: { name: "garage-notes.txt", content: "The vehicle needs new tyres before winter.", scope: "standalone" } });
	await c.close();
	await plain.close();

	await assert.rejects(reindex({ dbPath }), /Meaning search is off/);
	const first = await reindex({ dbPath, ai: aiSettings });
	assert.deepEqual({ embedded: first.embedded, failed: first.failed, left: first.left, vectors: first.vectors }, { embedded: 2, failed: 0, left: 0, vectors: 2 });
	const again = await reindex({ dbPath, ai: aiSettings });
	assert.equal(again.embedded, 0); // nothing left to do
	const before = embedCalls;
	assert.equal((await reindex({ dbPath, ai: aiSettings, redo: true })).embedded, 2);
	assert.ok(embedCalls > before);

	const withModel = await startVault({ key: KEY, dbPath, port: 0, ai: aiSettings });
	const c2 = await connect(withModel.url);
	assert.match(text(await c2.callTool({ name: "get_context", arguments: { topic: "car" } })), /Fiat Panda/);
	assert.match(text(await c2.callTool({ name: "search_history", arguments: { query: "car" } })), /garage-notes/);
	await c2.close();
	await withModel.close();
});
