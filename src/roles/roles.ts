/** The role registries and classification helpers over the built-in role catalog. The catalog
 * itself — each loop's identity and its "find something to do" prompt text — lives in
 * role-catalog.ts (split out 2026-10-01, organize); this module re-exports ROLES and Role so
 * every importer keeps the single roles.js import path, and derives from them the scheduling
 * registries (work/maintenance/observer tiers, deferrable and baseline-blocked sets) and the
 * lookup helpers the CLI, GUI, and tick prompt share. */

import { ROLES, type Role } from "./role-catalog.js";
import { baseRoleOf } from "./loop-ids.js";
import { typoSuffix } from "../text/suggest.js";

export { ROLES };
export type { Role };

/** The director loop's id — a target that is not in ROLES (allRoleIds appends it) and is
 * driven by operator prompts, not a find prompt: an un-targeted `tumwater prompt` queues
 * there. It keeps running through a fleet-wide `pause` (which stops only the role loops);
 * an un-targeted `stop` signals the whole orchestrator, director included. */
export const DIRECTOR_ROLE = "director";

/** The bugfix loop's id. It is the one work role that also defers like a maintenance role while its
 * backlog (BUGS.md `## Open`) is empty — see deferTick in src/scheduling/scheduling.ts. */
export const BUGFIX_ROLE = "bugfix";

/** Work-tier roles (need-based prioritization, PLANS.md "Prioritize loops by need"): they
 * ship work — feature and bugfix land code on main, plan feeds them — so their due ticks are
 * never deferred and slot allocation always orders them ahead of maintenance. */
const WORK_ROLES: ReadonlySet<string> = new Set(["feature", "bugfix", "plan"]);

/** Observer roles (plans/observer-roles.md 1/2): a role whose product is an observation, not a
 * commit, and for which `no_change` means "checked, all well" rather than "found nothing to do".
 * The idle ladder's premise — a loop that keeps finding nothing stops burning model time — does
 * not hold for these, so their no_change tick schedules at `minTickIntervalSeconds` and leaves
 * `backoffSeconds` at 0 (src/scheduling/backoff.ts). The error ladder still applies in full, and
 * they are removed from DEFERRABLE_ROLES because their input (the running product for `qa`, the
 * event log for `telemetry`) is not a function of whether main moved. */
export const OBSERVER_ROLES: ReadonlySet<string> = new Set(["qa", "telemetry"]);

/** The built-in maintenance roles that author code on their own cadence — the eight members
 * DEFERRABLE_ROLES and BASELINE_BLOCKED_ROLES share. Both sets list them because both charter
 * the same roles (defer-until-needed scheduling, red-main blocking), so the list lives once
 * here and a new maintenance role cannot be added to one set and missed in the other. */
const CODE_MAINTENANCE_ROLES: readonly string[] = [
  "organize",
  "coverage",
  "clean",
  "dry",
  "perf",
  "security",
  "robustness",
  "improve",
];

/** Maintenance-tier roles (need-based prioritization): exactly the ten built-ins whose due
 * ticks are deferrable while no feature/bugfix/director/human commit has landed on main since
 * their last tick and that tick did nothing. Unknown/custom roles are deliberately NOT in this
 * set — the harness cannot judge what an arbitrary custom role needs, so they never defer (they
 * still sort into tier 1 for fairOrder via roleTier). Observers are excluded: an unmoved tree
 * says nothing about whether the product or the event log has something new to report. */
export const DEFERRABLE_ROLES: ReadonlySet<string> = new Set([
  "readme",
  ...CODE_MAINTENANCE_ROLES,
  "steward",
]);

/** Does this role's recent yield scale its min-tick gap (yield-scaled clocks, PLANS.md)?
 * The search/maintenance roles — the deferrable ten, the observers, and bugfix on its
 * empty-backlog search duty (it is the one work role that defers like maintenance, so its
 * idle clock stretches like one too; the open-bugs state is deferTick's concern, not the
 * clock's: ten consecutive empty ticks are empty-yield evidence however many bugs are
 * recorded). Never the work roles whose ticks follow demand — feature, plan, director — a
 * role with a queued prompt or a fresh wake bypasses the gap entirely (isEligible), and the
 * multiplier is computed from counted results only (backoff.ts), so feature's errors
 * and quiet kills never stretch anything. */
