# Vault evals

How we prove each change (knowledge graph, then vectors) actually helps: the same exam is run
before and after, and the numbers are compared.

## How it works

1. **An exam**: questions, each with the `topic` an AI would pass to `get_context` and an answer
   key (the fact ids that answer it). Three groups:
   - `lookup`: simple ("What laptop do I have?")
   - `wording`: the question uses different words from the fact ("my sister" vs the sister's name, "car" vs a car model)
   - `connected`: needs several facts or the latest version of a changed fact
2. **The runner** (`evals/run.ts`) calls `get_context` for each question and checks which key facts
   came back. Scoring is by fact id, so it needs no AI, costs nothing and gives the same result
   every run.
3. **A results file** `evals/results-YYYY-MM-DD-HHMM-<label>.md` (UTC time) with the summary, the
   breakdown by group, per-question scores and a machine-readable block for later comparisons.

A real-data exam is personal, so it is **not** in this repo: keep it as a JSON file outside the
repo. Results files contain only numbers and question numbers. The author's own results files were
left out of this repo because they measure a private Vault; the headline numbers are below.

## Measures (the standard ones for retrieval and memory systems)

| Measure | Meaning | Better |
|---|---|---|
| Recall | Share of the answer-key facts that came back (Recall@k, k = facts returned) | higher |
| Full answers | Questions where every key fact came back | higher |
| Nothing found | Questions where no key fact came back | lower |
| Precision | Share of returned facts that were relevant (the rest is noise the AI has to read) | higher |
| MRR | Mean Reciprocal Rank: 1 if the first relevant fact is at the top, 0.5 if second, … | higher |
| Tokens / call | Size of the reply (characters ÷ 4): what every chat pays to read it | lower |
| p50 / p95 ms | Typical and slow-case time per call | lower |

These are the same ideas used in search and RAG evaluation (Recall@k, Precision@k, MRR; "context
recall" and "context precision" in RAG tools). Memory benchmarks such as LongMemEval and LoCoMo
add a further step: an AI answers each question using the retrieved context and a grader checks
the answer. That step can be added later; scoring by fact id comes first because it is free and
repeatable.

## Run it

```bash
# against the live database (needs CLOUDFLARE_API_TOKEN), compared with an earlier result
npx tsx evals/run.ts /path/outside/repo/real-exam.json --remote --label graph \
  --compare evals/results-<earlier run>.md

# against the local copy (wrangler d1 migrations apply vault --local first)
npx tsx evals/run.ts /path/to/exam.json --label local
```

`--remote` runs this repo's current code against the live data, so a change can be measured before
it is deployed. Timings from a cloud session include the network trip to the database, so compare
timings only between runs made from the same place.

## Results so far

Measured on the author's private exam (30 questions, 36 from the categories step on):

| Step | Result |
|---|---|
| Baseline, before the graph | 65% recall, 8% precision, ~1,600 tokens per call |
| Knowledge graph | 55% recall, 37% precision, ~400 tokens |
| Graph + meaning search | 83% recall, 21/30 full answers, ~600 tokens |
| Live sync check after deploy | saves, updates and forgets keep graph + index in step, 13/13 |
| Markdown reply, no duplicates, categories (36 questions) | 94% recall, 32/36 |

## Live sync check (after each deploy)

`evals/live-sync.ts` checks the deployed Vault end to end: test items are saved, updated and
forgotten through the real app connection (`/mcp`), then the checker confirms each one's graph links
and meaning-search vectors were added or removed, and how long the background work took.

```bash
npx tsx evals/live-sync.ts /path/outside/repo/steps.json --remote --rest --label live-sync
```

Use made-up test items and forget them at the end. Results: `evals/results-…-live-sync.md`.
