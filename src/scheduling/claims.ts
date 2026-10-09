/** Work-instance claims (plans/parallel-work-instances.md "Claims", part 4/7): which backlog
 * entry each runner of a multi-instance base role may take, whether it must drop the entry, and
 * which entry a staged diff moved. The pure policies live here — assignment is the first free
 * entry in file order, release is `left` / `ineligible` / `disabled` / `stale` — so
 * orchestrator-scheduling.ts and tick-stage.ts share one definition and the rules are unit
 * tested without a fleet. The claim itself is persisted on LoopState, so it survives a crash,
 * resume, revision and leftover recovery. */

import path from "node:path";
import type { TumwaterConfig } from "../config/config-schema.js";
import { hasOutstandingWork, type LoopState } from "../loop/loop-state.js";
import { type EligibleEntry, entryKey } from "../backlog/backlog-eligibility.js";
import { actionableEntryRanges } from "../backlog/backlog-structure.js";
import { readTextOrNull } from "../files/files.js";
import { changeBaseRev, fileContentAt } from "../git/git.js";
import { baseRoleOf, configuredInstances } from "../roles/loop-ids.js";

/** How long a claim may sit while its runner is idle before the poll releases it as stale. A
 * day is far past any tick, so the release only catches a claim whose runner stopped taking
 * work — an abandoned entry must return to the free pool for another instance. */
export const CLAIM_IDLE_MAX_MS = 24 * 60 * 60 * 1000;

/** The number of eligible plans PLANS.md's `## Planned` should hold before the plan loop stops
 * for lack of work: one waiting plan per configured feature instance, plus one, so every
 * runner has something to take and the next planner tick still has headroom. At the default
 * one feature instance this is 2 — the "two or more plans" threshold the plan charter has
 * always used (plans/parallel-work-instances.md "…keeping the plan loop ahead", part 5c/7). */
export function planBacklogTarget(config: TumwaterConfig): number {
  return configuredInstances(config, "feature") + 1;
}

/** The runner fields the claim policies read (structural stand-in for LoopRunner, so claims.ts
 * stays free of the runner's lifecycle). */
export interface ClaimRunner {
  role: string;
  state: LoopState;
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
  const md = readTextOrNull(path.join(root, file));
  if (md === null) return keys;
  for (const e of actionableEntryRanges(md, section)) keys.add(entryKey(e.title));
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
  /** The runner has a queued or in-flight landing. */
  hasQueuedLanding: boolean;
  /** The runner's base role is enabled in config (part 5/7 narrows this per instance). */
  enabled: boolean;
}

export type ClaimReleaseReason = "left" | "ineligible" | "disabled" | "stale";

/** Why a runner must drop its claim, or null when it keeps it. A runner is idle when it is not
 * running, has no queued landing, no outstanding revision and no pending resume; `disabled`
 * and `stale` only release an idle runner, while a claim whose entry left or turned ineligible
 * is released outright (there is nothing left to do). */
export function claimReleaseReason(
  runner: ClaimRunner,
  ctx: ClaimReleaseCtx,
): ClaimReleaseReason | null {
  const claim = runner.state.claim;
  if (!claim) return null;
  const idle =
    !runner.state.running &&
    !ctx.hasQueuedLanding &&
    !hasOutstandingWork(runner.state);
  if (!ctx.listedKeys.has(claim.key)) return "left";
  if (!ctx.eligibleKeys.has(claim.key)) return "ineligible";
  if (!ctx.enabled && idle) return "disabled";
  if (idle && ctx.now - claim.at > CLAIM_IDLE_MAX_MS) return "stale";
  return null;
}

/** One entry a changed diff moved out of its actionable section: the key and the heading. */
interface MovedEntry {
  key: string;
  title: string;
}

/** The entries `headMd` moved out of `section` that `baseMd` still listed, in base file order.
 * A moved entry's key matches whether it landed into `## Done`/`## Fixed` or was renamed; a key
 * absent from the head section means it is no longer actionable there. */
export function movedOutEntries(baseMd: string, headMd: string, section: string): MovedEntry[] {
  const headKeys = new Set(actionableEntryRanges(headMd, section).map((e) => entryKey(e.title)));
  return actionableEntryRanges(baseMd, section)
    .filter((e) => !headKeys.has(entryKey(e.title)))
    .map((e) => ({ key: entryKey(e.title), title: e.title }));
}

/** Every entry an uncommitted changed tick moved out of its role's actionable section,
 * comparing the worktree to the merge-base with `mainBranch`. A missing or unreadable file, or
 * a git hiccup, yields [] rather than failing the tick. */
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
