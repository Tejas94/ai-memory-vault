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
		MCP_OBJECT: DurableObjectNamespace<import("./src/index").VaultMCP>;
	}
}
interface Env extends Cloudflare.Env {}
