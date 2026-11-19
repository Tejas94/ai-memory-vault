// Vault retrieval eval: asks get_context each exam question and scores what comes back.
//
//   npx tsx evals/run.ts <exam.json> [--remote] [--label graph] [--compare evals/results-….md]
//
// <exam.json>: [{"id":1,"group":"lookup","topic":"laptop","key":[101,111]}, …]
//   key = the fact ids that answer the question. A real-data exam lives OUTSIDE the repo (it is
//   personal); results files only hold numbers and question numbers, so they are safe to commit.
// --remote runs the current code against the live D1 database (needs CLOUDFLARE_API_TOKEN);
//   without it, the local copy. Writes evals/results-YYYY-MM-DD-HHMM[-label].md.
import { readFileSync, writeFileSync } from "node:fs";
import { formatContext, getContext, setBudget, setShortMinScore } from "../src/tools/get_context";
import { openEnv, restEmbedder, restVectorStore } from "../scripts/d1-rest";
import { EMBED_MODEL, INDEX_NAME, setEmbedder, setMinScore, setVectorStore } from "../src/vectors/embed";

type Question = { id: number; group: string; topic: string; key: number[] };
type Score = {
	id: number;
	group: string;
	returned: number;
	relevant: number;
	recall: number;
	precision: number;
	rr: number; // reciprocal rank of the first key fact (1 = top)
	connections: number;
	chars: number;
	ms: number;
};

const args = process.argv.slice(2);
const opt = (name: string) => {
	const i = args.indexOf(`--${name}`);
	if (i < 0) return undefined;
	const v = args[i + 1];
	args.splice(i, v && !v.startsWith("--") ? 2 : 1);
	return v && !v.startsWith("--") ? v : "true";
};
const remote = opt("remote") === "true";
const useRest = opt("rest") === "true"; // --rest: reach the live DB over the HTTP API (scripts/d1-rest.ts)
const label = opt("label");
const compare = opt("compare");
const examPath = args[0];

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const pctl = (xs: number[], p: number) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
};

export function summarise(scores: Score[]) {
	return {
		questions: scores.length,
		recall: avg(scores.map((s) => s.recall)),
		full_answers: scores.filter((s) => s.recall === 1).length,
		misses: scores.filter((s) => s.relevant === 0).length,
		precision: avg(scores.map((s) => s.precision)),
		mrr: avg(scores.map((s) => s.rr)),
		tokens: Math.round(avg(scores.map((s) => s.chars)) / 4),
		p50_ms: pctl(scores.map((s) => s.ms), 0.5),
		p95_ms: pctl(scores.map((s) => s.ms), 0.95),
	};
}
type Summary = ReturnType<typeof summarise>;

function table(rows: [string, Summary][]) {
	const head = "| Run | Recall | Full answers | Nothing found | Precision | MRR | Tokens / call | p50 ms | p95 ms |\n|---|---|---|---|---|---|---|---|---|";
	return [
		head,
		...rows.map(
			([name, s]) =>
				`| ${name} | ${pct(s.recall)} | ${s.full_answers}/${s.questions} | ${s.misses} | ${pct(s.precision)} | ${s.mrr.toFixed(2)} | ${s.tokens} | ${s.p50_ms || "–"} | ${s.p95_ms || "–"} |`,
		),
	].join("\n");
}

/** Read the machine-readable block at the end of an earlier results file. */
const readResults = (file: string): { label: string; summary: Summary; groups: Record<string, Summary>; scores: Score[] } =>
	JSON.parse(readFileSync(file, "utf8").split("<!-- results-json\n")[1].split("\n-->")[0]);

