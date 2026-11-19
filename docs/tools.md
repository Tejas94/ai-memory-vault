# Tools

Every tool an AI app can call, with its inputs, taken from the tool definitions in `src/tools/`.
Apps read the descriptions below (and the shared instructions in `src/mcp.ts`), so they are written
for an AI reader. The code holds the exact wording.

All tools are served over MCP at `/mcp`. ChatGPT connects to `/mcp` like the others.

| Tool | Writes? | One line |
|---|---|---|
| `get_context` | no | The most relevant facts, connections and projects for a topic |
| `save_memory` | yes | Save, or replace, one short fact |
| `forget` | yes | Switch off a fact, document, project or chat |
| `save_conversation` | yes | Save a whole chat (or add new messages to one) |
| `save_document` | yes | Save, or replace, a document's text |
| `search_history` | no | Search chats, documents and facts by words and meaning |
| `get_conversation` | no | Read one chat in full, 40 messages a page |
| `get_document` | no | Read one document in full |
| `list_projects` | no | All projects |
| `get_project` | no | Full briefing on one project |
| `save_project` | yes | Create or update a project |
| `update_profile` | yes | Rewrite one profile section |
| `list_facts` | no | Review facts with their ids (and old versions) |
| `explore` | no | Follow knowledge-graph links from a name |

