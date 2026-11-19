// Worker entry. Only export the Durable Object and the default handler from this file:
// Cloudflare treats every export here as an entrypoint.
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { configureAi } from "./ai/openai";
import { checkRegistration, type Props } from "./auth";
import { GoogleHandler } from "./google-handler";
import { newServer, registerTools } from "./mcp";

export class VaultMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = newServer();

	async init() {
		configureAi(this.env); // only switches provider when AI_BASE_URL is set; otherwise Workers AI
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
