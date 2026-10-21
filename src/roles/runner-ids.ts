/** Runner-id arithmetic for parallel work instances (plans/parallel-work-instances.md, part 1/7). A
 * base role may run several runner ids — `feature`, `feature-2`, `bugfix-3`, … — each keying
 * its own persisted state, branch, refs, session and notes, while every lookup that is ABOUT the
 * role (its catalog charter, model, tier, caps, scheduling class) resolves through the base role.
 * With no instances configured, every runner id is bare, so `baseRoleOf` is the identity.
 *
 * Only `feature` and `bugfix` may gain instances; any other id is returned unchanged, including a
 * custom role whose name merely resembles an instance. */

import type { TumwaterConfig } from "../config/config-schema.js";

/** The base roles that may run more than one instance. */
export const INSTANCE_ROLES: ReadonlySet<string> = new Set(["feature", "bugfix"]);

/** How many runner ids an instance role may hold per configured instance. `instances: N` limits the
 * runs writing code at once; a runner whose change waits in the merge pipeline never runs
 * (plans/merge-queue.md invariant 3), so tumwater keeps up to N × this many runner ids and the
 * poll admits another while fewer than N are running (plans/fast-merge.md "Lever 1"). */
const RUNNERS_PER_INSTANCE = 2;

/** The instance-id shape: a base role, a dash, and an index of 2 or more (`-1` is not an
 * instance — the bare id already means instance 1). The source string is also interpolated into
 * the dashboard script (gui-client-labels.ts). */
export const INSTANCE_ID_SOURCE = "^(feature|bugfix)-([2-9]|[1-9][0-9]+)$";
const INSTANCE_RE = new RegExp(INSTANCE_ID_SOURCE);

/** The base role a runner id belongs to: `feature-2` → `feature`, `bugfix-10` → `bugfix`; any
 * other id — a bare role, a custom role, `feature-1` — is returned unchanged. */
export function baseRoleOf(id: string): string {
  const m = INSTANCE_RE.exec(id);
  return m ? (m[1] as string) : id;
}

/** The 1-based instance number of a runner id: 1 for a bare role or any non-instance id, N for
 * `<role>-N`. */
export function instanceIndex(id: string): number {
  const m = INSTANCE_RE.exec(id);
  return m ? Number(m[2]) : 1;
}

/** Whether a runner id is listed in a role scope, directly or through its base role — a scope
 * naming `feature` takes `feature-2` too. One home for the instance-aware membership test
 * shared by `logs --role`'s and the merge queue's filters and status snapshot scoping, so the
 * three cannot drift on whether a bare role id takes its instances. */
export function roleInScope(id: string, scope: readonly string[]): boolean {
  return scope.includes(id) || scope.includes(baseRoleOf(id));
}

/** The instance count configured for a runner id's base role (`roles.<base>.instances`, default
 * 1). A caller tells a multi-instance base (whose unassigned runs stage claims for their
 * siblings) from a single-runner one by this. */
export function configuredInstances(config: TumwaterConfig, id: string): number {
  const role = config.roles[baseRoleOf(id)];
  return role?.instances ?? 1;
}

/** How many runner ids a base role holds: its configured instance count, times
 * RUNNERS_PER_INSTANCE once it runs more than one instance. A role left at one instance keeps its
 * single bare runner, so its scheduling is exactly the single-runner one. */
function runnerCount(config: TumwaterConfig, base: string): number {
  const count = config.roles[base]?.instances ?? 1;
  return INSTANCE_ROLES.has(base) && count > 1 ? count * RUNNERS_PER_INSTANCE : count;
}

/** Is this runner id enabled? True when its base role is enabled in config and the id's instance
 * index is within the role's runner count (runnerCount). */
export function runnerEnabled(config: TumwaterConfig, id: string): boolean {
  const role = config.roles[baseRoleOf(id)];
  if (role?.enabled !== true) return false;
  return instanceIndex(id) <= runnerCount(config, baseRoleOf(id));
}

/** Every runner id the config says should exist, in `config.roles` order: each enabled role's
 * bare id, then `<id>-2`…`<id>-M` for the `INSTANCE_ROLES` at their runner count
 * (runnerCount: twice the configured instances once there is more than one). Other roles and
 * custom roles stay bare — only feature and bugfix may split. The one
 * answer to "which runners should exist", so the orchestrator (part 5b/7) and live reload
 * enumerate the same set. At the default instance count this returns exactly the bare ids
 * `enabledRoleIds` returns. */
export function runnerIds(config: TumwaterConfig): string[] {
  const ids: string[] = [];
  for (const [id, role] of Object.entries(config.roles)) {
    if (!role.enabled) continue;
    ids.push(id);
    if (!INSTANCE_ROLES.has(id)) continue;
    const count = runnerCount(config, id);
    for (let i = 2; i <= count; i++) ids.push(`${id}-${i}`);
  }
  return ids;
}

/** The pause-marker key for a runner id. Instance 1's runner id is the bare role id, which as a
 * pause key would mean the whole role, so while the role runs several instances instance 1 pauses
 * under `<role>-1`. `-1` is a pause key only, never a runner id. Every other id is its own key. */
export function instancePauseKey(config: TumwaterConfig, runnerId: string): string {
  return INSTANCE_ROLES.has(runnerId) && configuredInstances(config, runnerId) > 1
    ? `${runnerId}-1`
    : runnerId;
}

/** Does the per-role pause marker stop this runner id? True for its own id, its base role's id (a
 * whole-role pause), or — for the bare id of an instance role — the `<role>-1` pause key. */
export function runnerPaused(paused: ReadonlySet<string>, runnerId: string): boolean {
  return (
    paused.has(runnerId) ||
    paused.has(baseRoleOf(runnerId)) ||
    (INSTANCE_ROLES.has(runnerId) && paused.has(`${runnerId}-1`))
  );
}

