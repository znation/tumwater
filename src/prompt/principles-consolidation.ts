import path from "node:path";
import { readRegularTextOrNull } from "../files/files.js";
import { PRINCIPLES_MAX_CHARS, principlesBlockOverCap } from "./principles.js";
import { queuedPrompts } from "../inbox/inbox.js";
import { submitPrompt } from "../inbox/inbox-submit.js";
import { hasUnmergedPin } from "../runner/runner-leftover.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";

/** The first line of every automatic consolidation prompt the orchestrator queues the
 * director (principlesConsolidationPrompt's leading line). `requestPrinciplesConsolidation`
 * matches a queued prompt against this prefix to keep an over-cap episode to one assignment
 * at a time, so a test can seed a queued consolidation by this marker alone. */
export const PRINCIPLES_CONSOLIDATION_LEAD =
  "[automatic] PRINCIPLES.md is over its prompt cap and needs consolidation:";

/** The consolidation prompt the orchestrator hands the director when PRINCIPLES.md runs over
 * its prompt cap: `chars` is the file's current trimmed character count, over the cap that
 * `principlesBlockOverCap` (and the doctor `principles` row) warn on. The director is the
 * role allowed to edit PRINCIPLES.md, so it is the one asked to bring the file back under the
 * cap; the standing amber `principles-truncated` alert no longer has a job while this is
 * queued. The text names the measured state (the count and the cap), tells the director to
 * read the file whole rather than trust its own truncated <principles> block, and fixes the
 * consolidation's rules (merge, drop, keep, re-measure, stay under the target, touch only
 * this file, file no backlog entry, summarize the change). */
export function principlesConsolidationPrompt(chars: number): string {
  return (
    `${PRINCIPLES_CONSOLIDATION_LEAD}\n` +
    `\n` +
    `PRINCIPLES.md is currently ${chars} characters trimmed, over the ${PRINCIPLES_MAX_CHARS}-character ` +
    `prompt cap (PRINCIPLES_MAX_CHARS). Every run's <principles> block carries only its head, so the file's ` +
    `tail is silently dropped.\n` +
    `\n` +
    `Read PRINCIPLES.md whole — not the truncated <principles> block in your own prompt, which holds only the ` +
    `head. Then:\n` +
    `- Merge overlapping rules into one, and delete wording the current code and Budgets have superseded.\n` +
    `- Keep every still-active rule, each in its positive voice (say what to do, not only what not to do).\n` +
    `- Leave the measured Budgets figures and the "_Last measured …" line true — re-measure them rather than ` +
    `leaving stale numbers.\n` +
    `- Target at most 3500 characters so an ordinary edit does not immediately re-trigger the cap.\n` +
    `\n` +
    `Edit only PRINCIPLES.md. Add no PLANS.md or BUGS.md entry for this work. In your summary, say what you ` +
    `merged or dropped.`
  );
}

/** The injectable seams, so a test pins each refusal without a real pin or a broken inbox.
 * The over-cap verdict itself is the production `principlesBlockOverCap` (its stat cache keeps
 * the common under-cap case one cheap read per poll). */
interface RequestPrinciplesConsolidationOptions {
  /** Whether a director run is in flight right now; the orchestrator passes its
   * `directorInFlight` set's `size > 0`. */
  directorBusy?: boolean;
  /** The held-pin probe (default `hasUnmergedPin`). */
  hasPin?: (root: string, role: string) => Promise<boolean>;
  /** The enqueue (default `submitPrompt`). */
  submit?: (root: string, text: string) => string;
}

/** The one verdict the orchestrator's poll turns into a request: the consolidation was
 * enqueued (`requested`), or the reason it was not. A thrown enqueue is caught into `error`
 * rather than propagated, so a broken inbox can never end the poll loop. */
interface ConsolidationRequestResult {
  requested: boolean;
  error?: string;
}

/** Queue the director a consolidation prompt when PRINCIPLES.md is over its prompt cap, at
 * most one at a time: `false` when the file is under the cap or unreadable (the file must
 * exist and be over the cap for anything to happen), when a prompt this builder writes is
 * already queued, when `opts.directorBusy` is true (a consolidation is running), or when the
 * director already holds an unmerged pin (its consolidation is written but not yet merged).
 * Otherwise it enqueues through the production `submitPrompt` and returns `{ requested: true }`;
 * an enqueue that throws returns `{ requested: false, error }`. */
export async function requestPrinciplesConsolidation(
  root: string,
  opts: RequestPrinciplesConsolidationOptions = {},
): Promise<ConsolidationRequestResult> {
  if (!principlesBlockOverCap(root)) return { requested: false };
  // One assignment per over-cap episode, not one per poll: a consolidation already in the
  // queue means the next over-cap poll is a no-op until it runs and the file comes back under.
  if (queuedPrompts(root).some((p) => p.startsWith(PRINCIPLES_CONSOLIDATION_LEAD))) {
    return { requested: false };
  }
  if (opts.directorBusy) return { requested: false };
  const hasPin = opts.hasPin ?? hasUnmergedPin;
  if (await hasPin(root, DIRECTOR_ROLE)) return { requested: false };
  const raw = readRegularTextOrNull(path.join(root, "PRINCIPLES.md"));
  const submit = opts.submit ?? submitPrompt;
  try {
    submit(root, principlesConsolidationPrompt(raw ? raw.trim().length : 0));
  } catch (err) {
    return { requested: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { requested: true };
}
