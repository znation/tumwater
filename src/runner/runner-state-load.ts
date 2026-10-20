// vocabulary: plain
import type { RunnerState } from "./runner-state.js";
import { APPROVED_PATCH_IDS_MAX, freshRunnerState, SKIP_REASONS } from "./runner-state.js";
import path from "node:path";
import { readdirSync } from "node:fs";
import { readJsonFile } from "../files/json-files.js";
import { isJsonObject, nonNegativeNumber, validEntries } from "../files/json-object.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { statePath, STATE_DIR } from "../paths.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { allRoleIds } from "../roles/roles.js";

/** The read side of the runner's persisted state: the tolerant load of one role's file (heals
 * every field a hand edit or an older build could leave unusable, and renames the keys an older
 * build wrote) and the live-claim scan over every role's file. The type, the fresh-state
 * defaults, the atomic save and zeroCounters stay in runner-state.ts. */

/** A persisted numeric field, healed to a finite non-negative number (the fallback when it is
 * absent, foreign, NaN/±Infinity, or negative). Every numeric field on RunnerState — top-level or
 * inside one of the nested records below — is a count, a duration, an epoch-ms stamp, or an
 * amount, so zero is the only sensible repair; the `run-usage.ts` and `budget.ts` writers floor
 * the same three quantities they own. A guard count (mergeConflicts, mergeCheckFailures,
 * unreviewFailures) heals to 0 like the rest: a corrupt strike tally re-accumulates from the
 * next attempt, the same "the field is unusable, start the count over" repair the top-level heal
 * already gives the error streak. */
function healNumber(value: unknown, fallback: number): number {
  return nonNegativeNumber(value, fallback);
}

/** Heal the per-pair daily spend map: a non-object reads as `{}`, entries that are not
 * non-negative finite numbers drop, and a `__proto__` key stays an own property. */
function healPairCosts(value: unknown): Record<string, number> {
  return validEntries(value, (v): v is number => nonNegativeNumber(v, -1) >= 0);
}

/** Heal one OPTIONAL numeric field of a persisted record in place, preserving the field's
 * absent shape: an absent field stays absent (an older state file with no such field reads
 * unchanged), while a present field heals by healNumber's rule. Every optional numeric field
 * loadRunnerState repairs — the eight top-level stamps/streaks and conflictHandback.round —
 * goes through this one guard, so the "absent stays absent" repair cannot be dropped from
 * one field while another keeps it. */
function healOptionalNumber<T extends object, K extends keyof T>(rec: T, key: K): void {
  const value = rec[key];
  if (value !== undefined) rec[key] = healNumber(value, 0) as T[K];
}

/** Heal one persisted nested record: absent stays absent; a present non-object (a string,
 * number, NaN, null, or array) is dropped to undefined — every consumer of these records reads
 * them with property access or mutation (merge-core sets `lastReview.exhausted`, run-apply
 * adds to `mergeConflicts.count`), and property access on a torn scalar reads undefined where
 * the mutation throws "Cannot create property … on string" in a strict ES module; a present
 * object keeps its shape with each numeric field repaired by `heal`. */
function healRecord<T extends object>(value: T | undefined, heal: (v: T) => void): T | undefined {
  if (value === undefined || !isJsonObject(value)) return undefined;
  heal(value);
  return value;
}

/** Keys an older build wrote, mapped to their current names. loadRunnerState copies the old key's
 * value to the new key when the new key is absent and always drops the old key, so a file holding
 * both keeps the new value and the next save writes only current keys. */
const LEGACY_STATE_KEYS: Readonly<Record<string, string>> = {
  ticks: "runs", // retired-name-ok: legacy name
  lastTickStartedAt: "lastRunStartedAt", // retired-name-ok: legacy name
  lastTickEndedAt: "lastRunEndedAt", // retired-name-ok: legacy name
  // retired-name-ok:start old state keys
  landingReviewError: "mergeReviewError", // vocabulary-ok: legacy state key read from old files
  landingCheckFailures: "mergeCheckFailures", // vocabulary-ok: legacy state key read from old files
  lastLandedAt: "lastMergedAt", // vocabulary-ok: legacy state key read from old files
  // retired-name-ok:end
};

/** Apply LEGACY_STATE_KEYS to a parsed state object in place. */
function migrateLegacyStateKeys(saved: Record<string, unknown>): void {
  for (const [oldKey, newKey] of Object.entries(LEGACY_STATE_KEYS)) {
    if (!(oldKey in saved)) continue;
    if (!(newKey in saved)) saved[newKey] = saved[oldKey];
    delete saved[oldKey];
  }
}

/** Load the runner's persisted state; never throws — a missing or unreadable file yields a
 * fresh state, fields absent from an older file fall back to defaults, and a numeric field
 * (top-level or nested) that is present but not a finite non-negative number is healed to 0,
 * a nested record that is present but not a plain object is dropped, and lastReview.reasons is
 * rebuilt to its string entries. The load is the one
 * read boundary for the state file (readJsonFile returns an unchecked cast), so healing here
 * keeps a hand-edited string, null, or negative out of the schedulers and the dashboards'
 * arithmetic instead of relying on each reader to guard it. Optional fields that are absent
 * stay absent, so an older state file's shape is preserved. */
