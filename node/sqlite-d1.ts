// A plain SQLite file with the same interface as Cloudflare D1, so Vault's tools run unchanged
// outside Cloudflare. D1 is SQLite underneath: the same tables, triggers, keyword search (FTS5) and
// queries work as they are. Uses Node's built-in SQLite (node:sqlite), so there is nothing to install.
// Covers what the code uses: prepare / bind / all / first / run, and batch as one transaction.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;
type Result<T = Row> = { results: T[]; success: true; meta: { changes: number; last_row_id: number } };

// D1 accepts booleans and treats undefined as an error; SQLite wants numbers and nulls
const toSql = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v) as null | number | string;

class Statement {
	constructor(
		private readonly db: DatabaseSync,
		private readonly sql: string,
		private readonly params: unknown[] = [],
	) {}
	bind(...params: unknown[]) {
		return new Statement(this.db, this.sql, params);
	}
	/** Runs now (SQLite calls are synchronous); the async methods below wrap it. */
	exec<T = Row>(): Result<T> {
		// Numbered placeholders (?1 used twice) become plain ? with the values repeated:
		// Node 22's SQLite can't bind a numbered placeholder that appears more than once.
		let sql = this.sql;
		let params = this.params.map(toSql);
		if (/\?\d/.test(sql)) {
			const given = params;
			params = [];
			sql = sql.replace(/\?(\d+)/g, (_, n) => {
				params.push(given[Number(n) - 1]);
				return "?";
			});
		}
		const stmt = this.db.prepare(sql);
		if (stmt.columns().length) {
			// a query (SELECT, or a write with RETURNING): rows come back
			const results = stmt.all(...params).map((r) => ({ ...r })) as T[];
			return { results, success: true, meta: { changes: 0, last_row_id: 0 } };
		}
		const done = stmt.run(...params);
		return { results: [], success: true, meta: { changes: Number(done.changes), last_row_id: Number(done.lastInsertRowid) } };
	}
	async all<T = Row>() {
		return this.exec<T>();
	}
	async run() {
		return this.exec();
	}
	async first<T = Row>(column?: string): Promise<T | null> {
		const row = this.exec<Row>().results[0];
		if (!row) return null;
		return (column ? row[column] : row) as T;
	}
}

export class SqliteD1 {
	readonly db: DatabaseSync;
	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
	}
	prepare(sql: string) {
		return new Statement(this.db, sql);
	}
	/** All statements or none, like D1's batch. */
	async batch(statements: Statement[]) {
		this.db.exec("BEGIN");
		try {
			const out = statements.map((s) => s.exec());
			this.db.exec("COMMIT");
			return out;
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}
	close() {
		this.db.close();
	}
}

/** Apply the numbered files in migrations/ that this database hasn't had yet, in order. Returns their names. */
export function applyMigrations(d1: SqliteD1, dir: string): string[] {
	const db = d1.db;
	db.exec("CREATE TABLE IF NOT EXISTS vault_migrations (name TEXT PRIMARY KEY, applied TEXT NOT NULL)");
	const done = new Set(db.prepare("SELECT name FROM vault_migrations").all().map((r) => String(r.name)));
	const applied: string[] = [];
	for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
		if (done.has(name)) continue;
		db.exec("BEGIN");
		try {
			db.exec(readFileSync(join(dir, name), "utf8"));
			db.prepare("INSERT INTO vault_migrations (name, applied) VALUES (?, ?)").run(name, new Date().toISOString());
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw new Error(`Migration ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		applied.push(name);
	}
	return applied;
}
