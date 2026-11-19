// The Node build with an AI model plugged in: a pretend OpenAI-style service on this computer stands
// in for OpenAI / Ollama. Made-up data only. Run with: npm run test:node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startVault } from "./server";

const KEY = "test-key-0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "vault-node-ai-"));
const asked: { path: string; auth?: string; model: string }[] = [];
const ai = createServer(async (req, res) => {
	let body = "";
	for await (const c of req) body += c;
	asked.push({ path: req.url ?? "", auth: req.headers.authorization, model: JSON.parse(body).model });
	const graph = {
		entities: [{ name: "Priya", type: "person", aliases: ["my sister"] }, { name: "Leeds", type: "place" }],
		relations: [{ from: "Priya", relation: "lives_in", to: "Leeds" }],
	};
	res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(graph) } }] }));
});
let vault: Awaited<ReturnType<typeof startVault>>;
let client: Client;

before(async () => {
	await new Promise<void>((ok) => ai.listen(0, "127.0.0.1", ok));
	const aiUrl = `http://127.0.0.1:${(ai.address() as { port: number }).port}/v1`;
	vault = await startVault({
		key: KEY,
		dbPath: join(dir, "vault.db"),
		port: 0,
		ai: { AI_BASE_URL: aiUrl, AI_API_KEY: "ai-key", AI_GRAPH_MODEL: "pretend-chat" },
	});
	client = new Client({ name: "Claude Code", version: "test" });
	await client.connect(new StreamableHTTPClientTransport(new URL(vault.url), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
});
after(async () => {
	await client.close();
	await vault.close();
	ai.close();
	rmSync(dir, { recursive: true, force: true });
});

test("a save replies first, then the graph model reads it and the link can be explored", async () => {
	assert.equal(vault.graph, true);
	await client.callTool({ name: "save_memory", arguments: { fact: "My sister Priya moved to Leeds", category: "people" } });
	// the graph is filled in the background: wait for its log line
	for (let i = 0; i < 100; i++) {
		if (await vault.db.prepare("SELECT 1 FROM graph_log WHERE step = 'write'").first()) break;
		await new Promise((r) => setTimeout(r, 20));
	}
	const found: any = await client.callTool({ name: "explore", arguments: { name: "my sister" } });
	assert.match(found.content[0].text, /Priya → lives_in → Leeds/);
	assert.deepEqual(asked[0], { path: "/v1/chat/completions", auth: "Bearer ai-key", model: "pretend-chat" });
});

test("meaning search stays off without an embedding model: no embedding calls, nothing logged as failed", async () => {
	assert.equal(vault.meaning, false);
	assert.equal(asked.filter((a) => a.path.includes("embeddings")).length, 0);
	const failed = await vault.db.prepare("SELECT count(*) AS n FROM graph_log WHERE status = 'failed'").first<{ n: number }>();
	assert.equal(failed!.n, 0);
});