Every write replies at once ("Saved ✓"); the graph and meaning-index updates run afterwards in the
background ([how it works](how-it-works.md#a-save)). Who saved it (`source`) is
taken from the signed-in app, never from what the AI says.


## `get_context`

Who the user is and what matters now: their profile, the most relevant current facts (with ids), connections from Vault's knowledge graph, and their active projects. Call this before answering anything personal or about their work, plans, projects or past conversations. Pass a `topic` of a few descriptive words, as specific as the conversation allows (e.g. 'my car plans and budget', not just 'car'), and/or a `project_id`; without either you get the newest facts.

| Input | Type | Notes |
|---|---|---|
| `topic` (optional) | string | A few words on what the conversation is about, e.g. 'renting a car in Italy' or 'my sister's wedding'. |
| `project_id` (optional) | string | Project slug to focus on. |
| `max_tokens` (optional) | integer | Size budget for facts + connections. Default 600. |

**Reply:** Markdown key-value lines: `## Profile`, `## Facts` (`- id: · date: · fact:`), `## Connections`, `## Projects`, a note if a search was left out, and a reminder to save new things. Up to 15 facts and 8 connections, within `max_tokens`.


## `save_memory`

Save one short fact about the user to Vault (use when they say "Save to Vault", or share something lasting and new: location, job, decisions, preferences, plans). To change an existing fact, pass its id from get_context as `replaces` ("Update Vault: …"); the old version is kept as history. One fact per call, max 300 characters. Never save passwords, card/bank numbers, ID numbers or other secrets.

| Input | Type | Notes |
|---|---|---|
| `fact` | string | The fact, one short sentence, e.g. 'Prefers window seats on long journeys'. |
| `category` | identity / work / goals / plans / preferences / people / projects / skills / other |  |
| `kind` (optional) | lasting / temporary | temporary = only true for a while (set `expires`). Default lasting. |
| `replaces` (optional) | integer | Fact id this new version replaces. |
| `project_id` (optional) | string | Project slug, if the fact belongs to a project. |
| `expires` (optional) | string | ISO date when a temporary fact stops being true. |

## `forget`

Hide something from Vault when the user says "Forget …". Nothing is deleted: the item is set inactive and can be restored later. Use the id shown by the other tools: a fact id (number) from get_context/list_facts, a document_id, a project_id or a conversation_id. Forgetting a conversation also hides its messages from search.

| Input | Type | Notes |
|---|---|---|
| `id` | integer / string | Fact id, document_id, project_id or conversation_id. |
| `table` (optional) | facts / documents / projects / conversations | Default facts. |

## `save_conversation`

Save a whole chat to Vault ("Save this conversation to Vault"), both sides, in order. Include the text of any files shared in the chat as `documents` (extracted text only, never originals). To add newer messages to a chat saved earlier, pass the conversation_id it returned; messages already saved are skipped. File it under a project with project_id when the owner says "…under <project>".

| Input | Type | Notes |
|---|---|---|
| `title` | string | Short title for the chat. |
| `messages` | array |  |
| `documents` (optional) | array | Text of files shared in the chat. |
| `project_id` (optional) | string |  |
| `conversation_id` (optional) | string | Existing saved chat to append to. |

`messages`: `[{role: you / user / ai / assistant, text, time?}]`. `documents`: `[{name, content, file_type?}]`. Messages over 50,000 characters are trimmed with a note.


## `save_document`

Save a document's text to Vault ("Save this document to Vault"). Never send the original file: send its extracted text; for images, a description plus any visible text. Long files may be shortened (max ~200,000 characters). scope: project (belongs to a project), conversation (attached to a saved chat) or standalone. To update an existing document, pass its document_id; the old version is kept as history.

| Input | Type | Notes |
|---|---|---|
| `name` | string | File name, e.g. 'lease-agreement.pdf'. |
| `content` | string | The document's text. |
| `file_type` (optional) | string | e.g. pdf, docx, png. Guessed from the name if missing. |
| `scope` | project / conversation / standalone |  |
| `project_id` (optional) | string | Required when scope is project. |
| `conversation_id` (optional) | string | Required when scope is conversation. |
| `document_id` (optional) | string | Existing document to replace with this new version. |

## `search_history`

Search the user's saved conversations (from every AI app, including imported ChatGPT/Claude/Gemini history), documents and facts. Use it for questions like 'what did I ask ChatGPT about X?'. Finds matching words and also chats/documents close in meaning (marked found_by: meaning), so a short description works too. Each message hit includes the 2 messages before and after it.

| Input | Type | Notes |
|---|---|---|
| `query` | string | Keywords to search for. |
| `source` (optional) | chatgpt / claude / gemini / claude_code / codex / grok / perplexity / muse / manual / import_chatgpt / import_claude / import_gemini / import_claude_code | Only this app, e.g. 'chatgpt' (includes imported ChatGPT history). |
| `project_id` (optional) | string | Only this project. |
| `from` (optional) | string | ISO date, earliest. |
| `to` (optional) | string | ISO date, latest (inclusive). |
| `limit` (optional) | integer | Max results per kind. Default 5. |

**Reply:** `matched` (all words / any word, + meaning), `messages` (each with ±2 neighbouring messages and `found_by: words / meaning`), `documents`, `facts`, and `left_out` if a search was too slow.


## `get_conversation`

Read one saved chat in full, 40 messages per page, plus the list of documents attached to it. Use the conversation_id from search_history or get_project. Ask for the next page if `total_pages` is larger.

| Input | Type | Notes |
|---|---|---|
| `conversation_id` | string |  |
| `page` (optional) | integer | Page number, from 1. Default 1. |

## `get_document`

Read one document in full. Use the document_id from search_history, get_project or get_conversation.

| Input | Type | Notes |
|---|---|---|
| `document_id` | string |  |

## `list_projects`

List the user's projects (id, name, status, last updated, which app updated it). Filter by status.

| Input | Type | Notes |
|---|---|---|
| `status` (optional) | active / paused / done |  |

## `get_project`

Full briefing on one project: description, instructions, project documents (previews; full text via get_document), project facts, notes and the last 10 conversations (titles + ids). Coding tools: call this at the start of a session.

| Input | Type | Notes |
|---|---|---|
| `project_id` | string |  |

## `save_project`

Create a project, or update one by passing its project_id. Fields you leave out keep their current value; the old version is kept as history. status: active / paused / done.

| Input | Type | Notes |
|---|---|---|
| `project_id` (optional) | string | Existing project to update. Leave out to create a new one. |
| `name` | string |  |
| `description` (optional) | string |  |
| `instructions` (optional) | string | How AIs should work on this project. |
| `status` (optional) | active / paused / done |  |

## `update_profile`

Rewrite one section of the user's profile (about / work / preferences / current_focus) with the full new text. The old version is kept as history. Use for broad summaries; single facts go to save_memory.

| Input | Type | Notes |
|---|---|---|
| `section` | about / work / preferences / current_focus |  |
| `content` | string | The complete new text for this section. |

## `list_facts`

Show what Vault knows so the user can review or correct it ("Show me what Vault has about …"). Always show them the ids, so they can say "Update Vault: …" or "Forget …". Filter by keywords, category or project. include_inactive also shows old and forgotten versions (with the replaces_id chain).

| Input | Type | Notes |
|---|---|---|
| `query` (optional) | string | Keywords to filter facts, e.g. 'garden'. |
| `category` (optional) | identity / work / goals / plans / preferences / people / projects / skills / other |  |
| `project_id` (optional) | string |  |
| `include_inactive` (optional) | boolean |  |
| `limit` (optional) | integer | Default 50. |
| `offset` (optional) | integer |  |

## `explore`

Follow Vault's knowledge graph from a person, place, project or thing: who and what it is linked to, in short lines like 'Priya → lives_in → Manchester [fact 42]'. Use after get_context for follow-up connections. depth 2 also follows the linked items' own links. Read-only.

| Input | Type | Notes |
|---|---|---|
| `name` | string | A name or alias, e.g. 'Priya', 'my sister', 'Lumen Pad'. |
| `depth` (optional) | integer | 1 (default) or 2. |
| `max_lines` (optional) | integer | Default 30. |
