// The meaning index for the Node build: what Vectorize is on Cloudflare, kept in a small SQLite file
// next to the database (vault.db → vault.vectors.db). It holds only numbers plus {type, id, part},
// never text, and can be rebuilt from the database at any time (node/reindex.ts).
//
// Search compares the question with every stored vector of that kind (exact, no approximation).
// That is fast enough for a personal memory: tens of thousands of vectors take a few milliseconds
// to tens of milliseconds. Vectors are stored at unit length, so the score is the cosine similarity,
// the same measure the Cloudflare index uses.
import { DatabaseSync } from "node:sqlite";
import type { VectorStore } from "../src/vectors/embed";

const unit = (values: number[]) => {
	const v = Float32Array.from(values);
	let sum = 0;
	for (const x of v) sum += x * x;
	const n = Math.sqrt(sum) || 1;
	for (let i = 0; i < v.length; i++) v[i] /= n;
	return v;
};

export class SqliteVectors implements VectorStore {
	readonly db: DatabaseSync;
	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS vectors (
				id        TEXT PRIMARY KEY,
				namespace TEXT NOT NULL,     -- the item kind: fact / conversation / document / project / profile
				dims      INTEGER NOT NULL,  -- vector size; only vectors of the question's size are compared
				vec       BLOB NOT NULL,     -- unit-length 32-bit floats
				metadata  TEXT NOT NULL      -- {"type","id","part"}
			);
			CREATE INDEX IF NOT EXISTS vectors_ns ON vectors(namespace, dims);`);
	}
	async upsert(vectors: { id: string; values: number[]; namespace: string; metadata: Record<string, string | number> }[]) {
		const put = this.db.prepare("INSERT OR REPLACE INTO vectors (id, namespace, dims, vec, metadata) VALUES (?, ?, ?, ?, ?)");
		this.db.exec("BEGIN");
		try {
			for (const v of vectors) {
				const u = unit(v.values);
				put.run(v.id, v.namespace, u.length, new Uint8Array(u.buffer), JSON.stringify(v.metadata));
			}
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}
	async deleteByIds(ids: string[]) {
		this.db.prepare("DELETE FROM vectors WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids));
	}
	async query(values: number[], opts: { topK: number; namespace: string }) {
		const q = unit(values);
		const rows = this.db.prepare("SELECT id, vec, metadata FROM vectors WHERE namespace = ? AND dims = ?").all(opts.namespace, q.length) as {
			id: string;
			vec: Uint8Array;
			metadata: string;
		}[];
		const scored = rows.map((r) => {
			// copy: a BLOB's bytes are not guaranteed to start on a 4-byte boundary
			const v = new Float32Array(r.vec.slice().buffer);
			let score = 0;
			for (let i = 0; i < v.length; i++) score += v[i] * q[i];
			return { id: r.id, score, metadata: r.metadata };
		});
		return scored
			.sort((a, b) => b.score - a.score)
			.slice(0, opts.topK)
			.map((r) => ({ id: r.id, score: r.score, metadata: JSON.parse(r.metadata) as Record<string, unknown> }));
	}
	count() {
		return Number((this.db.prepare("SELECT count(*) AS n FROM vectors").get() as { n: number }).n);
	}
	close() {
		this.db.close();
	}
}

/** vault.db → vault.vectors.db; an in-memory database gets an in-memory index. */
export const vectorsPathFor = (dbPath: string) => (dbPath === ":memory:" ? ":memory:" : dbPath.replace(/(\.db|\.sqlite)?$/, ".vectors.db"));
