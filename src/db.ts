// Shared D1 helpers. Rule: reads filter active = 1; updates deactivate + insert in one batch.

export const now = () => new Date().toISOString();

/** Trim and collapse whitespace so "I  like tea " and "I like tea" are the same fact. */
export const cleanText = (s: string) => s.replace(/\s+/g, " ").trim();

/** SQL condition: the fact is current and not an expired temporary fact. Expects alias `f`. */
export const LIVE_FACT = "f.active = 1 AND (f.expires IS NULL OR f.expires > ?)";

/**
 * Turn free text into a safe FTS5 query. Each word is quoted so punctuation like
 * "car?" or "don't" can't break the FTS syntax. mode "and" needs every word, "or" any word.
 */
export function ftsQuery(text: string, mode: "and" | "or"): string | null {
	const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	const unique = [...new Set(words)].slice(0, 12);
	if (unique.length === 0) return null;
	return unique.map((w) => `"${w}"`).join(mode === "and" ? " " : " OR ");
}

/** Cut long text for snippets so responses stay small. */
export const clip = (s: string | null, max: number) =>
	s == null || s.length <= max ? s : `${s.slice(0, max)}…`;

/** Cut text to `max` characters with a visible note, so stored text never silently loses its end. */
export function capText(s: string, max: number): { text: string; truncated: boolean } {
	if (s.length <= max) return { text: s, truncated: false };
	return { text: `${s.slice(0, max)}\n\n[… trimmed by Vault: original was ${s.length} characters]`, truncated: true };
}

/** New stable logical id, e.g. "vault:…" for conversations or "doc:…" for documents. */
export const newId = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;

/** Turn a name into a project slug: "Job Search 2026" → "job-search-2026". */
export const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

/**
 * Statement that retires the current version of a row (active = 0, deactivated stamped).
 * Put it in the same D1 batch as the INSERT of the new version so the swap is atomic.
 */
export const retire = (db: D1Database, table: string, where: string, ...params: unknown[]) =>
	db.prepare(`UPDATE ${table} SET active = 0, deactivated = ? WHERE active = 1 AND ${where}`).bind(now(), ...params);

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
	const { results } = await db.prepare(sql).bind(...params).all<T>();
	return results;
}

export async function first<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
	return db.prepare(sql).bind(...params).first<T>();
}
