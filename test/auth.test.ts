import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { isAllowedEmail, isAllowedRedirect, sourceFromClientName } from "../src/auth";
import { newServer, registerTools } from "../src/mcp";

const env = (ALLOWED_EMAIL: string) => ({ ALLOWED_EMAIL }) as Env;

describe("allowed email", () => {
	it("allows only the configured, verified email", () => {
		expect(isAllowedEmail(env("owner@example.com"), "Owner@Example.com", true)).toBe(true);
		expect(isAllowedEmail(env("owner@example.com"), "someone@example.com", true)).toBe(false);
		expect(isAllowedEmail(env("owner@example.com"), "owner@example.com", false)).toBe(false);
	});

	it("lets nobody in when the secret is missing", () => {
		expect(isAllowedEmail(env(""), "", true)).toBe(false);
		expect(isAllowedEmail(env(""), "owner@example.com", true)).toBe(false);
	});
});

describe("source from client name", () => {
	it.each([
		["Claude", "claude"],
		["claude-code", "claude_code"],
		["Claude Code (vault)", "claude_code"],
		["ChatGPT", "chatgpt"],
		["Some new app", "manual"],
		[undefined, "manual"],
	])("%s → %s", (name, source) => {
		expect(sourceFromClientName(name)).toBe(source);
	});
});

describe("the deployed Worker", () => {
	it("blocks /mcp without a sign-in token", async () => {
		const res = await exports.default.fetch("https://vault.test/mcp", { method: "POST", body: "{}" });
		expect(res.status).toBe(401);
	});

	it("publishes OAuth discovery metadata so Claude can find the sign-in flow", async () => {
		const res = await exports.default.fetch("https://vault.test/.well-known/oauth-authorization-server");
		expect(res.status).toBe(200);
		const meta = (await res.json()) as { authorization_endpoint: string };
		expect(meta.authorization_endpoint).toBe("https://vault.test/authorize");
	});
});

describe("allowed return addresses (security fix #3)", () => {
	it.each([
		["https://claude.ai/api/mcp/auth_callback", true],
		["https://claude.com/api/mcp/auth_callback", true],
		["https://chatgpt.com/connector/oauth/abc123", true],
		["http://localhost:53124/callback", true],
		["http://127.0.0.1:8080/cb", true],
		["https://evil.example/api/mcp/auth_callback", false],
		["https://claude.ai.evil.example/api/mcp/auth_callback", false],
		["https://claude.ai/somewhere-else", false],
		["https://chatgpt.com/other/path", false],
		["http://claude.ai/api/mcp/auth_callback", false],
		["https://localhost/callback", false],
		["javascript:alert(1)", false],
		["not a url", false],
		[undefined, false],
	])("%s → %s", (uri, allowed) => {
		expect(isAllowedRedirect(uri)).toBe(allowed);
	});

	const register = (redirect_uris: unknown) =>
		exports.default.fetch("https://vault.test/register", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ client_name: "Some app", redirect_uris, token_endpoint_auth_method: "none" }),
		});

	it("refuses to register an app with an unknown return address", async () => {
		const res = await register(["https://evil.example/callback"]);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
	});

	it("refuses if even one of several addresses is unknown", async () => {
		const res = await register(["https://claude.ai/api/mcp/auth_callback", "https://evil.example/cb"]);
		expect(res.status).toBe(400);
	});

	it("still lets Claude and ChatGPT register", async () => {
		expect((await register(["https://claude.ai/api/mcp/auth_callback"])).status).toBe(201);
		expect((await register(["https://chatgpt.com/connector/oauth/abc123"])).status).toBe(201);
	});
});

describe("internal errors stay private (security fix #5)", () => {
	it("an unexpected tool failure returns a plain message, not the internal error", async () => {
		const brokenEnv = {
			DB: {
				prepare() {
					throw new Error("D1_ERROR: no such column: secret_internal_detail");
				},
			},
		} as unknown as Env;
		const server = newServer();
		registerTools(server, brokenEnv, () => "claude");
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const client = new Client({ name: "test", version: "1" });
		await client.connect(b);

		const r: any = await client.callTool({ name: "get_context", arguments: {} });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toBe("Vault hit an internal error in get_context. Please try again.");
		expect(r.content[0].text).not.toMatch(/D1_ERROR|secret_internal_detail/);
	});
});
