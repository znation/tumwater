/** How a role's id shows up in words: an instance id as `feature #2`. Pure, no I/O, so core
 * modules and the UI may both import it. */

import { baseRoleOf, instanceIndex } from "./runner-ids.js";

/** The shared display labels that differ from a role's id (the shared table every surface that
 * shows a role label reads through roleLabel, and the dashboard client's hand-kept copy). ci
 * renders as "CI"; every other id — a bare role, a custom role, an instance — renders as its id. */
export const ROLE_LABELS: Readonly<Record<string, string>> = { ci: "CI" };

export function roleLabel(runnerId: string): string {
  const base = baseRoleOf(runnerId);
  const label = Object.prototype.hasOwnProperty.call(ROLE_LABELS, base) ? ROLE_LABELS[base]! : base;
  return base === runnerId ? label : `${label} #${instanceIndex(runnerId)}`;
}
