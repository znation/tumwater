/** Work-instance claims (plans/parallel-work-instances.md "Claims", part 4/7): which backlog
 * entry each runner of a multi-instance base role may take, whether it must drop the entry, and
 * which entry a staged diff moved. The pure policies live here — assignment is the first free
 * entry in file order, release is `left` / `withdrawn` / `ineligible` / `disabled` / `paused` /
 * `stale` — so
 * scheduling/admit.ts and run-stage.ts share one definition and the rules are unit
 * tested without a team. The claim itself is persisted on RunnerState, so it survives a crash,
 * resume, revision and leftover recovery. */

import path from "node:path";
import type { TumwaterConfig } from "../config/config-schema.js";
import { DAY_MS } from "../text/datetime.js";
import { hasOutstandingWork, type RunnerState } from "../runner/runner-state.js";
import { type EligibleEntry, backlogHolds, eligibleEntries, roleSection } from "../backlog/backlog-eligibility.js";
import { entryKey } from "../backlog/backlog-parts.js";
import { actionableEntryRanges, actionableEntryRangesFor } from "../backlog/backlog-index-data.js";
import { stripEntryStamp } from "../backlog/backlog-structure.js";
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
 * plan marked needs-review? The charter makes splitting or replanning a marked
 * plan outrank the stop, so a marked entry keeps the plan role running; otherwise a plan run can
 * only end in TUMWATER_NOTHING_TO_DO and the scheduler defers it (deferRunReason). */
export function planBacklogFull(root: string, config: TumwaterConfig): boolean {
  if (eligibleEntries(root, "feature").length < planBacklogTarget(config)) return false;
  return !backlogHolds(root).plans.some((h) => h === "needs-review");
}

/** The runner fields the claim policies read (structural stand-in for RoleRunner, so claims.ts
 * stays free of the runner's lifecycle). */
export interface ClaimRunner {
  role: string;
  state: RunnerState;
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
  /** The runner's role id is enabled in config (`runnerEnabled`, so a lowered `instances`
   * disables the surplus runner). */
  enabled: boolean;
  /** This runner's own role id is paused while its base role is not. With the base role paused
   * every instance is paused, so no sibling could take the entry and releasing it would only
   * churn claims. */
  paused: boolean;
}

/** Why a runner drops its queued-merge claim; claimReleaseReason below decides each arm. */
export type ClaimReleaseReason = "left" | "withdrawn" | "ineligible" | "disabled" | "paused" | "stale";

/** Whether a runner that is not running still owes work to its claimed entry: a revision of
 * its rejected change, or the resume of an interrupted run that worked the claim. A resume that
 * owns a re-queued user request (resumePromptFile) worked that request instead: the claim was
 * only kept for a later run, so it owes the entry nothing. */
function owesClaimedWork(s: RunnerState): boolean {
  return s.revision !== undefined || (s.resumePending === true && s.resumePromptFile === undefined);
}

/** Why a runner must drop its claim, or null when it keeps it. A runner is idle when it is not
 * running, has no outstanding revision and no pending resume; `disabled`, `paused` and `stale`
 * only release an idle runner, and a claim whose entry turned ineligible is released outright.
 * A claim whose entry left the section depends on what the runner still owes it. A run in
 * progress keeps the claim, so the run that settles it is still known to be this entry's: its
 * queued change records the claim for the merge, and a restart that cuts it short leaves a resume
 * the next poll withdraws. A resume or revision still owed to the entry is `withdrawn`: the
 * operator deleted the entry, or another change finished it, and the poll drops that work with
 * the claim (dropWithdrawnWork). Otherwise the claim is `left`: the change merged, or it waits in
 * the merge queue, which drops it there once main no longer lists the entry
 * (merge-withdrawn.ts). */
export function claimReleaseReason(
  runner: ClaimRunner,
  ctx: ClaimReleaseCtx,
): ClaimReleaseReason | null {
  const claim = runner.state.claim;
  if (!claim) return null;
  const idle = !runner.state.running && !hasOutstandingWork(runner.state);
  if (!ctx.listedKeys.has(claim.key)) {
    if (runner.state.running) return null;
    return owesClaimedWork(runner.state) ? "withdrawn" : "left";
  }
  if (!ctx.eligibleKeys.has(claim.key)) return "ineligible";
  if (!ctx.enabled && idle) return "disabled";
  if (ctx.paused && idle) return "paused";
  if (idle && ctx.now - claim.at > CLAIM_IDLE_MAX_MS) return "stale";
  return null;
}

/** What a `withdrawn` release dropped with the claim, for its warning. */
interface WithdrawnWork {
  resume: boolean;
  revision: boolean;
}

/** Drop the work a runner still owes a claim released as `withdrawn`: the resume of a run that
 * worked the claim (with its cause flags and the one-shot image reroute it would hand off to)
 * and the rejected change's revision. A resume that owns a re-queued user request is the
 * request's, not the claim's, and stays. The next run then starts fresh, on whatever entry the
 * poll assigns, and its fresh lease salvages the kept slot's edits for the operator instead of
 * resuming them. Mutates `state`; the caller deletes the revision's rejected ref and saves. */
export function dropWithdrawnWork(state: RunnerState): WithdrawnWork {
  const resume = state.resumePending === true && state.resumePromptFile === undefined;
  const dropped = { resume, revision: state.revision !== undefined };
  if (resume) {
    state.resumePending = false;
    state.resumeCause = undefined;
    state.resumeMissing = undefined;
    state.imageReroute = undefined;
  }
  state.revision = undefined;
  return dropped;
}

