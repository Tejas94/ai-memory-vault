// The OpenAI-style AI provider, against a pretend service (no network). Fictional data only.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { configureAi, openAiEmbedder, openAiExtractor } from "../src/ai/openai";
import { aiExtract, setExtractor, updateGraph } from "../src/graph/extract";
import { setEmbedder } from "../src/vectors/embed";
import { fakeEmbedder } from "./fake-vectors";

type Call = { url: string; headers: Record<string, string>; body: any };
/** A pretend AI service: records each request and answers with `answer(call)`. */
function pretend(answer: (c: Call) => unknown, status = 200) {
	const calls: Call[] = [];
	const fetchImpl = (async (url: any, init: any) => {
		const call = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
		calls.push(call);
		return new Response(JSON.stringify(answer(call)), { status });
	}) as typeof fetch;
	return { calls, fetchImpl };
}
const chat = (content: string) => ({ choices: [{ message: { content } }] });
const GRAPH = { entities: [{ name: "Priya", type: "person" }], relations: [{ from: "Priya", relation: "lives_in", value: "Leeds" }] };

afterEach(() => {
	setExtractor(aiExtract);
	setEmbedder(fakeEmbedder);
});

describe("embeddings from an OpenAI-style service", () => {
	it("sends the texts and key, and returns vectors in the order asked", async () => {
		const { calls, fetchImpl } = pretend(() => ({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }));
		const embed = openAiEmbedder({ baseUrl: "https://ai.example/v1/", apiKey: "k", model: "m", dimensions: 1024, fetch: fetchImpl });
		expect(await embed(env, ["a", "b"])).toEqual([[1], [2]]);
		expect(calls[0].url).toBe("https://ai.example/v1/embeddings");
		expect(calls[0].headers.Authorization).toBe("Bearer k");
		expect(calls[0].body).toEqual({ model: "m", input: ["a", "b"], dimensions: 1024 });
	});

	it("sends no key or size when none is set (local models)", async () => {
		const { calls, fetchImpl } = pretend(() => ({ data: [{ embedding: [1] }] }));
		await openAiEmbedder({ baseUrl: "http://localhost:11434/v1", model: "m", fetch: fetchImpl })(env, ["a"]);
		expect(calls[0].headers.Authorization).toBeUndefined();
		expect(calls[0].body.dimensions).toBeUndefined();
	});

	it("fails when vectors are missing, without echoing the service's reply", async () => {
		const short = pretend(() => ({ data: [] }));
		await expect(openAiEmbedder({ baseUrl: "https://ai.example/v1", model: "m", fetch: short.fetchImpl })(env, ["a"])).rejects.toThrow("no vectors");
		const down = pretend(() => ({ error: "Alex's private text" }), 500);
		await expect(openAiEmbedder({ baseUrl: "https://ai.example/v1", model: "m", fetch: down.fetchImpl })(env, ["a"])).rejects.toThrow(
			/^AI service answered 500 for \/embeddings$/,
		);
	});
});

describe("graph reading from an OpenAI-style service", () => {
	it("sends Vault's prompt and schema and reads the JSON back", async () => {
		const { calls, fetchImpl } = pretend(() => chat(JSON.stringify(GRAPH)));
		const extract = openAiExtractor({ baseUrl: "https://ai.example/v1", model: "chat-m", fetch: fetchImpl });
		expect(await extract(env, "Fact: Priya lives in Leeds", { type: "fact", id: "1" })).toEqual(GRAPH);
		const body = calls[0].body;
		expect(calls[0].url).toBe("https://ai.example/v1/chat/completions");
		expect(body.model).toBe("chat-m");
		expect(body.messages[0].content).toContain("personal knowledge graph");
		expect(body.messages[1].content).toBe("Fact: Priya lives in Leeds");
		expect(body.response_format.json_schema.schema.required).toEqual(["entities", "relations"]);
	});

	it("copes with JSON wrapped in a code fence or a sentence", async () => {
		const { fetchImpl } = pretend(() => chat(`Here you go:\n\`\`\`json\n${JSON.stringify(GRAPH)}\n\`\`\``));
		expect(await openAiExtractor({ baseUrl: "https://ai.example/v1", model: "m", fetch: fetchImpl })(env, "x", { type: "fact", id: "1" })).toEqual(GRAPH);
	});

	it("fails on an empty or non-JSON answer", async () => {
		for (const content of ["", "sorry, I can't"]) {
			const { fetchImpl } = pretend(() => chat(content));
			await expect(openAiExtractor({ baseUrl: "https://ai.example/v1", model: "m", fetch: fetchImpl })(env, "x", { type: "fact", id: "1" })).rejects.toThrow();
		}
	});
});

describe("choosing the provider from settings", () => {
	it("changes nothing without AI_BASE_URL", () => {
		expect(configureAi({ AI_GRAPH_MODEL: "m", AI_EMBED_MODEL: "e" })).toEqual({ graph: false, embeddings: false });
	});

	it("switches only the jobs that have a model", () => {
		expect(configureAi({ AI_BASE_URL: "https://ai.example/v1", AI_GRAPH_MODEL: "m" })).toEqual({ graph: true, embeddings: false });
	});

	it("a configured graph model fills the knowledge graph after a save", async () => {
		const { fetchImpl } = pretend(() => chat(JSON.stringify(GRAPH)));
		configureAi({ AI_BASE_URL: "https://ai.example/v1", AI_GRAPH_MODEL: "m" }, fetchImpl);
		await updateGraph(env, { type: "fact", id: "9001" }, "Fact (people): Priya lives in Leeds");
		const link = await env.DB.prepare("SELECT relation, value FROM relations WHERE active = 1 AND origin_type = 'fact' AND origin_id = '9001'").first();
		expect(link).toEqual({ relation: "lives_in", value: "Leeds" });
	});

	it("a failing AI service never breaks the save: it is logged instead", async () => {
		const { fetchImpl } = pretend(() => ({}), 503);
		configureAi({ AI_BASE_URL: "https://ai.example/v1", AI_GRAPH_MODEL: "m" }, fetchImpl);
		await updateGraph(env, { type: "fact", id: "9002" }, "Fact (people): Priya lives in Leeds");
		const log = await env.DB.prepare("SELECT status, detail FROM graph_log WHERE item_id = '9002'").first();
		expect(log).toEqual({ status: "failed", detail: "AI service answered 503 for /chat/completions" });
	});
});
