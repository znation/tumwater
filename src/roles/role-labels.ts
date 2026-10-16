// vocabulary: plain
/** How a role shows up in words: an instance id as `feature #2`, and a role's title. Pure, no
 * I/O, so core modules and the UI may both import it. */

import { baseRoleOf, instanceIndex } from "./loop-ids.js";
import { ROLES } from "./role-catalog.js";
import { DIRECTOR_ROLE } from "./roles.js";

/** An instance id as `feature #2`; any other id (a bare role, `director`, a custom role,
 * `feature-1`) unchanged. */
export function roleLabel(runnerId: string): string {
  const base = baseRoleOf(runnerId);
  return base === runnerId ? runnerId : `${base} #${instanceIndex(runnerId)}`;
}

/** Each catalog role's id → title, plus the director's. */
export const ROLE_TITLES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(ROLES.map((r) => [r.id, r.title])),
  [DIRECTOR_ROLE]: "runs your messages first",
};

/** The title shown for a role the catalog does not know. */
export const CUSTOM_ROLE_TITLE = "custom role";

/** A role's title; instance ids resolve through their base. `Object.hasOwn` keeps a custom role
 * named `constructor` from reading an inherited property. */
export function roleTitle(id: string): string {
  const base = baseRoleOf(id);
  return Object.hasOwn(ROLE_TITLES, base) ? (ROLE_TITLES[base] as string) : CUSTOM_ROLE_TITLE;
}
