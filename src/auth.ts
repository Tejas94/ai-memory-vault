// Who is calling, decided by the server — never by what the AI claims.

export const SOURCES = [
	"chatgpt",
	"claude",
	"gemini",
	"claude_code",
	"codex",
	"grok",
	"perplexity",
	"muse",
	"manual",
	"import_chatgpt",
	"import_claude",
	"import_gemini",
	"import_claude_code",
] as const;
export type Source = (typeof SOURCES)[number];

// Context from the auth process, encrypted & stored in the auth token
// and provided to VaultMCP as this.props
export type Props = {
	name: string;
	email: string;
	source: Source;
};

/** Map the name an app gave when it registered as an OAuth client to a Vault source. */
export function sourceFromClientName(clientName: string | undefined): Source {
	const n = (clientName ?? "").toLowerCase();
	if (n.includes("claude code") || n.includes("claude-code")) return "claude_code";
	if (n.includes("claude")) return "claude";
	if (n.includes("chatgpt") || n.includes("openai")) return "chatgpt";
	if (n.includes("codex")) return "codex";
	if (n.includes("grok")) return "grok";
	if (n.includes("perplexity")) return "perplexity";
	if (n.includes("muse")) return "muse";
	// Unknown apps are labelled "manual" until build step 2 adds the clients table.
	return "manual";
}

// Where an app may send the sign-in back to. Anything else is refused, so a stranger who registers
// their own "app" can never receive a Vault login. Add an entry here to connect a new app.
const ALLOWED_REDIRECTS: { origin: string; path: string; prefix?: boolean }[] = [
	{ origin: "https://claude.ai", path: "/api/mcp/auth_callback" },
	{ origin: "https://claude.com", path: "/api/mcp/auth_callback" },
	{ origin: "https://chatgpt.com", path: "/connector/oauth/", prefix: true },
];

// Desktop apps (e.g. Claude Code) receive the sign-in on this computer, which a stranger can't reach
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** True if an app is allowed to receive Vault sign-ins at this return address. */
export function isAllowedRedirect(uri: string | undefined): boolean {
	if (!uri) return false;
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return false;
	}
	if (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)) return true;
	return ALLOWED_REDIRECTS.some(
		(r) => url.origin === r.origin && (r.prefix ? url.pathname.startsWith(r.path) : url.pathname === r.path),
	);
}

/**
 * Only the single email in env.ALLOWED_EMAIL may sign in. Fails closed if the secret is missing.
 * `mustBeVerified`: the sign-in service has to state the email is verified (services other than
 * Google, where a missing statement can mean anyone typed that address in).
 */
export function isAllowedEmail(env: Pick<Env, "ALLOWED_EMAIL">, email: string | undefined, verified: boolean | undefined, mustBeVerified = false): boolean {
	const allowed = (env.ALLOWED_EMAIL ?? "").trim().toLowerCase();
	if (!allowed || !email || verified === false || (mustBeVerified && verified !== true)) return false;
	return email.trim().toLowerCase() === allowed;
}

/** Refuse app registrations (POST /register) whose return addresses aren't on the allowed list. */
export async function checkRegistration(request: Request): Promise<Response | null> {
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
