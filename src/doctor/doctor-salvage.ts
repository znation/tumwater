import { collectSalvagePatches } from "../status/status-salvage.js";
import { DAY_MS, formatAge, humanUntil } from "../text/datetime.js";
import { plural } from "../text/phrases.js";
import { okOutcome, warnOutcome, type CheckOutcome } from "./doctor-outcome.js";

/** How many kept patches the `salvage patches` row names before appending "and N more", the
 * cap the other multi-file observer rows (e.g. workspaces) use so a long tail does not drown
 * the report. */
const SALVAGE_NAMED_CAP = 3;

/** When the session-retention pass would take the oldest kept patch: its save time (the file's
 * mtime — the very field `pruneOldFiles` compares, src/files/files.ts) plus the configured
 * window in days. A patch is pruned once its mtime falls before `now - retentionDays * DAY_MS`, so
 * this instant is exactly the pass's reach for that patch. */
function retentionDeadline(oldestSavedAt: number, retentionDays: number): number {
  return oldestSavedAt + retentionDays * DAY_MS;
}

/** The clause naming how long the oldest kept patch has left before session retention prunes it,
 * inserted between the named-patch list and the `tumwater salvage` remedy. It states the window
 * the team actually runs rather than only that a deadline exists:
 * - a live window with the deadline ahead: the window in days plus a countdown for the oldest;
 * - a live window whose deadline has already passed (a stopped team, a failed pass): the same
 *   window and "at the next prune pass", never a `0s` countdown — `humanUntil` clamps at zero,
 *   which would read as if the pass were due this second;
 * - a disabled window (`sessionRetentionDays: 0`, or any non-positive value, which
 *   `dueForPrune` treats the same way): outright that these patches are never pruned.
 * The clause adds no warning of its own — a disabled window is information, not a new warning. */
function retentionClause(oldestSavedAt: number, retentionDays: number, now: number): string {
  if (retentionDays <= 0) return "; session retention is off, so these patches are never pruned";
  const window = `; session retention prunes a patch older than ${retentionDays}d, so the oldest`;
  const deadline = retentionDeadline(oldestSavedAt, retentionDays);
  if (deadline <= now) return `${window} goes at the next prune pass`;
  return `${window} goes in ${humanUntil(deadline, now)}`;
}

/** The `salvage patches` check: whether any operator-kept workspace patch sits under
 * `.tumwater/salvage/` waiting for session retention to prune it. Only patches no role will
 * restore — settled runs' discarded edits, a verification's scratch output — are kept there for
 * the operator (src/git/slot-salvage.ts); each is read-only against .tumwater/, never written.
 * The kept-patch walk is shared with the status snapshot's collectSalvagePatches
 * (src/status/status-salvage.ts), so the row and the status alert cannot disagree about which
 * patches are kept. `retentionDays` is required, not defaulted: the warn sentence names the
 * window it prunes on, so a surface must pass the one the team actually runs
 * (`sessionRetentionDays`) rather than guess one. Never throws: a missing or unreadable salvage
 * dir reads as no patches. */
export function checkSalvagePatches(
  root: string,
  retentionDays: number,
  now: number = Date.now(),
): CheckOutcome {
  const patches = collectSalvagePatches(root);
  if (patches.length === 0) {
    return okOutcome("no salvaged workspace patches are kept for you");
  }
  const oldest = patches[0]!;
  // Number each named file with its 1-based position in the whole oldest-first list, exactly
  // the position the `tumwater salvage` list prints, so the row's names are directly addressable
  // by the `--show <n>` / `--drop <n>` the remedy names.
  const named = patches
    .slice(0, SALVAGE_NAMED_CAP)
    .map((p, i) => `${i + 1}. ${p.file}`)
    .join(", ");
  const more =
    patches.length > SALVAGE_NAMED_CAP
      ? ` and ${patches.length - SALVAGE_NAMED_CAP} more`
      : "";
  const clause = retentionClause(oldest.savedAt, retentionDays, now);
  return warnOutcome(
    `${plural(patches.length, "salvaged workspace patch", "salvaged workspace patches")} kept for you (oldest ${formatAge(now - oldest.savedAt)}, ${oldest.file}): ${named}${more}${clause} — apply one with \`tumwater salvage --apply <n>\`, or read one with \`tumwater salvage --show <n>\` or delete one with \`tumwater salvage --drop <n>\``,
  );
}
