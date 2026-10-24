/** Work-instance claim states an operator must act on, shared between the doctor's
 * `parallel instances` row and the always-on amber alert (plans/parallel-work-instances.md
 * "Observability", part 6/7): a claim whose key no longer appears in its role's backlog
 * section (its instance is stuck on an entry that moved), and a claim idle longer than
 * `CLAIM_IDLE_MAX_MS` (the scheduler releases these, so seeing one means the reader's view
 * and the scheduler's disagree). Classified once here so the doctor row and the `tumwater
 * status` / dashboard / TUI alert cannot drift on the rule. Pure: reads runner state and the
 * backlog through `loadRunnerState` / `listedKeys`, never mutates. */

import { loadRunnerState } from "../runner/runner-state-load.js";
import { CLAIM_IDLE_MAX_MS, listedKeys } from "./claims.js";

/** A work-instance claim needing the operator's attention, named the way the doctor's
 * `parallel instances` row names it: the instance id, the backlog file its entry lives under,
 * the claimed entry's title, and the state (`gone` — the key left the section but the
 * instance still holds it — or `idle` — the claim has sat past `CLAIM_IDLE_MAX_MS`, with
 * `hours` its whole-hour age). A `gone` claim carries `hours` 0: it wins over idle for the
 * same claim. */
export interface ClaimState {
  id: string;
  file: "PLANS.md" | "BUGS.md";
  title: string;
  kind: "gone" | "idle";
  hours: number;
}

/** The claim states among `ids` that an operator should act on, in the given order: a claim
 * whose key is absent from its role's backlog section is `gone` (0 hours, and gone wins over
 * idle for the same claim); otherwise a claim older than `CLAIM_IDLE_MAX_MS` is `idle` with
 * its whole-hour age; a fresh listed claim (and an id with no claim) is omitted. The reader
 * behind the doctor's `parallel instances` row and the always-on alert, so the two classify
 * through one function. */
export function staleClaimEntries(root: string, ids: readonly string[], now = Date.now()): ClaimState[] {
  const out: ClaimState[] = [];
  for (const id of ids) {
    const claim = loadRunnerState(root, id).claim;
    if (!claim) continue;
    if (!listedKeys(root, id).has(claim.key)) {
      out.push({ id, file: claim.file, title: claim.title, kind: "gone", hours: 0 });
    } else if (now - claim.at > CLAIM_IDLE_MAX_MS) {
      out.push({
        id,
        file: claim.file,
        title: claim.title,
        kind: "idle",
        hours: Math.round((now - claim.at) / 3_600_000),
      });
    }
  }
  return out;
}
