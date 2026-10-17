/** Loop-id arithmetic for parallel work instances (plans/parallel-work-instances.md, part 1/7). A
 * base role may run several loop ids — `feature`, `feature-2`, `bugfix-3`, … — each keying
 * its own persisted state, branch, refs, session and notebook, while every lookup that is ABOUT the
 * role (its catalog charter, model, tier, caps, scheduling class) resolves through the base role.
 * With no instances configured, every loop id is bare, so `baseRoleOf` is the identity.
 *
 * Only `feature` and `bugfix` may gain instances; any other id is returned unchanged, including a
 * custom loop whose name merely resembles an instance. */

import type { TumwaterConfig } from "../config/config-schema.js";

/** The base roles that may run more than one instance. */
export const INSTANCE_ROLES: ReadonlySet<string> = new Set(["feature", "bugfix"]);

/** The instance-id shape: a base role, a dash, and an index of 2 or more (`-1` is not an
 * instance — the bare id already means instance 1). The source string is also interpolated into
 * the dashboard script (gui-client-labels.ts). */
export const INSTANCE_ID_SOURCE = "^(feature|bugfix)-([2-9]|[1-9][0-9]+)$";
const INSTANCE_RE = new RegExp(INSTANCE_ID_SOURCE);

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

/** The instance count configured for a loop id's base role (`roles.<base>.instances`, default
 * 1). A caller tells a multi-instance base (whose unassigned ticks stage claims for their
 * siblings) from a single-runner one by this. */
export function configuredInstances(config: TumwaterConfig, id: string): number {
  const role = config.roles[baseRoleOf(id)];
  return role?.instances ?? 1;
}

/** Is this loop id enabled? True when its base role is enabled in config and the id's instance
 * index is within that role's configured instance count (`roles.<id>.instances`, default 1). */
export function loopEnabled(config: TumwaterConfig, id: string): boolean {
  const role = config.roles[baseRoleOf(id)];
  if (role?.enabled !== true) return false;
  return instanceIndex(id) <= configuredInstances(config, id);
}

/** Every loop id the config says should exist, in `config.roles` order: each enabled role's
 * bare id, then `<id>-2`…`<id>-N` for the `INSTANCE_ROLES` at their configured instance
 * count. Other roles and custom loops stay bare — only feature and bugfix may split. The one
 * answer to "which runners should exist", so the orchestrator (part 5b/7) and live reload
 * enumerate the same set. At the default instance count this returns exactly the bare ids
 * `enabledRoleIds` returns. */
export function loopIds(config: TumwaterConfig): string[] {
  const ids: string[] = [];
  for (const [id, role] of Object.entries(config.roles)) {
    if (!role.enabled) continue;
    ids.push(id);
    if (!INSTANCE_ROLES.has(id)) continue;
    const count = role.instances ?? 1;
    for (let i = 2; i <= count; i++) ids.push(`${id}-${i}`);
  }
  return ids;
}

/** The pause-marker key for a loop id. Instance 1's loop id is the bare role id, which as a pause
 * key would mean the whole role, so while the role runs several instances instance 1 pauses under
 * `<role>-1`. `-1` is a pause key only, never a loop id. Every other id is its own key. */
export function instancePauseKey(config: TumwaterConfig, loopId: string): string {
  return INSTANCE_ROLES.has(loopId) && configuredInstances(config, loopId) > 1
    ? `${loopId}-1`
    : loopId;
}

/** Does the per-role pause marker stop this loop id? True for its own id, its base role's id (a
 * whole-role pause), or — for the bare id of an instance role — the `<role>-1` pause key. */
export function loopPaused(paused: ReadonlySet<string>, loopId: string): boolean {
  return (
    paused.has(loopId) ||
    paused.has(baseRoleOf(loopId)) ||
    (INSTANCE_ROLES.has(loopId) && paused.has(`${loopId}-1`))
  );
}
