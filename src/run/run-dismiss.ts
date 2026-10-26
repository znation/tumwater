/** The outcome-recording a run writes at its dismissal — the qa-flow ledger entry and the
 * feedback filing — shared by the two dismissal paths so the run that changed the tree
 * (run-stage.ts) and the no-change run (run-verdict.ts) file their flow and filing
 * identically. Before the split each path carried its own copy: the same try/catch, the same
 * `not recorded` warn wording, and the same issue_filed event, so a wording or guard drift
 * in one path could not show up in the other. Each recorder is bookkeeping that never fails
 * the run — a failed write warns and the run's outcome stands — and the caller keeps its own
 * guard (the cut-off runs record nothing, the changed path records even when the merge is
 * queued). The ci-parity recorder is deliberately NOT shared: only the no-change path writes
 * it, because a run that changed the tree has not verified main (run-stage.ts's comment). */

import { logEventBestEffort } from "../events/events.js";
import { errorMessage } from "../text/text.js";
import { recordFiled } from "./feedback-filings.js";
import { recordFlow } from "./qa-coverage.js";

/** The dismissal path as a recorder reads it: the role to attribute the issue_filed event and
 * the warn sink for a failed write. Both run-stage.ts's and run-verdict.ts's contexts
 * satisfy it structurally, so no cross-import of their context types is needed. */
interface RunDismissCtx {
  role: string;
  warn: (message: string) => void;
}

/** Record a dismissed run's qa flow (qa-coverage.ts's recordFlow) — a failed write warns
 * with the same wording on both dismissal paths. `summary` is the run's summary only when
 * the flow result is a bug (the recordFlow shape carries one just for the bug case, as each
 * path's caller spelled the ternary inline); a passed flow records none. */
export function recordDismissedFlow(
  ctx: RunDismissCtx,
  root: string,
  flow: string,
  result: "passed" | "bug",
  summary: string | undefined,
): void {
  try {
    recordFlow(root, flow, result, result === "bug" ? summary : undefined);
  } catch (err) {
    ctx.warn(`qa flow "${flow}" not recorded: ${errorMessage(err)}`);
  }
}

/** Record a dismissed run's feedback filing (feedback-filings.ts's recordFiled) and log the
 * issue_filed event so the filing reaches the operator's activity feed — a failed ledger
 * write warns with the same wording on both dismissal paths. */
export function recordDismissedFiling(
  ctx: RunDismissCtx,
  root: string,
  filed: { issue: number; title: string },
): void {
  logEventBestEffort(root, {
    source: ctx.role,
    type: "issue_filed",
    issue: filed.issue,
    title: filed.title,
  });
  try {
    recordFiled(root, filed.issue, filed.title);
  } catch (err) {
    ctx.warn(`feedback filing #${filed.issue} not recorded: ${errorMessage(err)}`);
  }
}
