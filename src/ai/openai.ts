// A second AI provider next to Cloudflare Workers AI: any service that speaks the OpenAI HTTP API.
// That covers OpenAI itself, OpenRouter, Together, Azure-style gateways, and local models served by
// Ollama or LM Studio (both offer the same API on this computer, free). It plugs into the two places
// Vault uses AI: reading a saved item for the knowledge graph, and turning text into embeddings for
// meaning search. Nothing here is used unless the settings below are given; the default stays
// Workers AI on Cloudflare.
//
// Settings (Worker: vars / secrets; Node build: environment variables):
//   AI_BASE_URL          e.g. https://api.openai.com/v1  or  http://localhost:11434/v1 (Ollama)
//   AI_API_KEY           the service's key (leave out for local models)
//   AI_GRAPH_MODEL       chat model that reads saved items for the graph, e.g. gpt-4o-mini, llama3.1
//   AI_EMBED_MODEL       embedding model for meaning search, e.g. text-embedding-3-small, bge-m3
//   AI_EMBED_DIMENSIONS  optional: ask the service for vectors of this size (must match the index)
//   AI_EMBED_MIN_SCORE   optional: similarity below this counts as unrelated (default 0.45, tuned for
//                        Workers AI's bge-m3; other models score on a different scale)
import { type Extractor, GRAPH_PROMPT, GRAPH_SCHEMA, setExtractor } from "../graph/extract";
import { type Embedder, setEmbedder, setMinScore } from "../vectors/embed";

export type AiSettings = {
	AI_BASE_URL?: string;
	AI_API_KEY?: string;
	AI_GRAPH_MODEL?: string;
	AI_EMBED_MODEL?: string;
	AI_EMBED_DIMENSIONS?: string | number;
	AI_EMBED_MIN_SCORE?: string | number;
};
type Service = { baseUrl: string; apiKey?: string; fetch?: typeof fetch };

const EMBED_TIMEOUT_MS = 20_000;
const MAX_INPUT = 6_000; // characters of a saved item sent to the graph model per call (as with Workers AI)

async function post<T>(s: Service, path: string, body: unknown, timeoutMs?: number): Promise<T> {
	const res = await (s.fetch ?? fetch)(`${s.baseUrl.replace(/\/+$/, "")}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
		body: JSON.stringify(body),
		...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
	});
	// the status only: an error body can echo the request, and saved text must not reach the logs
	if (!res.ok) throw new Error(`AI service answered ${res.status} for ${path}`);
	return (await res.json()) as T;
}

/** Embeddings from POST {base}/embeddings. */
export const openAiEmbedder =
	(s: Service & { model: string; dimensions?: number }): Embedder =>
	async (_env, texts) => {
		const out = await post<{ data?: { index?: number; embedding: number[] }[] }>(
			s,
			"/embeddings",
			{ model: s.model, input: texts, ...(s.dimensions ? { dimensions: s.dimensions } : {}) },
			EMBED_TIMEOUT_MS,
		);
		const rows = [...(out.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		if (rows.length !== texts.length) throw new Error("embedding model returned no vectors");
		return rows.map((r) => r.embedding);
	};

/** Some models wrap their JSON in a ```json fence or add a sentence around it: take the outermost object. */
function parseJson(content: string): unknown {
	const start = content.indexOf("{");
	const end = content.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("graph model returned no JSON");
	return JSON.parse(content.slice(start, end + 1));
}

/** Entities and relations from POST {base}/chat/completions, with the same prompt and schema as Workers AI. */
export const openAiExtractor =
	(s: Service & { model: string }): Extractor =>
	async (_env, text) => {
		const out = await post<{ choices?: { message?: { content?: string | null } }[] }>(s, "/chat/completions", {
			model: s.model,
			messages: [
				{ role: "system", content: GRAPH_PROMPT },
				{ role: "user", content: text.slice(0, MAX_INPUT) },
			],
			response_format: { type: "json_schema", json_schema: { name: "graph", schema: GRAPH_SCHEMA } },
			max_tokens: 1500,
			temperature: 0,
		});
		const content = out.choices?.[0]?.message?.content;
		if (!content) throw new Error("graph model returned nothing");
		return parseJson(content);
	};

/**
 * Switch to the OpenAI-style service for whichever jobs the settings name. Returns what was switched,
 * so the caller can say so. With no AI_BASE_URL nothing changes.
 */
export function configureAi(settings: AiSettings, fetchImpl?: typeof fetch) {
	const baseUrl = settings.AI_BASE_URL?.trim();
	if (!baseUrl) return { graph: false, embeddings: false };
	const service: Service = { baseUrl, apiKey: settings.AI_API_KEY?.trim() || undefined, fetch: fetchImpl };
	const graphModel = settings.AI_GRAPH_MODEL?.trim();
	const embedModel = settings.AI_EMBED_MODEL?.trim();
	if (graphModel) setExtractor(openAiExtractor({ ...service, model: graphModel }));
	if (embedModel) {
		const dimensions = Number(settings.AI_EMBED_DIMENSIONS) || undefined;
		setEmbedder(openAiEmbedder({ ...service, model: embedModel, dimensions }), embedModel);
		const minScore = Number(settings.AI_EMBED_MIN_SCORE);
		if (minScore > 0 && minScore < 1) setMinScore(minScore);
	}
	return { graph: !!graphModel, embeddings: !!embedModel };
}
