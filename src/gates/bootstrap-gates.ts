/** New-project bootstrap (plans/work-ratio.md, "New-project bootstrap"; part 2/2): a fresh
 * project seeds `bootstrap.untilPlansDone` in tumwater.json (part 1/2), and this gate holds
 * every maintenance loop until that many plans have moved to PLANS.md's `## Done`. Only plan,
 * feature and director tick — plus bugfix while BUGS.md `## Open` is non-empty, since its
 * latent-bug search is maintenance. The hold gives a young project a steady stream of plans and
 * code before hygiene roles start churning.
 *
 * Bootstrap is active while `config.bootstrap.untilPlansDone` is set and no latch file is
 * present. Reaching the count writes `.tumwater/bootstrap-complete.json` (src/paths.ts) and
 * logs one `bootstrap_complete`; the latch makes the end permanent, so a later steward
 * compression of `## Done` cannot re-enter bootstrap. In a writable repo the completion is
 * announced once; that one-shot is what the latch's presence gives, and an unwritable latch
 * may let a later poll retry. Removing `bootstrap` from config (live
 * reload) also ends it, without a latch. Both the latch write and the completion event are
 * best-effort, like every sibling gate: the poll runs inside the orchestrator's catch-less
 * loop, so an unwritable repo must degrade (the hold still lifts) rather than end the fleet.
 *
 * Shape, like every gate in the family (src/gates/gate-polls.ts): the read-only verdict (and
 * the pure hold predicate) is separated from the edge-triggered bookkeeping so both the
 * scheduler and the status readers share one definition, and this module owns the only writes.
 * The stat-cached `donePlans` reader (src/backlog/backlog.ts) means an unchanged PLANS.md costs
 * one syscall per poll, not a re-parse. */

import fs from "node:fs";
import type { TumwaterConfig } from "../config/config-schema.js";
import { donePlans, openBugs } from "../backlog/backlog.js";
import { bootstrapLatchPath } from "../paths.js";
import { writeJsonAtomic } from "../files/json-files.js";
import { logEventBestEffort } from "../events/events.js";
import { errorMessage } from "../text/text.js";
import { BUGFIX_ROLE, DIRECTOR_ROLE } from "../roles/roles.js";
import { baseRoleOf } from "../roles/loop-ids.js";

/** The bootstrap verdict as the gate and the status readers compute it: whether the hold is
 * active, and its progress against the target. Null when no bootstrap is configured (or its
 * value is not a positive integer, which config validation already rejects at load). */
interface BootstrapStatus {
  active: boolean;
  plansDone: number;
  untilPlansDone: number;
}

/** The read-only bootstrap verdict: active while a positive `untilPlansDone` is configured and
 * the latch file is absent and fewer than that many plans are Done. No writes — the status
 * surfaces (src/status/status-data.ts) call this directly to show the same figure the
 * scheduler enforces. */
export function bootstrapStatus(root: string, config: TumwaterConfig): BootstrapStatus | null {
  const until = config.bootstrap?.untilPlansDone;
  if (until === undefined || !Number.isInteger(until) || until <= 0) return null;
  const plansDone = donePlans(root).length;
  const active = !fs.existsSync(bootstrapLatchPath(root)) && plansDone < until;
  return { active, plansDone, untilPlansDone: until };
}

/** Does bootstrap hold this role? plan, feature and director are never held; bugfix is held
 * only while BUGS.md `## Open` is empty (with bugs to fix it has real work); every other role
 * is maintenance and held. Matches on the base role, so a `feature-2` instance follows feature. */
export function bootstrapHoldsRole(role: string, openBugsNow: boolean): boolean {
  const base = baseRoleOf(role);
  if (base === "plan" || base === "feature" || base === DIRECTOR_ROLE) return false;
  if (base === BUGFIX_ROLE) return !openBugsNow;
  return true;
}

/** The gate's cross-poll memory: whether bootstrap was active at the previous poll. In memory
 * only, like every gate state. */
export interface BootstrapGateState {
  active: boolean;
}

/** A fresh gate state: nothing seen yet. */
export function newBootstrapGateState(): BootstrapGateState {
  return { active: false };
}

/** Step the gate by one orchestrator poll. Returns the loop ids held by bootstrap as of THIS
 * poll, for the scheduler's `bootstrapHeld` view. When the target has been reached, writes the
 * latch and logs `bootstrap_complete` once (the now-present latch suppresses later logs, and
 * survives an orchestrator restart that resets `state`). An unwritable repo does not abort the
 * poll: the latch write and the event are best-effort, reporting on stderr instead. If the
 * latch cannot be persisted, a later poll retries and may announce again. */
export function pollBootstrapGate(
  root: string,
  state: BootstrapGateState,
  runners: readonly { role: string }[],
  config: TumwaterConfig,
  now: number,
): ReadonlySet<string> {
  const status = bootstrapStatus(root, config);
  if (status === null || !status.active) {
    if (status !== null && !fs.existsSync(bootstrapLatchPath(root))) {
      // The target was reached: latch it (so a later compression of `## Done` cannot re-enter
      // bootstrap) and announce the completion once. Both steps are best-effort: an unwritable
      // latch or events feed must not abort the orchestrator's catch-less poll loop. If the
      // latch cannot be written, a later poll may retry and announce again — the completion
      // itself (the hold lifting) still happens on this poll.
      try {
        writeJsonAtomic(bootstrapLatchPath(root), { plansDone: status.plansDone, ts: now });
      } catch (err) {
        process.stderr.write(
          `tumwater: harness: could not write bootstrap latch: ${errorMessage(err)}\n`,
        );
      }
      logEventBestEffort(root, {
        loop: "harness",
        type: "bootstrap_complete",
        plansDone: status.plansDone,
        untilPlansDone: status.untilPlansDone,
      });
    }
    state.active = false;
    return EMPTY_HELD;
  }
  state.active = true;
  const openBugsNow = openBugs(root).length > 0;
  const held = new Set<string>();
  for (const r of runners) {
    if (bootstrapHoldsRole(r.role, openBugsNow)) held.add(r.role);
  }
  return held;
}

/** The shared empty verdict (an immutable empty set; callers never mutate it). */
const EMPTY_HELD: ReadonlySet<string> = new Set();