export function yieldScaledRole(role: string): boolean {
  const base = baseRoleOf(role);
  return DEFERRABLE_ROLES.has(base) || OBSERVER_ROLES.has(base) || base === BUGFIX_ROLE;
}

/** Scheduling tier for fairOrder's slot allocation (need-based prioritization): 0 for work
 * roles, 1 for everything else. The director is excluded by callers — it leads unconditionally,
 * ahead of both tiers. */
export function roleTier(role: string): number {
  return WORK_ROLES.has(baseRoleOf(role)) ? 0 : 1;
}

/** The roles blocked from starting an authoring run while main's own build/test suite is known
 * red (the red-main baseline check, PLANS.md "Red-main baseline check"): every role whose diff
 * can carry non-exempt (code) changes — on a red main such a diff is rejected deterministically
 * by the gate's pre-check, so spending an authoring run on it is pure waste. Exempt: director
 * (human prompts outrank autonomous gates, like the budget gate), bugfix (the designated healer
 * — its tick runs the suite per "leave the project working" and can fix a red main through the
 * existing pre-merge gate; blocking it would leave only humans able to unblock the fleet), and
 * plan/readme/steward/qa/telemetry (markdown-only charter — their diffs are exempt from the build
 * pre-check via review.exemptPaths, so a red main does not block them). */
export const BASELINE_BLOCKED_ROLES: ReadonlySet<string> = new Set([
  "feature",
  ...CODE_MAINTENANCE_ROLES,
]);

/** Is this loop id blocked from authoring on a red main? True when its base role is in
 * BASELINE_BLOCKED_ROLES, so `feature-2` is blocked exactly as `feature` is. */
export function baselineBlocked(role: string): boolean {
  return BASELINE_BLOCKED_ROLES.has(baseRoleOf(role));
}

/** Work ratio 4/4: which commit tier a loop's base role lands into, for the work vs maintenance
 * split the report and the "Landed today" tile show. `work` is the shipping tier (feature,
 * bugfix, director); `maintenance` is code upkeep plus readme — Work ratio 1/4's QUOTA_ROLES,
 * which this predates, so its CODE_MAINTENANCE_ROLES list plus readme. Every other role (plan,
 * steward, observers, custom) is neither and counts only toward the total commits. */
export function commitTier(role: string): "work" | "maintenance" | undefined {
  const base = baseRoleOf(role);
  if (base === "feature" || base === BUGFIX_ROLE || base === DIRECTOR_ROLE) return "work";
  if (base === "readme" || CODE_MAINTENANCE_ROLES.includes(base)) return "maintenance";
  return undefined;
}

/** Every role id, including the director (which is driven by user prompts, not a find prompt). */
export function allRoleIds(): string[] {
  return [...ROLES.map((r) => r.id), DIRECTOR_ROLE];
}

/** Look up a catalog role by id. Searches only the catalog, so unknown ids — and the
 * director (which has no find prompt and is not in ROLES) — yield undefined. */
export function roleById(id: string): Role | undefined {
  const base = baseRoleOf(id);
  return ROLES.find((r) => r.id === base);
}

/** The harness's one unknown-role error text: `unknown role: <id> (valid ids: <ids>)`, with
 * a did-you-mean suggestion when the typed id sits within edit distance 2 of a valid one —
 * the same treatment unknownConfigKeyError gives config keys, so a mistyped `--role feautre`
 * names its fix instead of only the valid list. parseRoleFlag, the operator commands, and
 * tick-prompt's defensive runner path share it so the wording cannot drift between the CLI,
 * the GUI, and a tick's internal error. The hint is text/suggest.ts's typoSuffix —
 * suggestClosest plus didYouMean composed once, the pairing every other unknown-X error
 * renders through. */
export function unknownRoleMessage(role: string, validIds: readonly string[]): string {
  return `unknown role: ${role} (valid ids: ${validIds.join(", ")})${typoSuffix(role, validIds)}`;
}

/** A user-defined loop as a Role (plans/user-defined-loops.md): its task IS the
 * role-specific find-something-to-do text, and the title is what identifies the loop inside
 * its own prompt (`You are the "<name>" loop (user-defined loop)`) and commit context.
 * Custom loops run the `default` tier — the harness cannot judge what an arbitrary loop's
 * work needs, so it gets the fleet's ordinary model. */
export function customRole(name: string, task: string): Role {
  return { id: name, title: "user-defined loop", find: task, tier: "default" };
}
