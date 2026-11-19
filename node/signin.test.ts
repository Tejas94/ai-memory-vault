// The Node build's sign-in page, end to end: a pretend sign-in service on this computer stands in for
// Google / any OpenID Connect service, and the test plays the browser and the AI app.
// Made-up accounts only. Run with: npm run test:node
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startVault } from "./server";
import { SqliteKV } from "./sqlite-kv";

const KEY = "test-key-0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "vault-node-signin-"));
const APP_RETURN = "http://localhost:9/callback"; // where the pretend AI app receives the sign-in

// The pretend sign-in service: whoever `account` says is "signed in"
let account: Record<string, unknown> = {};
const idp = createServer((req, res) => {
	const base = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
	const send = (body: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
	if (req.url === "/.well-known/openid-configuration")
		return send({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, userinfo_endpoint: `${base}/userinfo` });
	if (req.url === "/token") return send({ access_token: "idp-token" });
	if (req.url === "/userinfo") return send(account);
	res.writeHead(404).end();
});
const freePort = () =>
	new Promise<number>((ok) => {
		const s = createServer().listen(0, "127.0.0.1", () => {
			const { port } = s.address() as { port: number };
			s.close(() => ok(port));
		});
	});

let vault: Awaited<ReturnType<typeof startVault>>;
let base: string;

before(async () => {
	await new Promise<void>((ok) => idp.listen(0, "127.0.0.1", ok));
	const port = await freePort();
	base = `http://127.0.0.1:${port}`;
	vault = await startVault({
		key: KEY,
		port,
		dbPath: join(dir, "vault.db"),
		signIn: {
			OIDC_ISSUER: `http://127.0.0.1:${(idp.address() as { port: number }).port}`,
			OIDC_CLIENT_ID: "vault-client",
			OIDC_CLIENT_SECRET: "vault-secret",
			ALLOWED_EMAIL: "owner@example.com",
			COOKIE_ENCRYPTION_KEY: "c".repeat(64),
			PUBLIC_URL: base,
		},
	});
});
after(async () => {
	await vault.close();
	idp.close();
	rmSync(dir, { recursive: true, force: true });
});

/** Cookies a browser would send back: "a=1; b=2" from the Set-Cookie headers of a response. */
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const hidden = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";

/** An AI app registers, then the "browser" goes through the approval page and the sign-in service. */
async function signIn(appName: string) {
	const reg = await fetch(`${base}/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_name: appName, redirect_uris: [APP_RETURN], token_endpoint_auth_method: "none" }),
	});
	assert.equal(reg.status, 201);
	const { client_id } = (await reg.json()) as { client_id: string };
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const ask = new URLSearchParams({ response_type: "code", client_id, redirect_uri: APP_RETURN, state: "app-state", code_challenge: challenge, code_challenge_method: "S256" });

	const page = await fetch(`${base}/authorize?${ask}`);
	assert.equal(page.status, 200);
	const html = await page.text();
	assert.match(html, /Vault/);
	const approve = await fetch(`${base}/authorize`, {
		method: "POST",
		redirect: "manual",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookiesOf(page) },
		body: new URLSearchParams({ state: hidden(html, "state"), csrf_token: hidden(html, "csrf_token") }),
	});
	assert.equal(approve.status, 302);
	const toService = new URL(approve.headers.get("location")!);
	assert.equal(toService.searchParams.get("client_id"), "vault-client");
	assert.equal(toService.searchParams.get("redirect_uri"), `${base}/callback`);
	assert.equal(toService.searchParams.get("scope"), "openid email profile");

	// the sign-in service sends the browser back to Vault
	const back = await fetch(`${base}/callback?code=idp-code&state=${toService.searchParams.get("state")}`, { redirect: "manual", headers: { Cookie: cookiesOf(approve) } });
	if (back.status !== 302) return { refused: back.status, message: await back.text() };
	const toApp = new URL(back.headers.get("location")!);
	assert.equal(toApp.origin + toApp.pathname, APP_RETURN);
	assert.equal(toApp.searchParams.get("state"), "app-state");

	const token = await fetch(`${base}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "authorization_code", code: toApp.searchParams.get("code")!, client_id, redirect_uri: APP_RETURN, code_verifier: verifier }),
	});
	assert.equal(token.status, 200);
	return { token: ((await token.json()) as { access_token: string }).access_token };
}
const connect = async (bearer: string, name: string) => {
	const c = new Client({ name, version: "test" });
	await c.connect(new StreamableHTTPClientTransport(new URL(vault.url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
	return c;
};

test("an app signs in through the approval page and the sign-in service, then saves as itself", async () => {
	account = { sub: "u-1", email: "Owner@Example.com", email_verified: true, name: "Alex" };
	const { token } = await signIn("ChatGPT");
	assert.ok(token);
	// the app calls itself something else when it connects: the label still comes from its registration
	const c = await connect(token!, "some-other-name");
	await c.callTool({ name: "save_memory", arguments: { fact: "Alex keeps bees on the roof", category: "other" } });
	assert.equal(await vault.db.prepare("SELECT source FROM facts WHERE fact LIKE '%bees%'").first("source"), "chatgpt");
	await c.close();
});

test("the secret key still works next to sign-in", async () => {
	const c = await connect(KEY, "Claude Code");
	const found: any = await c.callTool({ name: "list_facts", arguments: { query: "bees" } });
	assert.match(found.content[0].text, /bees/);
	await c.close();
});

test("another account, or an unverified email, is turned away", async () => {
	account = { sub: "u-2", email: "someone@example.com", email_verified: true };
	assert.equal((await signIn("ChatGPT")).refused, 403);
	account = { sub: "u-1", email: "owner@example.com", email_verified: false };
	assert.equal((await signIn("ChatGPT")).refused, 403);
	account = { sub: "u-1", email: "owner@example.com" }; // the service doesn't say it is verified
	const r = await signIn("ChatGPT");
	assert.equal(r.refused, 403);
	assert.doesNotMatch(r.message!, /owner@example\.com/);
});

test("no token, a made-up token and an unknown app are all refused", async () => {
	const post = (headers: Record<string, string> = {}) => fetch(vault.url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" });
	assert.equal((await post()).status, 401);
	assert.equal((await post({ Authorization: "Bearer made-up-token-0123456789" })).status, 401);
	const stranger = await fetch(`${base}/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai.evil.example/api/mcp/auth_callback"] }),
	});
	assert.equal(stranger.status, 400);
	const meta = await fetch(`${base}/.well-known/oauth-authorization-server`);
	assert.equal(((await meta.json()) as { token_endpoint: string }).token_endpoint, `${base}/token`);
});

test("sign-in settings are checked at start", async () => {
	const signIn = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", ALLOWED_EMAIL: "owner@example.com", COOKIE_ENCRYPTION_KEY: "c".repeat(64), PUBLIC_URL: "https://vault.example.com" };
	await assert.rejects(startVault({ dbPath: ":memory:", port: 0 }), /VAULT_KEY/);
	await assert.rejects(startVault({ dbPath: ":memory:", port: 0, signIn: { ...signIn, ALLOWED_EMAIL: "" } }), /ALLOWED_EMAIL/);
	await assert.rejects(startVault({ dbPath: ":memory:", port: 0, signIn: { ...signIn, COOKIE_ENCRYPTION_KEY: "short" } }), /COOKIE_ENCRYPTION_KEY/);
	await assert.rejects(startVault({ dbPath: ":memory:", port: 0, signIn: { ...signIn, PUBLIC_URL: "" } }), /PUBLIC_URL/);
});

test("the sign-in store expires entries and lists by prefix", async () => {
	const kv = new SqliteKV(":memory:");
	await kv.put("client:a", JSON.stringify({ n: 1 }));
	await kv.put("client:b", "x", { expirationTtl: 60 });
	await kv.put("gone", "x", { expiration: Math.floor(Date.now() / 1000) - 1 });
	await kv.put("client_other", "x");
	assert.deepEqual(await kv.get("client:a", { type: "json" }), { n: 1 });
	assert.equal(await kv.get("gone"), null);
	assert.deepEqual((await kv.list({ prefix: "client:" })).keys.map((k) => k.name), ["client:a", "client:b"]);
	const first = await kv.list({ prefix: "client:", limit: 1 });
	assert.equal(first.list_complete, false);
	assert.deepEqual((await kv.list({ prefix: "client:", limit: 1, cursor: first.cursor })).keys.map((k) => k.name), ["client:b"]);
	await kv.delete("client:a");
	assert.equal(await kv.get("client:a"), null);
	kv.close();
});
