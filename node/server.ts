// Vault as a plain Node program: the same tools and the same /mcp address as the Cloudflare Worker,
// with the database in one SQLite file. Runs on any computer or server that has Node 22.16 or newer.
//
//   VAULT_KEY=<a long random secret> npx tsx node/server.ts
//
// Settings (environment variables, or a .env file in the folder you start it from: see .env.example):
//   VAULT_DB    the database file (default ./vault.db; created, with its tables, on first start)
//   PORT        default 8788
//   HOST        default 127.0.0.1 (this computer only). Put HTTPS in front before opening it wider.
//
// Who may connect: at least one of these two, and both can be on together.
//   1. A secret key, for apps that can send a header (Claude Code and other MCP clients):
//        VAULT_KEY   apps send it as "Authorization: Bearer <key>". Make one: openssl rand -hex 32
//   2. A sign-in page, for apps that only connect that way (Claude and ChatGPT on the web and phone).
//      The same sign-in code as the Cloudflare build (src/google-handler.ts, src/signin.ts):
//        GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, or OIDC_ISSUER + OIDC_CLIENT_ID + OIDC_CLIENT_SECRET
//        ALLOWED_EMAIL           the one account allowed in
//        COOKIE_ENCRYPTION_KEY   protects the sign-in cookies. Make one: openssl rand -hex 32
//        PUBLIC_URL              the https address people reach Vault at, e.g. https://vault.example.com
//      Sign-ins are remembered in a file next to the database (vault.signin.db, see sqlite-kv.ts).
//
// AI (optional, see src/ai/openai.ts): set AI_BASE_URL (plus AI_API_KEY if the service needs one) and
//   AI_GRAPH_MODEL  → the knowledge graph updates itself after every save
//   AI_EMBED_MODEL  → meaning search; its index is a second file next to the database
//                     (vault.vectors.db, see sqlite-vectors.ts)
// Each is off without its model, and searches then go by keyword. Items saved before a model was set
// are picked up with: npm run reindex:node
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type AiSettings, configureAi } from "../src/ai/openai";
import { checkRegistration, type Props, type Source, sourceFromClientName } from "../src/auth";
import { setGraphEnabled } from "../src/graph/extract";
import { newServer, registerTools } from "../src/mcp";
import { hasSignIn, type SignInSettings } from "../src/signin";
import { setVectorsEnabled, setVectorStore } from "../src/vectors/embed";
import { applyMigrations, SqliteD1 } from "./sqlite-d1";
import { kvPathFor, SqliteKV } from "./sqlite-kv";
import { SqliteVectors, vectorsPathFor } from "./sqlite-vectors";

const MAX_BODY = 20 * 1024 * 1024; // bytes per request (a long saved chat fits many times over)
const IDLE_MS = 60 * 60 * 1000; // a connection unused for an hour is closed

export type SignInOptions = SignInSettings & { ALLOWED_EMAIL?: string; COOKIE_ENCRYPTION_KEY?: string; PUBLIC_URL?: string };
export type VaultOptions = {
	key?: string;
	signIn?: SignInOptions;
	dbPath?: string;
	port?: number;
	host?: string;
	migrationsDir?: string;
	ai?: AiSettings;
};

const digest = (s: string) => createHash("sha256").update(s).digest();
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/** Node's request → a standard web Request (the sign-in code and the MCP transport both speak that). */
async function toRequest(req: IncomingMessage, base: string): Promise<Request> {
	const headers = new Headers();
	for (const [k, v] of Object.entries(req.headers)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) headers.append(k, one);
	let body: Buffer | undefined;
	if (req.method !== "GET" && req.method !== "HEAD") {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > MAX_BODY) throw new Error("too large");
			chunks.push(chunk);
		}
		body = Buffer.concat(chunks);
	}
	return new Request(new URL(req.url ?? "/", base), { method: req.method, headers, body: body?.length ? new Uint8Array(body) : undefined });
}

