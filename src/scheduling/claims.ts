/** Work-instance claims (plans/parallel-work-instances.md "Claims", part 4/7): which backlog
 * entry each runner of a multi-instance base role may take, whether it must drop the entry, and
 * which entry a staged diff moved. The pure policies live here — assignment is the first free
 * entry in file order, release is `left` / `ineligible` / `disabled` / `stale` — so
 * orchestrator-scheduling.ts and run-stage.ts share one definition and the rules are unit
 * tested without a team. The claim itself is persisted on RunnerState, so it survives a crash,
 * resume, revision and leftover recovery. */

import path from "node:path";
import type { TumwaterConfig } from "../config/config-schema.js";
import { DAY_MS } from "../text/datetime.js";
import { hasOutstandingWork, type RunnerState } from "../runner/runner-state.js";
import { type EligibleEntry, backlogHolds, eligibleEntries } from "../backlog/backlog-eligibility.js";
import { entryKey } from "../backlog/backlog-parts.js";
import { actionableEntryRanges, actionableEntryRangesFor } from "../backlog/backlog-structure.js";
import { readTextOrNull } from "../files/files.js";
import { changeBaseRev, fileContentAt } from "../git/git.js";
import { INSTANCE_ROLES, baseRoleOf, configuredInstances } from "../roles/runner-ids.js";

/** How long a claim may sit while its runner is idle before the poll releases it as stale. A
 * day is far past any run, so the release only catches a claim whose runner stopped taking
 * work — an abandoned entry must return to the free pool for another instance. */
export const CLAIM_IDLE_MAX_MS = DAY_MS;

/** The number of eligible plans PLANS.md's `## Planned` should hold before the plan role stops
 * for lack of work: one waiting plan per configured feature instance, plus one, so every
 * runner has something to take and the next planner run still has headroom. At the default
 * one feature instance this is 2 — the "two or more plans" threshold the plan charter has
 * always used (plans/parallel-work-instances.md "…keeping the plan role ahead", part 5c/7). */
export function planBacklogTarget(config: TumwaterConfig): number {
  return configuredInstances(config, "feature") + 1;
}

/** Does PLANS.md already hold the plan role's target (planBacklogTarget eligible plans), with no
 * plan marked needs-review or needs-replan? The charter makes splitting or replanning a marked
 * plan outrank the stop, so a marked entry keeps the plan role running; otherwise a plan run can
 * only end in TUMWATER_NOTHING_TO_DO and the scheduler defers it (deferRunReason). */
export function planBacklogFull(root: string, config: TumwaterConfig): boolean {
  if (eligibleEntries(root, "feature").length < planBacklogTarget(config)) return false;
  return !backlogHolds(root).plans.some((h) => h === "needs-review" || h === "needs-replan");
}

/** The runner fields the claim policies read (structural stand-in for RoleRunner, so claims.ts
 * stays free of the runner's lifecycle). */
export interface ClaimRunner {
  role: string;
  state: RunnerState;
}

/** The backlog file and section a role's entries live under: PLANS.md's `## Planned` for
 * feature, BUGS.md's `## Open` for bugfix. An instance id resolves through its base role. */
function roleSection(role: string): { file: "PLANS.md" | "BUGS.md"; section: string } {
  return baseRoleOf(role) === "bugfix"
    ? { file: "BUGS.md", section: "Open" }
    : { file: "PLANS.md", section: "Planned" };
}

/** Every entry key listed under a role's backlog section, held or not: the set that separates a
 * claim whose entry left the section (`left`) from one that is still listed but ineligible
 * (`ineligible`). */
export function listedKeys(root: string, role: string): Set<string> {
  const { file, section } = roleSection(role);
  const keys = new Set<string>();
  for (const e of actionableEntryRangesFor(root, file, section)) keys.add(entryKey(e.title));
  return keys;
}

/** The keys claimed by any of `runners` that are still both listed and eligible — the entries
 * the group must not hand to a second instance. A claim on an entry that left or turned
 * ineligible is excluded: the poll releases it before free entries are computed. */
