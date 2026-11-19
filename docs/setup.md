# Set up and run Vault

Vault runs on Cloudflare's free tier, so there's nothing to keep running yourself. It starts empty
and fills up as your apps save to it.

## On Cloudflare's free tier

You need a free Cloudflare account and a Google sign-in client.

**First time:**

```sh
npm install
npx wrangler login
npx wrangler d1 create vault                     # copy its id into wrangler.jsonc (database_id)
npx wrangler kv namespace create OAUTH_KV        # copy its id into wrangler.jsonc (kv_namespaces)
npx wrangler vectorize create vault-embeddings --dimensions=1024 --metric=cosine
npx wrangler d1 migrations apply vault --remote  # create the tables
```

Set the secrets (the Google client's return address is `https://vault.<your-subdomain>.workers.dev/callback`):

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY    # any long random string
npx wrangler secret put ALLOWED_EMAIL            # the one account allowed in
npx wrangler deploy
```

**Each new version:** run `npm test`, `npm run type-check` and `npx wrangler deploy --dry-run`.
If the change adds a file in `migrations/`, apply it first, then `npx wrangler deploy` and note the
Version ID it prints. If tools were added or renamed, disconnect and reconnect Vault in each app.

**Roll back** in seconds with `npx wrangler rollback <version-id>` (see `npx wrangler deployments list`).
Your data stays as it is.

**From a Claude Code cloud session**, the session's proxy adds the Cloudflare key: prefix commands
with `NODE_USE_ENV_PROXY=1 CLOUDFLARE_API_TOKEN=dummy-replaced-by-proxy`, set `CLOUDFLARE_ACCOUNT_ID`,
and give scripts `--remote --rest`. The key needs D1, Workers Scripts, Workers AI and Vectorize (Edit),
and Account Settings (Read).

## Catch-up

Every save updates the graph and meaning index by itself. A catch-up fills gaps: items saved
before a deploy, or a day the free AI allowance ran out. All commands are safe to run twice.

| Command | Does |
|---|---|
| `npx tsx scripts/vector-sync.ts status\|run\|tidy --remote --rest` | Count, fill and tidy the meaning index (`run --redo` re-does everything) |
| `npx tsx scripts/graph-sync.ts status\|export\|import\|tidy --remote` | Count the graph, export items missing from it and import reviewed links |

Without `--remote`, scripts use the local copy of the database (`npm run db:local`). Folders the
scripts export to must be outside the repo.

## When something looks wrong

| You see | Do this |
|---|---|
| A just-saved fact isn't found with different words | Wait 1–3 minutes (the meaning index files new entries in batches). The same words find it at once. |
| "left out because it was slow or unavailable: meaning search" | Ask again; the rest of the answer was complete. |
| A save has no graph links | The model failed or the free daily allowance ran out: catch up the next day. |
| An app shows old tools | Disconnect and reconnect Vault in that app. |
| Sign-in loops | Finish the sign-in in the same browser you started it in, with the allowed account. |
| "This app is not allowed to sign in to Vault" | Add the app's return address ([connect apps](connect-apps.md#a-new-app)). |
| You need something you forgot | Ask the app to "show what Vault has about X, including old versions", then save it again. |
| More detail | `npx wrangler tail vault` shows each request and error; every background step is logged in `graph_log`. |
