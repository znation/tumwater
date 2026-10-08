/** Loop-id arithmetic for parallel work instances (plans/parallel-work-instances.md, part 1/7).
 * A base role may run several loop ids — `feature`, `feature-2`, `bugfix-3`, … — each keying its
 * own persisted state, branch, refs, session and notebook, while every lookup that is ABOUT the
 * role (its catalog charter, model, tier, caps, scheduling class) resolves through the base
 * role. Until instances are configured (part 5/7) every loop id is bare, so `baseRoleOf` is the
 * identity and nothing here changes behavior.
 *
 * Only `feature` and `bugfix` may gain instances; any other id is returned unchanged, including
 * a custom loop whose name merely resembles an instance. */

import type { TumwaterConfig } from "../config/config-schema.js";

/** The base roles that may run more than one instance. */
export const INSTANCE_ROLES: ReadonlySet<string> = new Set(["feature", "bugfix"]);

/** The instance-id shape: a base role, a dash, and an index of 2 or more (`-1` is not an
 * instance — the bare id already means instance 1). */
const INSTANCE_RE = /^(feature|bugfix)-([2-9]|[1-9][0-9]+)$/;

/** The base role a loop id belongs to: `feature-2` → `feature`, `bugfix-10` → `bugfix`; any
 * other id — a bare role, a custom loop, `feature-1` — is returned unchanged. */
export function baseRoleOf(id: string): string {
  const m = INSTANCE_RE.exec(id);
  return m ? (m[1] as string) : id;
}

/** The 1-based instance number of a loop id: 1 for a bare role or any non-instance id, N for
 * `<role>-N`. */
export function instanceIndex(id: string): number {
  const m = INSTANCE_RE.exec(id);
  return m ? Number(m[2]) : 1;
}

/** Is this loop id enabled? True when its base role is enabled in config and the id's instance
 * index is within that role's configured instance count. The count is 1 until part 5/7 adds
 * `roles.<id>.instances`, so an extra instance id is disabled here — a bare role keeps exactly
 * the enabled-or-not verdict it had before. */
export function loopEnabled(config: TumwaterConfig, id: string): boolean {
  return config.roles[baseRoleOf(id)]?.enabled === true && instanceIndex(id) <= 1;
}
