// The sign-in store for the Node build: what the KV namespace OAUTH_KV is on Cloudflare. It holds the
// apps that registered, the sign-ins they were granted and their (hashed) tokens, in a small SQLite
// file next to the database (vault.db → vault.signin.db). Entries expire and are deleted, which the
// main database never allows, so it is its own file. Deleting the file signs every app out; nothing
// else is lost. Covers what the sign-in code uses: get, put (with expiry), delete and list by prefix.
import { DatabaseSync } from "node:sqlite";

type PutOptions = { expirationTtl?: number; expiration?: number };
type ListOptions = { prefix?: string; limit?: number; cursor?: string };

export class SqliteKV {
	readonly db: DatabaseSync;
	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER)`);
	}
	private now = () => Math.floor(Date.now() / 1000);

	async get(key: string, opts?: "text" | "json" | { type?: "text" | "json" }): Promise<any> {
		const row = this.db.prepare("SELECT value FROM kv WHERE key = ? AND (expires IS NULL OR expires > ?)").get(key, this.now()) as
			| { value: string }
			| undefined;
		if (!row) return null;
		const type = typeof opts === "string" ? opts : opts?.type;
		return type === "json" ? JSON.parse(row.value) : row.value;
	}
	async put(key: string, value: string, opts: PutOptions = {}) {
		const expires = opts.expiration ?? (opts.expirationTtl ? this.now() + opts.expirationTtl : null);
		this.db.prepare("INSERT OR REPLACE INTO kv (key, value, expires) VALUES (?, ?, ?)").run(key, String(value), expires);
	}
	async delete(key: string) {
		this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
	}
	async list(opts: ListOptions = {}) {
		this.db.prepare("DELETE FROM kv WHERE expires IS NOT NULL AND expires <= ?").run(this.now()); // tidy as we go
		const limit = Math.min(opts.limit ?? 1000, 1000);
		// prefix match by range, so % and _ in a prefix mean themselves; the cursor is the last key seen
		const prefix = opts.prefix ?? "";
		const rows = this.db
			.prepare("SELECT key, expires FROM kv WHERE key >= ? AND key < ? AND key > ? ORDER BY key LIMIT ?")
			.all(prefix, `${prefix}\u{10FFFF}`, opts.cursor ?? "", limit + 1) as { key: string; expires: number | null }[];
		const page = rows.slice(0, limit);
		const more = rows.length > limit;
		return {
			keys: page.map((r) => ({ name: r.key, ...(r.expires ? { expiration: r.expires } : {}) })),
			list_complete: !more,
			...(more ? { cursor: page[page.length - 1].key } : {}),
		};
	}
	close() {
		this.db.close();
	}
}

/** vault.db → vault.signin.db; an in-memory database gets an in-memory store. */
export const kvPathFor = (dbPath: string) => (dbPath === ":memory:" ? ":memory:" : dbPath.replace(/(\.db|\.sqlite)?$/, ".signin.db"));
