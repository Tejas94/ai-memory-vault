// Worker entry. Only export the Durable Object and the default handler from this file:
// Cloudflare treats every export here as an entrypoint.
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { isAllowedRedirect, type Props } from "./auth";
import { GoogleHandler } from "./google-handler";
import { newServer, registerTools } from "./mcp";

export class VaultMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = newServer();

	async init() {
		registerTools(this.server, this.env, () => this.props?.source, {
			// Graph updates run after the save has replied; keep the object alive until they finish
			background: (work) => this.ctx.waitUntil(work),
		});
	}
}

const provider = new OAuthProvider({
	apiHandler: VaultMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GoogleHandler as any,
	tokenEndpoint: "/token",
});

/** Refuse app registrations whose return addresses aren't on the allowed list (see auth.ts). */
async function checkRegistration(request: Request): Promise<Response | null> {
	let redirectUris: unknown;
	try {
		redirectUris = ((await request.clone().json()) as { redirect_uris?: unknown }).redirect_uris;
	} catch {
		return null; // let the OAuth library report malformed requests itself
	}
	if (Array.isArray(redirectUris) && redirectUris.every((u) => typeof u === "string" && isAllowedRedirect(u))) {
		return null;
	}
	return Response.json(
		{ error: "invalid_redirect_uri", error_description: "This app is not allowed to sign in to Vault." },
		{ status: 400 },
	);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/register") {
			const refused = await checkRegistration(request);
			if (refused) return refused;
		}
		return provider.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
