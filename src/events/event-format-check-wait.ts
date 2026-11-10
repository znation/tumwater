import type { HarnessEvent } from "./events.js";
import { eventTypeLabel } from "./event-labels.js";
import { textOr } from "../text/text.js";
import { finiteNumber, stringList } from "../files/json-object.js";
import { elapsed, waitedSpan, outcomeText } from "./event-format-fragments.js";

export function checkWaitEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "build_check":
      // The deterministic check's cost, per run: scope names which gate paid (the pre-merge review
      // gate or the red-main baseline check of main itself; merge and batch were the removed
      // in-lock/batch checks, parts 4l/3 and 4m/3). script carries the npm script name for an npm
      // check but the FULL configured command otherwise (checkScriptName in build/build-check.ts),
      // so no "npm" prefix is asserted here — the bare name reads correctly for both kinds ("npm
      // test" would misrender a cargo or make-based project's check).
      return `check (${textOr(e.scope)}): ${textOr(e.script)} ${eventTypeLabel(outcomeText(e))}${elapsed(e.durationMs)}`;
    case "dep_install": {
      // The root checkout's install catching up with a merged lockfile change — routine on
      // success; a failure also rides its own warning, which says what happens meanwhile.
      const pkgs = stringList(e.packages).join(", ");
      return `root install (${pkgs}) ${eventTypeLabel(outcomeText(e))}${e.error ? ` — ${textOr(e.error)}` : ""}${elapsed(e.durationMs)}`;
    }
    case "slot_wait": {
      // Routine-with-explanation, like rate_limit_hold — no warning prefix: waiting is the pool
      // working as designed. Names the wait, the pool it waited on, and how many slots are
      // pinned, so the operator can raise worktreeSlots with the numbers in hand.
      const purpose = e.purpose === "verify" ? "check" : "run";
      return `${waitedSpan(e.waitedMs)} to start (${textOr(e.role)} ${purpose}; ${textOr(e.slots)} workspaces, ${textOr(e.pinned)} pinned)`;
    }
    case "provider_wait": {
      // Routine-with-explanation, like slot_wait: waiting for the team slot is the cap
      // working as designed, so no warning prefix. Names the wait, so the operator can size
      // maxConcurrent with the number in hand.
      return `${waitedSpan(e.waitedMs)} for a run slot (${textOr(e.role)})`;
    }
    case "check_wait":
      // Routine-with-explanation, like slot_wait: waiting for a check permit is the cap working
      // as designed, so no warning prefix. Newer events also name the holders and the cap at park
      // time; older or malformed ones render the bare line.
      {
        const heldBy = stringList(e.heldBy);
        const limit = finiteNumber(e.limit, null);
        const behind =
          heldBy.length > 0 ? `; held by ${heldBy.join(", ")}${limit === null ? "" : ` of maxConcurrentChecks ${limit}`}` : "";
        return `${waitedSpan(e.waitedMs)} for a check slot (${textOr(e.role)} ${textOr(e.scope)} check${behind})`;
      }
    default: return textOr(e.type);
  }
}