/** The warning a `withdrawn` release logs: what it dropped, the entry, and why. */
export function withdrawnWorkWarning(title: string, file: "PLANS.md" | "BUGS.md", dropped: WithdrawnWork): string {
  const what = [
    ...(dropped.resume ? ["the interrupted run"] : []),
    ...(dropped.revision ? ["the rejected change's revision"] : []),
  ].join(" and ");
  const section = file === "BUGS.md" ? "Open" : "Planned";
  return `dropped ${what || "the work"} on "${stripEntryStamp(title)}": ${file} on main no longer lists it under ## ${section}, so it will not resume or merge; the role takes its next entry`;
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

/** One memoized eligible-key reader for a root: the first read of a claim-taking base fills
 * the cache from eligibleEntries, later reads of the same base return the cached set, so each
 * base is read once per poll. */
function eligibleKeysByBase(root: string): (base: string) => Set<string> {
  const eligibleByBase = new Map<string, Set<string>>();
  return (base: string): Set<string> => {
    let keys = eligibleByBase.get(base);
    if (keys === undefined) {
      keys = new Set(eligibleEntries(root, base).map((e) => e.key));
      eligibleByBase.set(base, keys);
    }
    return keys;
  };
}

/** The keys each claim-taking base holds by a claim whose key is still eligible: a claim on an
 * entry that left or turned ineligible holds nothing for the reserve below, exactly as heldKeys
 * excludes it in the scheduling pass. */
function heldClaimKeysByBase(
  runners: readonly ClaimRunner[],
  eligibleFor: (base: string) => ReadonlySet<string>,
): Map<string, Set<string>> {
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
  return heldByBase;
}

/** One per running runner of each claim-taking base: the running count consumes the base's
 * `instances` places before any idle runner may reserve one. */
function runningRunnersByBase(runners: readonly ClaimRunner[]): Map<string, number> {
  const running = new Map<string, number>();
  for (const r of runners) {
    const base = baseRoleOf(r.role);
    if (INSTANCE_ROLES.has(base) && r.state.running) {
      running.set(base, (running.get(base) ?? 0) + 1);
    }
  }
  return running;
}

/** The idle claim-taking runners per base that reserve a permit: enabled, not running, and
 * either holding a still-eligible claim or seeing a free eligible entry their base does not
 * already hold. */
function idleWorkRunnersByBase(
  runners: readonly ClaimRunner[],
  enabled: ReadonlySet<string>,
  eligibleFor: (base: string) => ReadonlySet<string>,
  heldByBase: ReadonlyMap<string, Set<string>>,
): Map<string, number> {
  const idleByBase = new Map<string, number>();
  for (const r of runners) {
    const base = baseRoleOf(r.role);
    if (!INSTANCE_ROLES.has(base)) continue;
    if (!enabled.has(r.role)) continue;
    if (r.state.running) continue;
    const eligible = eligibleFor(base);
    const holdsClaim = r.state.claim !== undefined && eligible.has(r.state.claim.key);
    const hasFreeEntry = [...eligible].some((k) => !(heldByBase.get(base)?.has(k) ?? false));
    if (holdsClaim || hasFreeEntry) idleByBase.set(base, (idleByBase.get(base) ?? 0) + 1);
  }
  return idleByBase;
}

/** The permits to withhold: per idle base, min(idle runners, the `instances` places its running
 * runners leave free), summed over bases and capped at a third of maxConcurrent. */
function reserveFromIdleByBase(
  idleByBase: ReadonlyMap<string, number>,
  runningByBase: ReadonlyMap<string, number>,
  maxConcurrent: number,
  instancesOf: ((base: string) => number) | undefined,
): number {
  let count = 0;
  for (const [base, idle] of idleByBase) {
    const places = Math.max(0, (instancesOf?.(base) ?? Infinity) - (runningByBase.get(base) ?? 0));
    count += Math.min(idle, places);
  }
  return Math.min(Math.floor(maxConcurrent / 3), count);
}

/** How many permits to withhold from tier ≥ 1 acquirers this poll so a work role that has work
 * to take can claim one without waiting out a maintenance run (plans/parallel-work-instances.md
 * "Priority headroom", part 7/7). Only the claim-taking roles (feature, bugfix) count: an idle
 * one — not running — counts when it either holds an eligible claim or its base role still has
 * an unclaimed eligible entry. Returns min(floor(maxConcurrent / 3), the count), so an entirely
 * busy work tier reserves nothing. */
export function workReserveCount(
  root: string,
  runners: readonly ClaimRunner[],
  opts: {
    maxConcurrent: number;
    /** The role ids the live config enables (runnerEnabled). */
    enabled: ReadonlySet<string>;
    /** The base role's `instances`: the most runs writing code at once. A role may hold twice as
     * many runner ids, so idle runners reserve only the places not already taken by running
     * ones. Defaults to no limit. */
    instancesOf?: (base: string) => number;
  },
): number {
  const eligibleFor = eligibleKeysByBase(root);
  const heldByBase = heldClaimKeysByBase(runners, eligibleFor);
  const runningByBase = runningRunnersByBase(runners);
  const idleByBase = idleWorkRunnersByBase(runners, opts.enabled, eligibleFor, heldByBase);
  return reserveFromIdleByBase(idleByBase, runningByBase, opts.maxConcurrent, opts.instancesOf);
}