export function loadRunnerState(root: string, role: string): RunnerState {
  const saved = readJsonFile<Partial<RunnerState>>(statePath(root, role));
  if (saved !== undefined && saved !== null && isJsonObject(saved)) migrateLegacyStateKeys(saved);
  const s: RunnerState = { ...freshRunnerState(role), ...(saved ?? {}) };
  s.runs = healNumber(s.runs, 0);
  s.commits = healNumber(s.commits, 0);
  s.nextRunAt = healNumber(s.nextRunAt, 0);
  s.backoffSeconds = healNumber(s.backoffSeconds, 0);
  s.generatedTokens = healNumber(s.generatedTokens, 0);
  s.peakContextTokens = healNumber(s.peakContextTokens, 0);
  s.totalCostUsd = healNumber(s.totalCostUsd, 0);
  s.dayCostUsd = healNumber(s.dayCostUsd, 0);
  if (s.dayCostByPair !== undefined) s.dayCostByPair = healPairCosts(s.dayCostByPair);
  healOptionalNumber(s, "lastRunStartedAt");
  healOptionalNumber(s, "lastRunEndedAt");
  healOptionalNumber(s, "lastMergedAt");
  healOptionalNumber(s, "wokenAt");
  healOptionalNumber(s, "cutOffStreak");
  healOptionalNumber(s, "quietKillStreak");
  healOptionalNumber(s, "consecutiveErrors");
  healOptionalNumber(s, "noChangeStreak");
  healOptionalNumber(s, "unreviewFailures");
  healOptionalNumber(s, "parkedSince");
  if (s.skipReason !== undefined && !SKIP_REASONS.includes(s.skipReason)) delete s.skipReason;
  // The one-id field an older state file carries folds into the list.
  const legacy = (saved as { lastApprovedPatchId?: unknown } | null)?.lastApprovedPatchId;
  delete (s as { lastApprovedPatchId?: unknown }).lastApprovedPatchId;
  if (s.approvedPatchIds !== undefined || typeof legacy === "string") {
    const ids = [...(Array.isArray(s.approvedPatchIds) ? s.approvedPatchIds : []), ...(typeof legacy === "string" ? [legacy] : [])];
    s.approvedPatchIds = ids.filter((id): id is string => typeof id === "string").slice(-APPROVED_PATCH_IDS_MAX);
  }
  if (s.reviewResume !== undefined) {
    const r = healRecord(s.reviewResume, (v) => {
      v.attempts = healNumber(v.attempts, 0);
      v.at = healNumber(v.at, 0);
    });
    // A marker without the two strings it keys on names no session to resume, so a malformed
    // one is dropped here rather than left to throw in sessionResumable.
    s.reviewResume =
      r && typeof r.patchId === "string" && typeof r.sessionDir === "string" ? r : undefined;
  }
  // The nested scheduling records carry the same numeric class — epoch-ms stamps, recovery
  // counts, and the fallback episode's clock — and are read by comparison or arithmetic
  // (`ctx.now - claim.at > CLAIM_IDLE_MAX_MS`, `prior.count + 1`, `cooldownMs * 2`), so a
  // foreign value there is healed the same way the top-level fields are.
  if (s.lastReview !== undefined)
    s.lastReview = healRecord(s.lastReview, (v) => {
      v.at = healNumber(v.at, 0);
      // The one nested non-numeric slot whose foreign type throws rather than reads odd: the
      // rejected-review notes build a numbered list from `reasons` (numberedList's `.map`), so
      // a hand-edited scalar or a missing field would crash the next run's prompt. Rebuild it
      // to its string entries — the same "the field is unusable, start it over" repair the
      // numeric fields get.
      v.reasons = Array.isArray(v.reasons)
        ? v.reasons.filter((r) => typeof r === "string")
        : [];
    });
  if (s.claim !== undefined)
    s.claim = healRecord(s.claim, (v) => {
      v.at = healNumber(v.at, 0);
    });
  if (s.revision !== undefined)
    s.revision = healRecord(s.revision, (v) => {
      v.round = healNumber(v.round, 0);
      v.at = healNumber(v.at, 0);
      // reasonCounts is a count array (the default of 0/[] for a corrupt or absent value keeps
      // a repeat from reading as a long-standing one) — rebuild it to non-negative numbers.
      v.reasonCounts = Array.isArray(v.reasonCounts)
        ? v.reasonCounts.map((c) => healNumber(c, 0))
        : undefined;
    });
  // A torn retry record reads as none: leftover recovery is the backstop for the pin.
  if (
    s.mainRedRetry !== undefined &&
    !(
      isJsonObject(s.mainRedRetry) &&
      typeof s.mainRedRetry.head === "string" &&
      isJsonObject(s.mainRedRetry.entry) &&
      typeof s.mainRedRetry.entry.role === "string" &&
      typeof s.mainRedRetry.entry.summary === "string" &&
      (s.mainRedRetry.waitingSince === undefined || typeof s.mainRedRetry.waitingSince === "number")
    )
  )
    s.mainRedRetry = undefined;
  if (s.mergeConflicts !== undefined)
    s.mergeConflicts = healRecord(s.mergeConflicts, (v) => {
      v.count = healNumber(v.count, 0);
    });
  if (s.conflictDiscard !== undefined)
    s.conflictDiscard = healRecord(s.conflictDiscard, (v) => {
      v.attempts = healNumber(v.attempts, 0);
      v.at = healNumber(v.at, 0);
    });
  if (s.conflictHandback !== undefined)
    s.conflictHandback = healRecord(s.conflictHandback, (v) => {
      v.at = healNumber(v.at, 0);
      healOptionalNumber(v, "round");
      if ((v.reason as string) === "landing") v.reason = "merge"; // vocabulary-ok: legacy state value read from old files
    });
  if (s.mergeCheckFailures !== undefined)
    s.mergeCheckFailures = healRecord(s.mergeCheckFailures, (v) => {
      v.count = healNumber(v.count, 0);
      if (typeof v.headline !== "string") delete v.headline;
    });
  if (s.mergeFlakeExcused !== undefined && typeof s.mergeFlakeExcused !== "string")
    delete s.mergeFlakeExcused;
  if (s.modelFallback !== undefined)
    s.modelFallback = healRecord(s.modelFallback, (v) => {
      v.failures = healNumber(v.failures, 0);
      v.since = healNumber(v.since, 0);
      v.probeAt = healNumber(v.probeAt, 0);
      v.cooldownMs = healNumber(v.cooldownMs, 0);
    });
  // The image-reroute marker is a one-shot nested record consumed by the next run; a torn
  // scalar is dropped (its consumers read/mutate fields), and the tier is repaired to a
  // known tier name so a corrupt tier cannot route a rerouted run to a phantom seam.
  if (s.imageReroute !== undefined) {
    const healed = healRecord(s.imageReroute, () => {});
    s.imageReroute =
      healed && (healed.tier === "small" || healed.tier === "default" || healed.tier === "strong")
        ? healed
        : undefined;
  }
  return s;
}

