# Limits

On Cloudflare, Vault runs entirely on the free plan; nothing is ever charged. (The Node build has
no allowances: only your own computer and AI service set the pace. Vault's own caps below apply to both.) If an allowance runs out,
that part pauses until it resets and the rest keeps working. Allowances checked against Cloudflare's
pricing pages on 5 Nov 2026; they change now and then, so check the links when in doubt.

## Free-tier allowances

| Service | Free allowance | What Vault uses | Room |
|---|---|---|---|
| **Workers AI** ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)) | 10,000 neurons per day | Graph model `llama-3.3-70b-instruct-fp8-fast`: 26,668 neurons per million input tokens, 204,805 per million output tokens, so **about 140 per typical save** (up to ~600 for a long chat). Fingerprints `bge-m3`: 1,075 per million tokens, so almost nothing. | **About 70 saves a day** get graph links. Beyond that the save still works; the graph step fails, is logged, and a [catch-up](setup.md#catch-up) fills it next day. |
| **Vectorize, stored** ([pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)) | 5 million stored dimensions | 1,024 per piece | **About 4,800 pieces.** The limit to watch: `vector-sync status` shows the count. |
| **Vectorize, queried** | 30 million queried dimensions per month, counted as (searches + stored pieces) × 1,024 | `get_context`: 1 search; `search_history`: 2 | **About 27,000 searches a month** (~870 a day) at today's size; fewer as the index grows. |
| **D1** (database) | 5 GB storage; 5 million rows read and 100,000 rows written per day | a small fraction of the 5 GB; a save writes a few rows (more for long chats) | Plenty |
| **Workers** (the server) | 100,000 requests per day | a few per tool call | Plenty |

Daily allowances reset at 00:00 UTC.

## Vault's own caps

| What | Cap | Why |
|---|---|---|
| A fact | 300 characters | facts are short; longer things are documents |
| A message in a saved chat | 50,000 characters (trimmed with a note) | keeps one paste from filling the database |
| A document | ~200,000 characters (trimmed with a note) | same |
| `get_context` reply | 15 facts, 8 connections, ~600 tokens by default (`max_tokens` up to 4,000) | every chat pays to read it |
| `search_history` | 5 results per kind by default (up to 20); ±2 neighbouring messages per hit | snippets first; full text via `get_conversation` / `get_document` |
| Each search in `get_context` / `search_history` | 1 second, then left out and named in the reply | a slow part never holds up the answer |
| Graph reading per save | 4 parts of 6,000 characters (a longer chat is logged as partly read) | free AI allowance |
| Meaning index per item | 40 pieces of ~1,500 characters (very long chats are only partly covered) | free storage |
| Meaning-search cut-off | similarity 0.45 | tuned on the exam ([why](how-it-works.md#why-its-built-this-way)) |

## Timing

| What | Typical |
|---|---|
| A save, until "Saved ✓" | a fraction of a second (one database write) |
| Graph links ready | 4–11 seconds after the save |
| Fingerprint made | 1–2 seconds after the save |
| Findable by meaning | 1–3 minutes after the save (Vectorize files new entries in batches) |
| `get_context` | about a second, never more than the 1-second budget per search plus assembly |
