// A minimal D1Database that talks to the live database over Cloudflare's HTTP API instead of
// wrangler's remote-bindings tunnel. Used by scripts/graph-sync.ts and evals/run.ts with --rest:
// some machines (e.g. cloud sessions behind an HTTPS proxy) cannot open that tunnel, but plain
// HTTPS to api.cloudflare.com works. Covers only what the code uses: prepare/bind/all/first/run
// and batch (which the API runs as one transaction, like D1's own batch).
//
// Needs env.CLOUDFLARE_ACCOUNT_ID and env.CLOUDFLARE_API_TOKEN. Node's fetch ignores HTTPS_PROXY
// unless NODE_USE_ENV_PROXY=1, so set that too when a proxy is in the way.
import { getPlatformProxy } from "wrangler";

type Row = Record<string, unknown>;
type Result = { results: Row[]; success: boolean; meta: Record<string, unknown> };

class RestStatement {
	constructor(
		readonly db: RestD1,
		readonly sql: string,
		readonly params: unknown[] = [],
	) {}
	bind(...params: unknown[]) {
		return new RestStatement(this.db, this.sql, params);
	}
	async all<T = Row>() {
		return (await this.db.send([this]))[0] as unknown as { results: T[]; success: boolean; meta: any };
	}
	async run() {
		return this.all();
	}
	async first<T = Row>(column?: string): Promise<T | null> {
		const row = (await this.all<Row>()).results[0];
		if (!row) return null;
		return (column ? row[column] : row) as T;
	}
	toJSON() {
		return this.params.length ? { sql: this.sql, params: this.params } : { sql: this.sql };
	}
}

export class RestD1 {
	private url: string;
	constructor(databaseId: string) {
		const account = process.env.CLOUDFLARE_ACCOUNT_ID;
		if (!account) throw new Error("CLOUDFLARE_ACCOUNT_ID is not set");
		this.url = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`;
	}
	prepare(sql: string) {
		return new RestStatement(this, sql);
	}
	async batch(statements: RestStatement[]) {
		return statements.length ? this.send(statements) : [];
	}
	async send(statements: RestStatement[]): Promise<Result[]> {
		const body = statements.length === 1 ? statements[0] : { batch: statements };
		const res = await fetch(this.url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
			body: JSON.stringify(body),
		});
		const data = (await res.json()) as { success: boolean; errors?: { message: string }[]; result?: Result[] };
		if (!data.success || !data.result) {
			throw new Error(`D1_ERROR: ${(data.errors ?? []).map((e) => e.message).join("; ") || res.status}`);
		}
		return data.result;
	}
}

/** The scripts' env: wrangler's platform proxy normally, or the HTTP API with rest = true. */
export async function openEnv(configPath: string, remote: boolean, rest: boolean) {
	if (rest) {
		const { readFileSync } = await import("node:fs");
		const id = /"database_id":\s*"([^"]+)"/.exec(readFileSync(configPath, "utf8"))?.[1];
		if (!id) throw new Error(`No database_id in ${configPath}`);
		return { env: { DB: new RestD1(id) } as unknown as Env, dispose: async () => {} };
	}
	return getPlatformProxy<Env>({ configPath, envFiles: [], remoteBindings: remote });
}

// ---- Workers AI and Vectorize over the HTTP API (for scripts/vector-sync.ts and evals with --rest) ----
// They plug into src/vectors/embed.ts, so the backfill runs the same code and model as the live server.

const api = (path: string) => {
	const account = process.env.CLOUDFLARE_ACCOUNT_ID;
	if (!account) throw new Error("CLOUDFLARE_ACCOUNT_ID is not set");
	return `https://api.cloudflare.com/client/v4/accounts/${account}/${path}`;
};
async function call<T>(path: string, body: BodyInit, contentType = "application/json"): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(api(path), {
			method: "POST",
			headers: { "Content-Type": contentType, Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
			body,
		});
		const data = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: { message: string }[]; result?: T };
		if (data.success && data.result !== undefined) return data.result;
		// rate limits and brief outages: wait and retry a few times
		if ((res.status === 429 || res.status >= 500) && attempt < 4) {
			await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
			continue;
		}
		throw new Error(`${path.split("/")[0]} ${res.status}: ${(data.errors ?? []).map((e) => e.message).join("; ")}`);
	}
}

/** Embedder that calls Workers AI's HTTP endpoint (same model as env.AI.run in the Worker). */
export const restEmbedder = (model: string) => async (_env: unknown, texts: string[]) => {
	const out = await call<{ data: number[][] }>(`ai/run/${model}`, JSON.stringify({ text: texts }));
	if (out.data?.length !== texts.length) throw new Error("embedding model returned no vectors");
	return out.data;
};

/** Vector store that calls Vectorize's HTTP API (same index as env.VECTORS in the Worker). */
export const restVectorStore = (index: string) => {
	const base = `vectorize/v2/indexes/${index}`;
	return {
		upsert: (vectors: { id: string; values: number[]; namespace: string; metadata: Record<string, string | number> }[]) =>
			call(`${base}/upsert`, vectors.map((v) => JSON.stringify(v)).join("\n"), "application/x-ndjson"),
		deleteByIds: (ids: string[]) => call(`${base}/delete_by_ids`, JSON.stringify({ ids })),
		query: async (vector: number[], opts: { topK: number; namespace: string }) =>
			(await call<{ matches: { id: string; score: number; metadata?: Record<string, unknown> }[] }>(
				`${base}/query`,
				JSON.stringify({ vector, topK: opts.topK, namespace: opts.namespace, returnMetadata: "all", returnValues: false }),
			)).matches,
		info: () => fetch(api(`${base}/info`), { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } }).then((r) => r.json()),
		create: (dimensions: number) =>
			call("vectorize/v2/indexes", JSON.stringify({ name: index, description: "Vault meaning search", config: { dimensions, metric: "cosine" } })),
	};
};
