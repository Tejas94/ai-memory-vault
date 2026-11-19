import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Source } from "./auth";
import { explore } from "./tools/explore";
import { forget } from "./tools/forget";
import { getContext } from "./tools/get_context";
import { getConversation } from "./tools/get_conversation";
import { getDocument } from "./tools/get_document";
import { getProject } from "./tools/get_project";
import { listFacts } from "./tools/list_facts";
import { listProjects } from "./tools/list_projects";
import { saveConversation } from "./tools/save_conversation";
import { saveDocument } from "./tools/save_document";
import { saveMemory } from "./tools/save_memory";
import { saveProject } from "./tools/save_project";
import { searchHistory } from "./tools/search_history";
import { type Tool, type ToolContext, ToolError } from "./tools/types";
import { updateProfile } from "./tools/update_profile";

// Spec section 4, in table order
export const TOOLS: Tool<any>[] = [
	getContext,
	saveMemory,
	forget,
	saveConversation,
	saveDocument,
	searchHistory,
	getConversation,
	getDocument,
	listProjects,
	getProject,
	saveProject,
	updateProfile,
	listFacts,
	explore,
];

// Shared rules every AI app reads when it connects. Changing this needs only a deploy:
// apps pick it up on their next new chat.
export const INSTRUCTIONS = `Vault is the user's personal memory, shared across all their AI apps (Claude, ChatGPT and others). Anything saved in one app is available in the others within seconds.

When to check Vault:
- Call get_context before answering anything personal or about their work, plans, projects or past conversations.
- Follow-up questions about a person, place or project ("who is…", "what's linked to…") → explore with the name.
- "What did I ask/say/decide about …" → search_history with distinctive keywords (try synonyms if nothing comes back), then get_conversation or get_document to read a hit in full.

Trigger phrases (the user may say them explicitly; always honour them):
- "Save to Vault: …" → save_memory, one short fact per call.
- "Update Vault: …" → save_memory with \`replaces\` = the old fact's id (from get_context or list_facts).
- "Forget …" → forget with the item's id (facts by default; also documents, projects, conversations).
- "Save this conversation to Vault" → save_conversation with the whole chat, both sides, in order, plus the text of any files shared. If you saved this chat before, pass its conversation_id so only new messages are added.
- "Save this document to Vault" → save_document with the extracted text (scope standalone unless a project or saved chat is named).
- "… under <project>" → pass that project_id (call list_projects if unsure of the id).
- "Show me what Vault has about …" → list_facts with keywords; show the ids so the user can correct them.
- "What projects do I have?" → list_projects. "Brief me on <project>" → get_project.
- "Create/update project …" → save_project. "Update my profile: …" → update_profile.

Do this on your own, without being asked:
- Save lasting new facts the user shares (location, job, decisions, preferences, plans, people). When something changes, use \`replaces\` with the old fact's id instead of adding a contradicting fact.
- Trust the newest fact when facts conflict.

Files and images: never send originals. Save the extracted text; for images, a description plus any visible text. Label with the file name. Shortening long files is fine.

Coding tools (Claude Code, Codex): at session start call get_project for the repo's project. At session end save a short summary and decisions with save_conversation, filed under the project. Save summaries, not code dumps.

Always:
- Say "Vault" (not "memory") so it isn't confused with this app's own built-in memory.
- Never save passwords, card/bank numbers, ID numbers, API keys or other secrets.
- After saving, confirm briefly ("Saved to Vault ✓").`;

export const newServer = () => new McpServer({ name: "Vault", version: "0.1.0" }, { instructions: INSTRUCTIONS });

/** Add every Vault tool to an MCP server. `getSource` returns the signed-in client's source. */
export function registerTools(
	server: McpServer,
	env: Env,
	getSource: () => Source | undefined,
	ctx?: ToolContext,
) {
	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: tool.inputSchema },
			async (input: unknown) => {
				// source comes from the signed-in client (set at OAuth time), never from the AI
				const source = getSource();
				if (!source) throw new Error("Not signed in");
				try {
					const result = await tool.run(env, source, input as never, ctx);
					return { content: [{ type: "text" as const, text: tool.format ? tool.format(result) : JSON.stringify(result) }] };
				} catch (e) {
					if (e instanceof ToolError) {
						return { isError: true, content: [{ type: "text" as const, text: e.message }] };
					}
					// Unexpected failure: full details to the logs, a plain message to the AI
					console.error(`Tool ${tool.name} failed:`, e);
					return {
						isError: true,
						content: [{ type: "text" as const, text: `Vault hit an internal error in ${tool.name}. Please try again.` }],
					};
				}
			},
		);
	}
}