export function heldKeys(
  runners: readonly ClaimRunner[],
  eligibleKeys: ReadonlySet<string>,
  listedKeys: ReadonlySet<string>,
): Set<string> {
  const held = new Set<string>();
  for (const r of runners) {
    const key = r.state.claim?.key;
    if (key !== undefined && eligibleKeys.has(key) && listedKeys.has(key)) held.add(key);
  }
  return held;
}

/** The entry to assign next: the first free entry in file order, or null when none is free.
 * One small seam so the assignment rule is stated in one place. */
export function assignNext(free: readonly EligibleEntry[]): EligibleEntry | null {
  return free[0] ?? null;
}

/** What the poll knows when it judges a claim. */
interface ClaimReleaseCtx {
  /** Every key currently listed under the role's section (held or not). */
  listedKeys: ReadonlySet<string>;
  /** The keys eligibleEntries found (listed, not blocked/refused/needs-review). */
  eligibleKeys: ReadonlySet<string>;
  now: number;
  /** The runner has a queued or in-flight merge. */
  hasQueuedMerge: boolean;
  /** The runner's role id is enabled in config (`runnerEnabled`, so a lowered `instances`
   * disables the surplus runner). */
  enabled: boolean;
  /** This runner's own role id is paused while its base role is not. With the base role paused
   * every instance is paused, so no sibling could take the entry and releasing it would only
   * churn claims. */
  paused: boolean;
}

/** Why a runner drops its queued-merge claim; claimReleaseReason below decides each arm. */
export type ClaimReleaseReason = "left" | "ineligible" | "disabled" | "paused" | "stale";

/** Why a runner must drop its claim, or null when it keeps it. A runner is idle when it is not
 * running, has no queued merge, no outstanding revision and no pending resume; `disabled`,
 * `paused` and `stale` only release an idle runner, while a claim whose entry left or turned
 * ineligible is released outright (there is nothing left to do). */
export function claimReleaseReason(
  runner: ClaimRunner,
  ctx: ClaimReleaseCtx,
): ClaimReleaseReason | null {
  const claim = runner.state.claim;
  if (!claim) return null;
  const idle =
    !runner.state.running &&
    !ctx.hasQueuedMerge &&
    !hasOutstandingWork(runner.state);
  if (!ctx.listedKeys.has(claim.key)) return "left";
  if (!ctx.eligibleKeys.has(claim.key)) return "ineligible";
  if (!ctx.enabled && idle) return "disabled";
  if (ctx.paused && idle) return "paused";
  if (idle && ctx.now - claim.at > CLAIM_IDLE_MAX_MS) return "stale";
  return null;
}

/** One entry a changed diff moved out of its actionable section: the key and the heading. */
interface MovedEntry {
  key: string;
  title: string;
}

/** The entries `headMd` moved out of `section` that `baseMd` still listed, in base file order.
 * A moved entry's key matches whether it merged into `## Done`/`## Fixed` or was renamed; a key
 * absent from the head section means it is no longer actionable there. */
export function movedOutEntries(baseMd: string, headMd: string, section: string): MovedEntry[] {
  const headKeys = new Set(actionableEntryRanges(headMd, section).map((e) => entryKey(e.title)));
  return actionableEntryRanges(baseMd, section)
    .filter((e) => !headKeys.has(entryKey(e.title)))
    .map((e) => ({ key: entryKey(e.title), title: e.title }));
}

/** Every entry an uncommitted changed run moved out of its role's actionable section,
 * comparing the worktree to the merge-base with `mainBranch`. A missing or unreadable file, or
 * a git hiccup, yields [] rather than failing the run. */
export async function stagedMovedEntries(
  wt: string,
  mainBranch: string,
  role: string,
): Promise<{ file: "PLANS.md" | "BUGS.md"; key: string; title: string }[]> {
  const { file, section } = roleSection(role);
  const head = readTextOrNull(path.join(wt, file));
  if (head === null) return [];
  const base = await fileContentAt(wt, await changeBaseRev(wt, mainBranch), file);
  return movedOutEntries(base, head, section).map((e) => ({ file, ...e }));
}

