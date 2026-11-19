# Set up Vault (instructions for an AI coding agent)

You are an AI coding agent, such as Claude Code or Codex. Someone asked you to set up Vault for them:
a memory server that their AI apps (Claude, ChatGPT, Claude Code) share. Follow these steps in order.
The exact commands are in `docs/setup.md` once the code is downloaded; this file says what to do,
what to ask and when to stop.

## Rules for you

- **The person decides.** Ask before every choice below, explain each option in one plain sentence,
  and wait for the answer.
- **Never handle their secrets.** Don't ask them to paste a password, client secret or key into the
  chat. Give them the command and let them type the value themselves. Keys you generate go straight
  into a file; never print them.
- **Ask first** before deploying, before any command that touches a live database, and before
  installing anything on their computer.
- **Don't change Vault's code.** If something fails, say what failed and what you suggest.
- Speak plainly. The person may not be technical.

## 1. Check the computer

Check for `git` and Node 22.16 or newer (`node --version`). Node 22, 24 and 26 are tested; Node 23
won't work. If one is missing or too old, say so, suggest how to install it, and wait.

## 2. Ask three questions

1. **Where should Vault run?**
   - *This computer:* nothing to sign up for. Vault runs while it's started on this computer; after a
     restart it has to be started again (one command, shown at the end).
   - *Docker:* the same, packed in a container that restarts by itself (needs Docker installed).
   - *Cloudflare's free tier:* always on, reachable from anywhere, nothing to keep running. Needs a
     free Cloudflare account and a Google sign-in client.
2. **Which apps will use it?**
   - *Claude Code (or other coding agents) only:* a secret key is enough.
   - *Also Claude or ChatGPT on the web or phone:* those connect through a sign-in page, which needs
     Cloudflare or a public https address for this computer. If they picked "this computer" or
     "Docker", explain this and ask whether to set up the sign-in page now or later.
3. **Turn on smarter search?** (the knowledge graph and search by meaning)
   - *On Cloudflare:* on by default, using Cloudflare's free AI. Nothing to choose.
   - *Otherwise:* none (search by keywords only: a question must share a word with what was saved),
     a free local AI through Ollama (a separate app to install; private; needs a few GB of disk), or a
     hosted AI service (may cost money, and it sees what they save).

## 3. Get the code

Ask which folder to put Vault in (suggest `~/vault`). Then:

```sh
git clone <this repository's address> <folder>
cd <folder>
npm install
```

Now read `docs/setup.md` and `AGENTS.md` in that folder.

## 4a. This computer or Docker

Follow "On any computer" in `docs/setup.md`:

1. Copy `.env.example` to `.env`.
2. Put a new random key after `VAULT_KEY=` without showing it, for example:
   ```sh
   node -e "const f=require('fs'),k=require('crypto').randomBytes(32).toString('hex');f.writeFileSync('.env',f.readFileSync('.env','utf8').replace(/^VAULT_KEY=.*$/m,'VAULT_KEY='+k))"
   ```
3. If they chose Ollama: check it's installed (ask before installing it), pull the two models and
   uncomment the three Ollama lines in `.env`. For a hosted service, ask them to put its key in
   `.env` themselves.
4. Start Vault: `npm run start:node` in the background, or the two Docker commands (Docker restarts
   it by itself). It should print `Vault is running at …/mcp`. The port is `PORT` in `.env` (8788
   unless changed); use it in every address below.
5. Check it answers: a request without the key must get `401`:
   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8788/mcp
   ```
6. Sign-in page (only if they asked for it now): walk them through "Sign-in page" in
   `docs/setup.md`. They register the sign-in client and type the values into `.env` themselves.

## 4b. Cloudflare

Follow "On Cloudflare's free tier" in `docs/setup.md`:

1. `npx wrangler login`. **Stop:** the person clicks "Allow" in their browser.
2. Create the database, the sign-in store and the meaning index, and write the database and
   sign-in store ids into `wrangler.jsonc` (they are zeros until then). Create the tables.
3. **Stop and hand over:** the person creates a Google OAuth client (Google Cloud Console → APIs &
   Services → Credentials → OAuth client ID → Web application) with the return address
   `https://vault.<their workers.dev subdomain>.workers.dev/callback`. Show them that exact address.
4. **Stop and hand over:** the person runs each `npx wrangler secret put …` command from
   `docs/setup.md` and types the value. `COOKIE_ENCRYPTION_KEY` can be any long random string;
   `ALLOWED_EMAIL` is the one Google account allowed in.
5. Run `npm test`, then ask before `npx wrangler deploy`. Note the address it prints.

## 5. Connect apps

- **Claude Code:** add Vault for them, for every project (`--scope user`). With a key, run this from
  the Vault folder so the key is read from `.env` without being printed:
  ```sh
  claude mcp add --scope user --transport http vault http://127.0.0.1:8788/mcp --header "Authorization: Bearer $(grep '^VAULT_KEY=' .env | cut -d= -f2)"
  ```
  The key is then stored in Claude Code's own settings on this computer, which is normal. With the
  sign-in page or Cloudflare, leave out the header and use the public address; Claude Code opens the
  sign-in the first time. The new connection loads in the next Claude Code session.
- **Codex:** add Vault as a streamable HTTP MCP server with the same address and the key as a bearer
  token (see `codex mcp --help`).
- Saves made with the key are labelled `manual`; saves through the sign-in page are labelled with the
  app's name (claude, chatgpt…).
- **Claude and ChatGPT on the web or phone:** show them the steps in `docs/connect-apps.md`. They
  click through these themselves.

## 6. Check it works

Ask the person to open a new chat in a connected app and say:

> Save to Vault: my test fact is that the sky is green.

Then: "What colour is the sky, according to Vault?", then "Forget that." (With keywords only, a
question must share a word with what was saved, as this one shares "sky". Say so.) If any step fails, check
the troubleshooting table at the end of `docs/setup.md`.

## 7. Bring their own data (only if they want to)

Vault starts empty. If they want to fill it with data they already have (notes, documents, exports,
anything):

1. Ask what the data is and where it is.
2. Look at a few files and suggest how to split it, then wait for a yes:
   short lasting facts → `save_memory`; documents and long text → `save_document`;
   conversations → `save_conversation`; groups of related work → `save_project`.
3. Save through Vault's tools, a little at a time, and report progress. Every save builds the
   knowledge graph and meaning index by itself.
4. For a large amount (hundreds of files or more), say roughly how long it will take and that it
   uses tokens, and ask before starting. You may write a small one-off script for their format that
   calls Vault's tools, then run the catch-up from `docs/setup.md`. Don't commit that script or their
   data to the Vault folder.
5. Tell them plainly: you, the agent, read these files, so their content passes through your AI
   provider on the way into Vault.

## 8. Finish

Give them a short summary:

- Vault's address, and which apps are connected.
- Where their data lives (`vault.db` in the Vault folder, or the Docker volume, or Cloudflare D1)
  and that they should back it up.
- How to start it again after a restart (`npm run start:node` in the Vault folder, or
  `docker start vault`) and how to stop it (stop that command, or `docker stop vault`).
- The docs: `docs/connect-apps.md` to add more apps, `docs/setup.md` for everything else.
