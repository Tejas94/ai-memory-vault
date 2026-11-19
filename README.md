# AI Memory Vault

**One memory for all your AI apps.** Save something in ChatGPT, and Claude knows it seconds later.

Every AI app keeps its own memory, and none of them share it: tell ChatGPT you moved house and
Claude still doesn't know. Vault fixes that. It's a small memory server you host yourself, and
Claude, ChatGPT and Claude Code connect to it as an MCP connector. It keeps your facts, chats,
documents and projects in one place, and gives each app only the few pieces a question needs
instead of your whole history. It runs on Cloudflare's free tier, or on any computer with Node or
Docker. To see the exact Cloudflare setup I run myself, check the
[`cloudflare-reference` branch](../../tree/cloudflare-reference).

https://github.com/user-attachments/assets/641dfcb5-d277-4b66-9fd6-b871a7c2b050

## What it does

- **Save:** "Save to Vault: …", "Update Vault: …", "Forget …". Apps also save lasting things on their own.
- **Recall:** before a personal answer, the app asks Vault and gets a short list of the most relevant facts.
- **Search old chats:** "What did I ask ChatGPT about car hire?" finds it, even in different words.
- **Never loses anything:** an update keeps the old version, and the database refuses deletes.

## How it works

1. A save is written and answered at once ("Saved ✓"). The chat never waits.
2. In the background, an AI model adds the item to a **knowledge graph** (who and what it's about,
   and how they connect) and a **meaning index** (so "car" finds "Fiat Panda").
3. A question runs four searches at once: keywords, meaning, graph and project. The results are
   merged and sent back as a few short lines.

More detail: [how Vault works](docs/how-it-works.md).

## Tested, not guessed

Every change was measured with the same exam: questions whose answers are known facts, scored by
whether those facts come back. My questions are private, but the exam runner is in
[`evals/`](evals/README.md) so you can write your own.

| Step | Answers found | Reply size |
|---|---|---|
| Keyword search only | 65% | ~1,600 tokens |
| + knowledge graph | 55% | ~400 tokens |
| + meaning search | 83% | ~600 tokens |
| + tidier replies and categories | **94%** | ~600 tokens |

There's also a full test suite (`npm test`), and a live check that saves, updates and forgets
made-up items through a real connection (13 / 13 passed).

## Quick start

**Let your AI set it up.** Paste this into Claude Code or Codex:

```text
Set up Vault for me by following https://raw.githubusercontent.com/Tejas94/ai-memory-vault/main/SETUP.md
```

It asks you a few questions, runs the steps, and stops whenever something needs you (a sign-in, a
password). It can also help you bring in your own notes and documents.

**Or do it yourself:**

**On any computer** (Node 22.16 or newer: 22, 24 and 26 are tested). No account needed:

```sh
npm install
cp .env.example .env    # then set VAULT_KEY to a long random secret
npm run start:node      # Vault is at http://localhost:8788/mcp
```

Or with Docker: `docker build -t vault .`, then run it with your `.env`.
Full steps, sign-in and AI models: [setup](docs/setup.md#on-any-computer).

**On Cloudflare's free tier:** put your own database ids in `wrangler.jsonc`, set your secrets
and deploy. See [setup](docs/setup.md#on-cloudflares-free-tier).

Then connect your first app: [connect your apps](docs/connect-apps.md).

## Docs

- [Set up and run](docs/setup.md): install, deploy, catch up, fix problems
- [Connect your apps](docs/connect-apps.md): Claude, ChatGPT, Claude Code, and your first fact
- [How it works](docs/how-it-works.md): saving, searching, the rules, and why it's built this way
- [Tools](docs/tools.md), [settings](docs/config.md) and [limits](docs/limits.md)

## Built with

TypeScript, the official MCP SDK, Cloudflare Workers, D1, Workers AI and Vectorize, or Node with
SQLite files.

## License

[MIT](LICENSE)