/** Per-role cache of the persisted live claim, keyed by the state file's stat — one stat per
 * role per call in steady state, a read only when the file changed (cachedByStat's contract),
 * so a team poll's allLiveClaims does no read I/O once every claim is known. */
const liveClaimCache = new Map<string, StatKeyedValue<{ role: string; key: string }>>();

/** Every runner id whose persisted claim must be considered — the built-in catalog roles
 * (allRoleIds) plus the parallel-work instance ids (feature-2, bugfix-3, …) that have a state
 * file. Instances are not in the built-in catalog, so they are enumerated from the state
 * directory rather than the config: a claim lives in its role's state file, and reading the
 * directory catches an instance's claim whether or not the config still lists its count (a
 * lowered or disabled instance that still holds a claim must not open its plan to another
 * base). Any state file whose id resolves away from itself under baseRoleOf is an instance
 * id; the named non-role files in that directory (orchestrator.json, claude-account.json, …)
 * resolve to themselves and so are skipped, as are the base roles allRoleIds already names. */
function liveClaimRunnerIds(root: string): string[] {
  const ids = new Set(allRoleIds());
  try {
    for (const name of readdirSync(path.join(root, STATE_DIR, "state"))) {
      const id = name.replace(/\.json$/, "");
      if (baseRoleOf(id) !== id) ids.add(id);
    }
  } catch {
    // no state directory yet — the catalog roles (fresh, claim-less) suffice
  }
  return [...ids];
}

/** The live backlog claim of every built-in role and running instance, keyed by claim
 * entryKey — `Map<key, role>` — for the ones that hold one. The cross-role in-flight hold
 * (BUGS.md 2026-10-09): a plan a `feature` instance claimed stays listed under PLANS.md
 * `## Planned` until its merge reaches main, so an eligibility reader built for another
 * role would otherwise see it as open and let that role implement it a second time — the
 * duplicate then fails review as a claim mismatch. Same-base claims are deliberately NOT
 * filtered here: callers (eligibleEntries) apply their own base rule, because the scheduling
 * pass and staged claims already hold same-base entries and the owner's own claim must stay
 * eligible for its release rules. A `feature-2` instance's claim is therefore read and keyed
 * under `feature-2`; callers fold it to its base. */
export function allLiveClaims(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of liveClaimRunnerIds(root)) {
    const file = statePath(root, id);
    const claim = cachedByStat(
      liveClaimCache,
      file,
      file,
      () => {
        const s = loadRunnerState(root, id);
        return s.claim ? { role: id, key: s.claim.key } : null;
      },
      (v) => ({ ...v }),
    );
    if (claim) out.set(claim.key, id);
  }
  return out;
}
