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

Check for `git` and Node 22 or newer (`node --version`); Cloudflare's tool needs it. If one is missing or too old, say so, suggest how to install it, and wait.

## 2. Before you start

This version of Vault runs on Cloudflare's free tier: always on, reachable from anywhere, nothing to
keep running. Tell the person what they need and ask whether to go ahead:

- a free Cloudflare account;
- a Google account, to create a sign-in client (a few clicks, guided below). Only that one Google
  account will be able to sign in to Vault.

The knowledge graph and search by meaning use Cloudflare's free AI and are on from the start.

## 3. Get the code

Ask which folder to put Vault in (suggest `~/vault`). Then:

```sh
git clone <this repository's address> <folder>
cd <folder>
npm install
```

Now read `docs/setup.md` and `AGENTS.md` in that folder.

## 4. Set it up on Cloudflare

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

- **Claude Code:** add Vault for them with its address:
  ```sh
  claude mcp add --scope user --transport http vault https://vault.<their subdomain>.workers.dev/mcp
  ```
  Claude Code opens the sign-in the first time. The new connection loads in the next session.
- **Codex:** add Vault as a streamable HTTP MCP server with the same address (see `codex mcp --help`).
- **Claude and ChatGPT on the web or phone:** show them the steps in `docs/connect-apps.md`. They
  click through these themselves.

## 6. Check it works

Ask the person to open a new chat in a connected app and say:

> Save to Vault: my test fact is that the sky is green.

Then: "What colour is the sky, according to Vault?", then "Forget that." If any step fails, check
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
- Where their data lives (their Cloudflare D1 database) and how to roll back a bad deploy.
- The docs: `docs/connect-apps.md` to add more apps, `docs/setup.md` for everything else.
