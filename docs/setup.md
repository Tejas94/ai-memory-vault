# Set up and run Vault

Pick one: **on any computer** (Node or Docker, no account needed) or **on Cloudflare's free tier**
(nothing to keep running yourself). The tools and the database are the same either way, and Vault
starts empty.

## On any computer

You need Node 22.16 or newer (Node 22, 24 and 26 are tested). Older versions, and Node 23, lack the
built-in SQLite with full-text search that Vault needs.

```sh
npm install
cp .env.example .env     # every setting, with a comment on each
openssl rand -hex 32     # put this after VAULT_KEY= in .env
npm run start:node       # Vault is running at http://127.0.0.1:8788/mcp
```

On first start it creates `vault.db` and its tables. Connect Claude Code with the key:

```sh
claude mcp add --scope user --transport http vault http://127.0.0.1:8788/mcp --header "Authorization: Bearer <your key>"
```

**Docker.** The same program; the database lives in the `/data` volume. Leave `VAULT_DB` and `HOST`
out of the `.env` you pass in (the image sets them):

```sh
docker build -t vault .
```

```sh
docker run -d --name vault -p 8788:8788 -v vault-data:/data --env-file .env vault
```

**Knowledge graph and meaning search (optional).** Name an AI model in `.env`. Free and private
with [Ollama](https://ollama.com) (`ollama pull llama3.1` and `ollama pull bge-m3`):

```sh
AI_BASE_URL=http://localhost:11434/v1   # from Docker: http://host.docker.internal:11434/v1
AI_GRAPH_MODEL=llama3.1
AI_EMBED_MODEL=bge-m3
```

Each part switches on only if its model is named. A hosted service works too (`AI_BASE_URL` plus
`AI_API_KEY`), but it may cost money and sees what you save. Things saved before you set
`AI_EMBED_MODEL` are filled in with `npm run reindex:node` (add `-- --redo` after changing model).

**Sign-in page (for Claude and ChatGPT on the web and phone).** These apps can't send a key; they
need a sign-in page, which needs a public https address.

1. Put Vault behind https (a reverse proxy such as Caddy, or a tunnel), e.g. `https://vault.example.com`.
2. Register an app with Google or any OpenID Connect service, with the return address
   `https://vault.example.com/callback`.
3. Fill in the sign-in block of `.env` (client id and secret, `ALLOWED_EMAIL`,
   `COOKIE_ENCRYPTION_KEY`, `PUBLIC_URL`) and restart. The key can stay on for Claude Code.

**Before opening it to the internet:** put https in front first, and back up `vault.db` like any
important file. `vault.vectors.db` can be rebuilt with the reindex command; deleting
`vault.signin.db` only signs every app out.

## On Cloudflare's free tier

You need a free Cloudflare account and a Google sign-in client (or another OpenID Connect service).

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

Every save updates the graph and meaning index by itself. A catch-up fills gaps in the meaning
index: items saved before you turned it on, or a day the AI service was down. Both commands are safe
to run twice. (Graph links a save missed come back when the item is next updated.)

| Command | Does |
|---|---|
| `npm run reindex:node [-- --redo]` | Node build: fingerprint anything missing (or everything, after a model change) |
| `npx tsx scripts/vector-sync.ts status\|run\|tidy --remote --rest` | Cloudflare: count, fill and tidy the meaning index (`run --redo` re-does everything) |

Without `--remote`, scripts use the local copy of the database (`npm run db:local`). Folders the
scripts export to must be outside the repo.

## When something looks wrong

| You see | Do this |
|---|---|
| A just-saved fact isn't found with different words | With meaning search off (no AI model set), a question must share a word with the fact. On Cloudflare, wait 1–3 minutes: its meaning index files new entries in batches. The same words find it at once. |
| "left out because it was slow or unavailable: meaning search" | Ask again; the rest of the answer was complete. |
| A save has no graph links | The model failed or the free daily allowance ran out. The save is safe; updating the item later re-reads it. |
| An app shows old tools | Disconnect and reconnect Vault in that app. |
| Sign-in loops | Finish the sign-in in the same browser you started it in, with the allowed account. |
| "This app is not allowed to sign in to Vault" | Add the app's return address ([connect apps](connect-apps.md#a-new-app)). |
| You need something you forgot | Ask the app to "show what Vault has about X, including old versions", then save it again. |
| More detail | `npx wrangler tail vault` (Cloudflare) or the server's output (Node); every background step is logged in `graph_log`. |
