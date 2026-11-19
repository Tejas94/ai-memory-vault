// A time budget shared by the searches of one request (get_context, search_history). Every search
// starts at once; whatever has answered when the time is up is used, a slower one is left out and
// named, so the reply never waits on one slow part. A search that fails is left out the same way.

let BUDGET_MS = 1_000;
/** Tests and the eval (which reaches the database over the internet) change this. */
export const setBudget = (ms: number) => (BUDGET_MS = ms);

export function startBudget(tool: string) {
	const skipped: string[] = [];
	const failed: unknown[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<void>((r) => (timer = setTimeout(r, BUDGET_MS)));

	/** `work`, or `fallback` if it fails or is still running when the time is up. */
	function timed<T>(label: string, work: Promise<T>, fallback: T): Promise<T> {
		let settled = false;
		return Promise.race([
			work.then(
				(v) => ((settled = true), v),
				(e) => {
					settled = true;
					console.error(`${tool}: ${label} search failed:`, e instanceof Error ? e.message : String(e));
					skipped.push(label);
					failed.push(e);
					return fallback;
				},
			),
			deadline.then(() => {
				if (!settled) skipped.push(label); // only a search still running when time is up
				return fallback;
			}),
		]);
	}
	const done = () => {
		if (timer !== undefined) clearTimeout(timer);
	};
	return { timed, done, skipped, failed };
}