/** A web Response → Node's response, streaming (MCP replies can be event streams). */
function send(res: ServerResponse, out: Response) {
	const headers: Record<string, string | string[]> = {};
	out.headers.forEach((v, k) => {
		if (k !== "set-cookie") headers[k] = v;
	});
	const cookies = out.headers.getSetCookie();
	if (cookies.length) headers["set-cookie"] = cookies;
	res.writeHead(out.status, headers);
	if (!out.body) return void res.end();
	Readable.fromWeb(out.body as any).on("error", () => res.end()).pipe(res);
}

/**
 * The sign-in library is written for Cloudflare and imports one Cloudflare-only module for a feature
 * Vault doesn't use. Outside Cloudflare that import gets an empty stand-in, then the library loads.
 */
async function loadOAuthProvider() {
	registerHooks({
		resolve: (specifier, context, next) =>
			specifier === "cloudflare:workers"
				? { url: "data:text/javascript,export class WorkerEntrypoint{}", shortCircuit: true }
				: next(specifier, context),
	});
	const [{ default: OAuthProvider }, { GoogleHandler }] = await Promise.all([import("@cloudflare/workers-oauth-provider"), import("../src/google-handler")]);
	return { OAuthProvider, SignInHandler: GoogleHandler };
}

/** Open the database (creating its tables if new) and switch on whichever AI parts have a model. */
export function openVault(opts: Pick<VaultOptions, "dbPath" | "migrationsDir" | "ai">) {
	const dbPath = opts.dbPath ?? "vault.db";
	const db = new SqliteD1(dbPath);
	const applied = applyMigrations(db, opts.migrationsDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "migrations"));
	const ai = configureAi(opts.ai ?? {});
	setGraphEnabled(ai.graph);
	setVectorsEnabled(ai.embeddings);
	const vectors = ai.embeddings ? new SqliteVectors(vectorsPathFor(dbPath)) : undefined;
	if (vectors) setVectorStore(() => vectors);
	return { env: { DB: db } as unknown as Env, db, vectors, applied, ai };
}

