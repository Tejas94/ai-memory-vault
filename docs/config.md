# Settings

The Worker's settings are in `wrangler.jsonc`. Secret values are never in the repo: set them with
`npx wrangler secret put <NAME>`; the code refers to them only as `env.NAME`.

## Secrets (names only)

| Name | What |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | the Google sign-in client; its return address is `https://vault.<your-subdomain>.workers.dev/callback` |
| `COOKIE_ENCRYPTION_KEY` | protects the sign-in cookies (any long random string) |
| `ALLOWED_EMAIL` | the one Google account allowed to sign in |

## Bindings (`wrangler.jsonc`)

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

## The Cloudflare API key (for scripts and deploys)

The live Vault doesn't use it. Deploys, migrations and catch-ups run from a Claude Code session do.
It needs D1, Workers Scripts, Workers AI and Vectorize (Edit), and Account Settings (Read). Scripts
with `--rest` read `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the environment.
