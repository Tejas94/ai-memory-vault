# AGENTS.md

Instructions for AI coding tools (Claude Code, Codex, Cursor and others) working on this repo.
`CLAUDE.md` points here; keep the rules in this one file.

## What this is

Vault: a personal memory server shared by all of the owner's AI apps. A Cloudflare Worker (TypeScript)
serving MCP at `/mcp` to every app (Claude, ChatGPT, Claude Code), backed by D1, with a knowledge
graph and meaning search (Workers AI + Vectorize) kept in step in the background after each save.
If someone asks you to set Vault up for them, follow [SETUP.md](SETUP.md).
Start with [README.md](README.md) and [docs/how-it-works.md](docs/how-it-works.md).

## Hard rules

- **Free tier only.** No paid APIs, no scheduled jobs.
- **Never delete or edit rows in place.** Update = old row `active = 0` (+ `deactivated`) and a new
  row `active = 1` with `replaces_id` = old `row_id`, in one D1 batch. Reads filter `active = 1`.
  The database enforces this with triggers; don't remove them.
- **Schema changes only via a new numbered file in `migrations/`.** Never edit an applied migration.
- **`source` is stamped by the server** from the signed-in app, never taken from the AI.
- **Saves reply first.** A save writes and replies; graph and embedding work goes through
  `afterSave` / `afterForget` (`src/sync.ts`) in the background and must never make a save fail.
- **No real personal data in tests or the repo.** Tests use fictional data ("Alex" is the owner).
  Exports, exam questions and backfill files stay outside the repo.

## Secrets and safety

- Do not read `.env` or `.dev.vars`. Do not run `wrangler login` or `wrangler secret put`:
  the owner does those. Refer to secrets only as `env.NAME`.
- Ask before any `--remote` database command, any script with `--remote`, and `wrangler deploy`.
- Never print, paste or commit a key's value.

## Commands

```sh
npm test               # all tests: local database, fake model, in-memory index; nothing remote
npx tsc --noEmit       # type check
npm run dev            # local server on :8788
npx wrangler deploy --dry-run
```

Scripts and their flags: [docs/setup.md](docs/setup.md#catch-up) and the comment at the top of each script. From a cloud session
behind a proxy, live-database scripts need `--remote --rest` and
`NODE_USE_ENV_PROXY=1 CLOUDFLARE_API_TOKEN=dummy-replaced-by-proxy` ([setup](docs/setup.md#on-cloudflares-free-tier)).

## Where things are

| Path | What |
|---|---|
| `src/index.ts`, `src/mcp.ts` | Worker entry, MCP server, tool list, shared instructions for apps |
| `src/tools/*.ts` | one file per tool; `budget.ts` is the shared search time budget |
| `src/sync.ts` | after every save/forget: graph + embeddings in the background |
| `src/graph/` | knowledge graph: schema (types, relations, categories), extract (Workers AI), write, read |
| `src/vectors/embed.ts` | pieces, fingerprints, Vectorize upkeep, meaning search |
| `src/auth.ts`, `src/google-handler.ts` | sign-in, allowed apps, source labels |
| `migrations/` | the schema, in order |
| `scripts/` | backfill and catch-up (`graph-sync.ts`, `vector-sync.ts`), REST stand-ins (`d1-rest.ts`) |
| `evals/` | the exam runner, the live check, results (numbers only) |
| `test/` | tests; `fake-vectors.ts` is the fake model and index |

## Working style

- Explain in the simplest layman terms. Explain each step briefly before running
  commands. For larger changes, give a plain-English plan first and wait for a yes.
- Measure retrieval changes with the exam before and after ([evals](evals/README.md)).
- Prefer the simplest change that works; keep diffs small.

## Keep the docs current

Every change that affects behaviour updates the matching docs in the same commit:

| If you change | Update |
|---|---|
| a tool's inputs, output or description | `docs/tools.md` |
| a cap, budget, cut-off or free-tier use | `docs/limits.md` |
| settings, bindings, secrets or sign-in | `docs/config.md` |
| how saving or searching works, tables, the graph's types and categories, or a design choice | `docs/how-it-works.md` |
| a setup, deploy, catch-up or script step | `docs/setup.md` |
| connecting apps | `docs/connect-apps.md` |

Add results files in `evals/` when the exam was run.
