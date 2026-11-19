// Test stand-ins for Workers AI embeddings and Vectorize, so tests never reach Cloudflare.
// The fake "model" hashes words into 64 numbers; SYNONYMS lets a test pretend two words mean the same.
import type { Embedder, VectorStore } from "../src/vectors/embed";

export const SYNONYMS: Record<string, string> = {};
const words = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((w) => w.length > 2);

export const fakeEmbedder: Embedder = async (_env, texts) =>
	texts.map((t) => {
		const v = new Array(64).fill(0);
		for (const w0 of words(t)) {
			const w = SYNONYMS[w0] ?? w0;
			let h = 0;
			for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
			v[h % 64] += 1;
		}
		const n = Math.hypot(...v) || 1;
		return v.map((x) => x / n);
	});

export const memoryIndex = new Map<string, { values: number[]; namespace: string; metadata: Record<string, string | number> }>();
export const memoryStore: VectorStore = {
	upsert: async (vs) => {
		for (const v of vs) memoryIndex.set(v.id, v);
	},
	deleteByIds: async (ids) => {
		for (const id of ids) memoryIndex.delete(id);
	},
	query: async (q, { topK, namespace }) =>
		[...memoryIndex.entries()]
			.filter(([, v]) => v.namespace === namespace)
			.map(([id, v]) => ({ id, score: v.values.reduce((s, x, i) => s + x * q[i], 0), metadata: v.metadata }))
			.sort((a, b) => b.score - a.score)
			.slice(0, topK),
};
