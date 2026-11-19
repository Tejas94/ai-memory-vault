// Bindings and secrets available to the Worker as `env.NAME`.

declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import("./src/index");
		durableNamespaces: "VaultMCP";
	}
	interface Env {
		DB: D1Database;
		OAUTH_KV: KVNamespace;
		AI?: Ai; // Workers AI; optional so tests and local runs work without it
		VECTORS?: VectorizeIndex; // Vectorize index "vault-embeddings"; optional like AI
		GOOGLE_CLIENT_ID: string;
		GOOGLE_CLIENT_SECRET: string;
		COOKIE_ENCRYPTION_KEY: string;
		ALLOWED_EMAIL: string;
		HOSTED_DOMAIN?: string;
		// Optional: sign in with any OpenID Connect service instead of Google (see src/signin.ts)
		OIDC_ISSUER?: string;
		OIDC_CLIENT_ID?: string;
		OIDC_CLIENT_SECRET?: string;
		OIDC_SCOPE?: string;
		// Optional: use an OpenAI-style AI service instead of Workers AI (see src/ai/openai.ts)
		AI_BASE_URL?: string;
		AI_API_KEY?: string;
		AI_GRAPH_MODEL?: string;
		AI_EMBED_MODEL?: string;
		AI_EMBED_DIMENSIONS?: string;
		AI_EMBED_MIN_SCORE?: string;
		MCP_OBJECT: DurableObjectNamespace<import("./src/index").VaultMCP>;
	}
}
interface Env extends Cloudflare.Env {}
