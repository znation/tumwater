/** How a role's id shows up in words: an instance id as `feature #2`. Pure, no I/O, so core
 * modules and the UI may both import it. */

import { baseRoleOf, instanceIndex } from "./runner-ids.js";

/** An instance id as `feature #2`; any other id (a bare role, `director`, a custom role,
 * `feature-1`) unchanged. */
export function roleLabel(runnerId: string): string {
  const base = baseRoleOf(runnerId);
  return base === runnerId ? runnerId : `${base} #${instanceIndex(runnerId)}`;
}