export async function startVault(opts: VaultOptions) {
	const signIn = opts.signIn && hasSignIn(opts.signIn) ? opts.signIn : undefined;
	if (!opts.key && !signIn) throw new Error("Set VAULT_KEY (a secret key), or the sign-in settings, so Vault knows who may connect.");
	if (opts.key && opts.key.length < 16) throw new Error("VAULT_KEY must be a secret of at least 16 characters.");
	if (signIn) {
		if (!signIn.ALLOWED_EMAIL?.trim()) throw new Error("Sign-in needs ALLOWED_EMAIL: the one account allowed in.");
		if ((signIn.COOKIE_ENCRYPTION_KEY ?? "").length < 32) throw new Error("Sign-in needs COOKIE_ENCRYPTION_KEY of at least 32 characters (openssl rand -hex 32).");
		if (!signIn.PUBLIC_URL?.trim()) throw new Error("Sign-in needs PUBLIC_URL: the address people reach Vault at, e.g. https://vault.example.com");
	}
	const wanted = opts.key ? digest(opts.key) : undefined;
	const { env: dataEnv, db, vectors, applied, ai } = openVault(opts);
	const kv = signIn ? new SqliteKV(kvPathFor(opts.dbPath ?? "vault.db")) : undefined;
	const env = { ...dataEnv, ...signIn, OAUTH_KV: kv } as unknown as Env;

	// One MCP session per connected app, as on Cloudflare
	const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; used: number }>();
	const sweep = setInterval(() => {
		for (const [id, s] of sessions) if (Date.now() - s.used > IDLE_MS) void s.transport.close().finally(() => sessions.delete(id));
	}, 60_000);
	sweep.unref();

	/** An allowed caller's MCP request. `source` is fixed by how they got in, never by what the AI says. */
	async function mcp(request: Request, source?: Source): Promise<Response> {
		const id = request.headers.get("mcp-session-id");
		const known = id ? sessions.get(id) : undefined;
		if (known) {
			known.used = Date.now();
			return known.transport.handleRequest(request);
		}
		if (id) return json(404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
		if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });

		// A new app connecting gets its own MCP server. With a key, the source label comes from the
		// name the app gives when it connects; with sign-in, from the name it registered under.
		const server = newServer();
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: randomUUID,
			onsessioninitialized: (sid) => void sessions.set(sid, { transport, used: Date.now() }),
			onsessionclosed: (sid) => void sessions.delete(sid),
		});
		registerTools(server, env, () => source ?? sourceFromClientName(server.server.getClientVersion()?.name), {
			// after-save work keeps running once the reply has gone; it logs its own failures
			background: (work) => void work.catch((e) => console.error("Background work failed:", e)),
		});
		await server.connect(transport);
		return transport.handleRequest(request);
	}

	// Sign-in mode: the same OAuth server, approval page and sign-in service as the Cloudflare build
	let oauth: { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> } | undefined;
	if (signIn) {
		const { OAuthProvider, SignInHandler } = await loadOAuthProvider();
		oauth = new OAuthProvider({
			apiHandler: { fetch: (request: Request, _env: unknown, ctx: { props?: Props }) => mcp(request, ctx.props?.source ?? "manual") } as any,
			apiRoute: "/mcp",
			authorizeEndpoint: "/authorize",
			clientRegistrationEndpoint: "/register",
			defaultHandler: SignInHandler as any,
			tokenEndpoint: "/token",
		});
	}

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
		if (url.pathname === "/mcp" && wanted && given && timingSafeEqual(digest(given), wanted)) return mcp(request);
		if (oauth) {
			if (request.method === "POST" && url.pathname === "/register") {
				const refused = await checkRegistration(request);
				if (refused) return refused;
			}
			// each request gets its own context: the library puts the signed-in app's details on it
			const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch((e) => console.error("Background work failed:", e)), passThroughOnException() {} };
			return oauth.fetch(request, env, ctx as unknown as ExecutionContext);
		}
		if (url.pathname !== "/mcp") return json(404, { error: "not_found" });
		return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
	}

	const host = opts.host ?? "127.0.0.1";
	const http = createServer((req, res) => {
		// behind a proxy the public address is PUBLIC_URL; sign-in links are built from it
		const base = signIn?.PUBLIC_URL?.trim() || `http://${req.headers.host ?? "localhost"}`;
		toRequest(req, base)
			.then(handle)
			.then((out) => send(res, out))
			.catch((e) => {
				const tooLarge = e instanceof Error && e.message === "too large";
				if (!tooLarge) console.error("Request failed:", e);
				if (!res.headersSent) send(res, json(tooLarge ? 413 : 500, { error: tooLarge ? "too_large" : "internal_error" }));
				else res.end();
			});
	});
	await new Promise<void>((ok, no) => http.once("error", no).listen(opts.port ?? 8788, host, ok));
	const port = (http.address() as { port: number }).port;
	return {
		url: `http://${host}:${port}/mcp`,
		applied,
		db,
		graph: ai.graph,
		meaning: ai.embeddings,
		vectors,
		key: !!wanted,
		signIn: !!signIn,
		async close() {
			clearInterval(sweep);
			for (const s of sessions.values()) await s.transport.close().catch(() => {});
			http.closeAllConnections();
			await new Promise((ok) => http.close(ok));
			db.close();
			vectors?.close();
			kv?.close();
		},
	};
}

/** Settings can live in a .env file next to where Vault is started (see .env.example). Real environment variables win. */
export function loadSettingsFile(path = ".env") {
	if (existsSync(path)) process.loadEnvFile(path);
}

// Started directly (not imported by a test): read the settings and run
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	loadSettingsFile();
	startVault({
		key: process.env.VAULT_KEY || undefined,
		signIn: process.env,
		dbPath: process.env.VAULT_DB,
		port: process.env.PORT ? Number(process.env.PORT) : undefined,
		host: process.env.HOST,
		ai: process.env,
	}).then(
		(v) => {
			if (v.applied.length) console.log(`Database set up: ${v.applied.join(", ")}`);
			const state = (on: boolean) => (on ? "on" : "off, no AI model set");
			const access = [v.key ? "secret key" : "", v.signIn ? "sign-in page" : ""].filter(Boolean).join(" + ");
			console.log(`Vault is running at ${v.url} (access: ${access}; knowledge graph: ${state(v.graph)}; meaning search: ${state(v.meaning)})`);
		},
		(e) => {
			console.error(e instanceof Error ? e.message : e);
			process.exit(1);
		},
	);
}
