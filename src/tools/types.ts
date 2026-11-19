import type { z } from "zod";
import type { Source } from "../auth";

/** One Vault tool. Shared by MCP (/mcp) and, later, the REST mirror (/api/<name>). */
export type Tool<S extends z.ZodRawShape = z.ZodRawShape> = {
	name: string;
	description: string;
	inputSchema: S;
	run: (env: Env, source: Source, input: z.infer<z.ZodObject<S>>, ctx?: ToolContext) => Promise<unknown>;
	/** How the result is written for the AI. Default: JSON. */
	format?: (result: any) => string;
};

/** What a tool may do after replying. `background` keeps work running once the reply has gone. */
export type ToolContext = { background: (work: Promise<unknown>) => void };

/** A mistake the AI can fix (bad input, unknown id). Shown to it as a normal error message. */
export class ToolError extends Error {}

export const defineTool = <S extends z.ZodRawShape>(tool: Tool<S>) => tool;
