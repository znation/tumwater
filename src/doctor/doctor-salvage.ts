import { collectSalvagePatches } from "../status/status-salvage.js";
import { formatAge } from "../text/datetime.js";
import { plural } from "../text/phrases.js";
import { okOutcome, warnOutcome, type CheckOutcome } from "./doctor-outcome.js";

/** How many kept patches the `salvage patches` row names before appending "and N more", the
 * cap the other multi-file observer rows (e.g. workspaces) use so a long tail does not drown
 * the report. */
const SALVAGE_NAMED_CAP = 3;

/** The `salvage patches` check: whether any operator-kept workspace patch sits under
 * `.tumwater/salvage/` waiting for session retention to prune it. Only patches a no role will
 * restore — settled runs' discarded edits, a verification's scratch output — are kept there for
 * the operator (src/git/slot-salvage.ts); each is read-only against .tumwater/, never written.
 * The kept-patch walk is shared with the status snapshot's collectSalvagePatches
 * (src/status/status-salvage.ts), so the row and the status alert cannot disagree about which
 * patches are kept. Never throws: a missing or unreadable salvage dir reads as no patches. */
export function checkSalvagePatches(root: string, now: number = Date.now()): CheckOutcome {
  const patches = collectSalvagePatches(root);
  if (patches.length === 0) {
    return okOutcome("no salvaged workspace patches are kept for you");
  }
  const oldest = patches[0]!;
  const named = patches
    .slice(0, SALVAGE_NAMED_CAP)
    .map((p) => p.file)
    .join(", ");
  const more =
    patches.length > SALVAGE_NAMED_CAP
      ? ` and ${patches.length - SALVAGE_NAMED_CAP} more`
      : "";
  return warnOutcome(
    `${plural(patches.length, "salvaged workspace patch", "salvaged workspace patches")} kept for you (oldest ${formatAge(now - oldest.savedAt)}, ${oldest.file}): ${named}${more} — apply or delete them under .tumwater/salvage/ before session retention prunes them`,
  );
}
