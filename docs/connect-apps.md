# Connect your apps

About 10 minutes. At the end, Claude and ChatGPT share one memory: save a fact in one and the other
knows it. You need your Vault address (ending in `/mcp`) and the account allowed to sign in.

## Claude

1. On claude.ai (web or desktop): **Customize → Connectors → Add custom connector**.
2. Name: `Vault`. URL: your Vault address. Click **Connect** and sign in with the allowed account.
   Finish the sign-in in the same browser you started it in.
3. The connector shows 14 tools. It works in the Claude phone app too.

## ChatGPT

1. In ChatGPT on the web: **Settings → Apps / Connectors → Add custom connector** (it may sit under
   Developer mode).
2. URL: the same Vault address. Sign in as above. It then works in the phone app too.

## Claude Code

```sh
claude mcp add --scope user --transport http vault <your Vault address>
```

## Try it

In Claude:

> Save to Vault: my favourite pizza is margherita.

Claude calls `save_memory` and replies "Saved to Vault ✓". A few seconds later, in ChatGPT:

> Ideas for Friday dinner with friends?

ChatGPT calls `get_context`, gets back the margherita fact and suggests a pizza night. A few minutes
later try different words, "What food do I like?": Vault finds it by meaning and through the graph
(margherita → is a → food).

Then:

> Update Vault: my favourite pizza is now quattro formaggi.

The old version is kept as history. "Show me what Vault has about pizza" lists the current fact
with its id, and "Forget that" switches it off. Nothing is deleted.

More things to say: "Save this conversation to Vault", "… under garden-plan" (files it under a
project). Every tool: [tools](tools.md).

## A new app

Any app that supports remote MCP connectors with sign-in can use Vault, with no per-app code
(Gemini's consumer app can't connect to custom servers yet). Vault only finishes a sign-in at
addresses it knows, so a stranger can't register a fake "app" and receive your login. The list is
`ALLOWED_REDIRECTS` in `src/auth.ts`:

| App | Sign-in returns to |
|---|---|
| Claude (web, desktop, phone) | `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` |
| ChatGPT | `https://chatgpt.com/connector/oauth/…` |
| Claude Code and other desktop tools | `localhost` / `127.0.0.1` |

If a new app's sign-in fails with "This app is not allowed to sign in to Vault", add its return
address there (with a test in `test/auth.test.ts`) and deploy. Saves are labelled by app name in
`sourceFromClientName()` in the same file; unknown apps are labelled `manual`.