/** How many permits to withhold from tier ≥ 1 acquirers this poll so a work role that has work
 * to take can claim one without waiting out a maintenance run (plans/parallel-work-instances.md
 * "Priority headroom", part 7/7). Only the claim-taking roles (feature, bugfix) count: an idle
 * one — not running, with no queued merge — counts when it either holds an eligible claim or
 * its base role still has an unclaimed eligible entry. Returns min(floor(maxConcurrent / 3),
 * the count), so an entirely busy work tier reserves nothing. */
export function workReserveCount(
  root: string,
  runners: readonly ClaimRunner[],
  opts: {
    maxConcurrent: number;
    /** The role ids the live config enables (runnerEnabled). */
    enabled: ReadonlySet<string>;
    /** The role ids with a queued or in-flight merge. */
    queuedMergeRoles: ReadonlySet<string>;
    /** Whether an idle work role's provider still has headroom to use a reserved permit
     * (plans/provider-concurrency.md §6). With per-provider caps, withholding a team permit
     * for a role whose provider is full only idles a slot another provider's maintenance run
     * could use, so such a role adds nothing to the reserve. The caller supplies it from the
     * pool's snapshot() — this policy stays free of the seams. Defaults to counting every idle
     * work role, the pre-caps behavior. */
    providerHasHeadroom?: (runner: ClaimRunner) => boolean;
    /** The base role's `instances`: the most runs writing code at once. A role may hold twice as
     * many runner ids, so idle runners reserve only the places not already taken by running
     * ones. Defaults to no limit. */
    instancesOf?: (base: string) => number;
  },
): number {
  // Eligible keys per claim-taking base, read once.
  const eligibleByBase = new Map<string, Set<string>>();
  const eligibleFor = (base: string): Set<string> => {
    let keys = eligibleByBase.get(base);
    if (keys === undefined) {
      keys = new Set(eligibleEntries(root, base).map((e) => e.key));
      eligibleByBase.set(base, keys);
    }
    return keys;
  };
  // The keys held by a claim that is still eligible: an ineligible claim holds nothing for the
  // size below, exactly as heldKeys excludes it in the scheduling pass.
  const heldByBase = new Map<string, Set<string>>();
  for (const r of runners) {
    const base = baseRoleOf(r.role);
    if (!INSTANCE_ROLES.has(base)) continue;
    const key = r.state.claim?.key;
    if (key === undefined || !eligibleFor(base).has(key)) continue;
    const held = heldByBase.get(base) ?? new Set<string>();
    held.add(key);
    heldByBase.set(base, held);
  }
  const running = new Map<string, number>();
  for (const r of runners) {
    const base = baseRoleOf(r.role);
    if (INSTANCE_ROLES.has(base) && r.state.running && !opts.queuedMergeRoles.has(r.role)) {
      running.set(base, (running.get(base) ?? 0) + 1);
    }
  }
  const idleByBase = new Map<string, number>();
  for (const r of runners) {
    const base = baseRoleOf(r.role);
    if (!INSTANCE_ROLES.has(base)) continue;
    if (!opts.enabled.has(r.role)) continue;
    if (r.state.running || opts.queuedMergeRoles.has(r.role)) continue;
    // A work role whose provider is full (capped and at its cap) cannot use a reserved permit
    // anyway, so it must not withhold one from another provider's maintenance run (§6).
    if (opts.providerHasHeadroom !== undefined && !opts.providerHasHeadroom(r)) continue;
    const eligible = eligibleFor(base);
    const holdsClaim = r.state.claim !== undefined && eligible.has(r.state.claim.key);
    const hasFreeEntry = [...eligible].some((k) => !(heldByBase.get(base)?.has(k) ?? false));
    if (holdsClaim || hasFreeEntry) idleByBase.set(base, (idleByBase.get(base) ?? 0) + 1);
  }
  let count = 0;
  for (const [base, idle] of idleByBase) {
    const places = Math.max(0, (opts.instancesOf?.(base) ?? Infinity) - (running.get(base) ?? 0));
    count += Math.min(idle, places);
  }
  return Math.min(Math.floor(opts.maxConcurrent / 3), count);
}