async function main() {
	if (!examPath) throw new Error("Usage: npx tsx evals/run.ts <exam.json> [--remote] [--label name] [--compare file]");
	const exam = JSON.parse(readFileSync(examPath, "utf8")) as Question[];
	const config = remote || useRest ? "scripts/graph-sync.wrangler.jsonc" : "wrangler.jsonc";
	const proxy = await openEnv(config, remote, useRest);
	if (useRest) {
		// meaning search through Cloudflare's HTTP API: same model and index as the live Worker
		setEmbedder(restEmbedder(EMBED_MODEL));
		const store = restVectorStore(INDEX_NAME);
		setVectorStore(() => store);
	}
	const minScore = opt("min-score"); // try other similarity cut-offs, e.g. --min-score 0.5
	if (minScore) setMinScore(Number(minScore));
	const shortMin = opt("short-min"); // cut-off for one- or two-word topics, e.g. --short-min 0.6
	if (shortMin) setShortMinScore(Number(shortMin));
	// From a cloud session each database call is an HTTP round trip, so the 1-second budget would cut
	// searches that are fast inside Cloudflare: give the eval more time unless told otherwise.
	setBudget(Number(opt("budget") ?? 15000));
	const scores: Score[] = [];
	try {
		for (const q of exam) {
			const t0 = performance.now();
			const out = (await getContext.run(proxy.env, "manual", { topic: q.topic })) as {
				facts: { id: number }[];
				connections?: string[];
			};
			const ms = Math.round(performance.now() - t0);
			const ids = out.facts.map((f) => f.id);
			const key = new Set(q.key);
			const relevant = ids.filter((id) => key.has(id)).length;
			const first = ids.findIndex((id) => key.has(id));
			scores.push({
				id: q.id,
				group: q.group,
				returned: ids.length,
				relevant,
				recall: relevant / key.size,
				precision: ids.length ? relevant / ids.length : 0,
				rr: first < 0 ? 0 : 1 / (first + 1),
				connections: out.connections?.length ?? 0,
				chars: formatContext(out as any).length, // what the AI actually reads
				ms,
			});
		}
	} finally {
		await proxy.dispose();
	}
	writeReport(label ?? (remote ? "live" : "local"), scores, compare);
}

export function writeReport(name: string, scores: Score[], compareFile?: string, note?: string) {
	const summary = summarise(scores);
	const groups = Object.fromEntries(
		[...new Set(scores.map((s) => s.group))].map((g) => [g, summarise(scores.filter((s) => s.group === g))]),
	);
	const d = new Date();
	const stamp = d.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
	const file = `evals/results-${stamp}${name ? `-${name}` : ""}.md`;
	const rows: [string, Summary][] = [];
	let previous = "";
	if (compareFile) {
		const prev = readResults(compareFile);
		rows.push([`before (${prev.label})`, prev.summary]);
		previous = `\nCompared with \`${compareFile}\`. By group, before → after:\n\n${Object.keys(groups)
			.map((g) => {
				const a = prev.groups[g];
				const b = groups[g];
				return a ? `- ${g}: recall ${pct(a.recall)} → ${pct(b.recall)}, precision ${pct(a.precision)} → ${pct(b.precision)}, tokens ${a.tokens} → ${b.tokens}` : `- ${g}: new group`;
			})
			.join("\n")}\n\nQuestions that got worse: ${
			scores
				.filter((s) => {
					const p = prev.scores.find((x) => x.id === s.id);
					return p && s.recall < p.recall;
				})
				.map((s) => `Q${s.id}`)
				.join(", ") || "none"
		}\n`;
	}
	rows.push([name, summary]);
	const md = `# Vault eval results: ${name}

Run: ${d.toISOString()}${note ? `\n\n${note}` : ""}

${table(rows)}

By group:

${table(Object.entries(groups))}
${previous}
Per question (numbers only; the questions are kept privately in Vault):

| Q | Group | Returned | Relevant | Recall | Precision | RR | Connections | Chars | ms |
|---|---|---|---|---|---|---|---|---|---|
${scores.map((s) => `| ${s.id} | ${s.group} | ${s.returned} | ${s.relevant} | ${pct(s.recall)} | ${pct(s.precision)} | ${s.rr.toFixed(2)} | ${s.connections} | ${s.chars} | ${s.ms || "–"} |`).join("\n")}

<!-- results-json
${JSON.stringify({ label: name, summary, groups, scores })}
-->
`;
	writeFileSync(file, md);
	console.log(`Wrote ${file}`);
	console.log(table(rows));
	return file;
}

if (process.argv[1]?.endsWith("run.ts")) {
	main().catch((e) => {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	});
}
