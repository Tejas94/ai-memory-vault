// After every save or forget, two background jobs keep Vault's search aids in step with its data:
//   1. the knowledge graph (src/graph): Workers AI reads the item and stores its links
//   2. embeddings (src/vectors): Workers AI turns the item into vectors stored in Vectorize
// Both run after the tool has replied and never make a save fail; failures land in graph_log and a
// catch-up run (scripts/graph-sync.ts, scripts/vector-sync.ts) fills any gap.
import { updateGraph } from "./graph/extract";
import type { Origin } from "./graph/schema";
import type { ToolContext } from "./tools/types";
import { embedItem, type Piece, piecesForText, retireItemVectors } from "./vectors/embed";

type SaveOpts = {
	replaceOrigin?: boolean; // graph: a new version drops links it no longer states
	asOf?: string; // when the information is from
	pieces?: Piece[]; // embeddings: pre-split pieces (chats); otherwise split from `text`
	append?: boolean; // embeddings: new messages added to a saved chat
	replaced?: Origin; // an older item this save replaces (a fact's previous version)
};

/** Call once after an item is saved or updated. */
export function afterSave(env: Env, ctx: ToolContext | undefined, origin: Origin, text: string, opts: SaveOpts = {}) {
	if (!ctx) return Promise.resolve([]); // no background context (plain tool calls in tests): nothing to run
	const [head, ...rest] = text.split("\n");
	const pieces = opts.pieces ?? piecesForText(head, rest.join("\n"));
	const work = [
		updateGraph(env, origin, text, { replaceOrigin: opts.replaceOrigin, asOf: opts.asOf }),
		embedItem(env, origin, pieces, { append: opts.append }),
		...(opts.replaced ? [retireItemVectors(env, opts.replaced)] : []),
	];
	for (const w of work) ctx.background(w);
	return Promise.all(work);
}

/** Call after an item is forgotten: its vectors leave the index (graph links are retired in the same batch as the forget). */
export function afterForget(env: Env, ctx: ToolContext | undefined, origin: Origin) {
	const work = retireItemVectors(env, origin);
	if (ctx) ctx.background(work);
	return work;
}
