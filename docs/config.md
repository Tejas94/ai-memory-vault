# Settings

The Node build reads these from `.env` ([.env.example](../.env.example) lists them all) or from
environment variables, which win over the file. On Cloudflare, secrets are set with
`npx wrangler secret put <NAME>` and the rest live in `wrangler.jsonc`. Secret values never go in
the repo.

## Node build

| Name | What | Default |
|---|---|---|
| `VAULT_KEY` | secret apps send as `Authorization: Bearer …` (16+ characters); needed unless sign-in is on | none |
| `VAULT_DB` | the database file; `.vectors.db` and `.signin.db` are kept next to it | `./vault.db` |
| `PORT` | port | `8788` |
| `HOST` | `127.0.0.1` = this computer only; `0.0.0.0` in Docker or behind a proxy | `127.0.0.1` |
| `PUBLIC_URL` | the public https address, needed for the sign-in page | none |

## Sign-in (both builds)

| Name | What |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in (the default) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | any OpenID Connect service instead (Microsoft, Auth0, Okta, Keycloak, Authentik…); when `OIDC_ISSUER` is set, Google isn't used |
| `OIDC_SCOPE` | optional; default `openid email profile` |
| `ALLOWED_EMAIL` | the one account allowed in; a service other than Google must say the email is verified |
| `COOKIE_ENCRYPTION_KEY` | protects the sign-in cookies (32+ characters: `openssl rand -hex 32`) |

The return address to register with the sign-in service is `<your Vault address>/callback`.

## AI provider (optional)

By default the Cloudflare build uses Workers AI, and the Node build has no AI (keyword search
only). Set these to use any OpenAI-style service: OpenAI, OpenRouter, Together, or a local model
through Ollama or LM Studio.

| Name | What | Example |
|---|---|---|
| `AI_BASE_URL` | the service's address; nothing changes unless it's set | `http://localhost:11434/v1` |
| `AI_API_KEY` | the service's key; leave out for local models | |
| `AI_GRAPH_MODEL` | chat model that reads saved items for the knowledge graph | `llama3.1`, `gpt-4o-mini` |
| `AI_EMBED_MODEL` | embedding model for meaning search | `bge-m3`, `text-embedding-3-small` |
| `AI_EMBED_DIMENSIONS` | optional vector size; must match the index (1,024 on Cloudflare) | `1024` |
| `AI_EMBED_MIN_SCORE` | optional: similarity below this counts as unrelated (0–1, lower finds more) | `0.45` |

Vectors from different embedding models can't be compared: after changing the model, re-embed
everything (`npm run reindex:node -- --redo`, or `vector-sync.ts run --redo` on Cloudflare).

## Cloudflare bindings (`wrangler.jsonc`)

| Binding | Resource | Used for |
|---|---|---|
| `env.DB` | D1 database `vault` | all data |
| `env.AI` | Workers AI | graph model and meaning fingerprints |
| `env.VECTORS` | Vectorize index `vault-embeddings` (1,024 dimensions, cosine) | meaning search |
| `env.OAUTH_KV` | KV namespace | sign-in tokens and app registrations |
| `env.MCP_OBJECT` | Durable Object `VaultMCP` | one session per connected app; keeps background work running after a reply |

The database and KV ids in `wrangler.jsonc` are zeros here: put your own in
([setup](setup.md#on-cloudflares-free-tier)). The `$schema` line only gives your editor
autocomplete.
