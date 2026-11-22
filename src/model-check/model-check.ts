/** The model check's per-pair state (plans/model-check.md): one entry per provider/model pair
 * the team can run on, saying whether a probe (model-check-probe.ts) has shown the pair can
 * answer. Pure data with pure transitions, like the fallback breaker
 * (src/budget/fallback-breaker.ts) it sits beside: the orchestrator holds the map in memory
 * (model-check-gate.ts), so a restart checks every pair again. A pair is checked when it first
 * appears — startup, a config edit that routes a seam to it, a budget fallback engaging it — and
 * a failed pair is checked again on a doubling back-off until it answers, so the roles it holds
 * resume on their own. A verified pair is checked again only on suspicion (suspectModelCheck): a
 * run on it ended without changes and without declaring nothing-to-do, failed before its model
 * replied, or is waiting on a request left unanswered — the shapes a serving fault takes. */

import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { finiteNumber, isJsonObject } from "../files/json-object.js";
import { modelChecksPath } from "../paths.js";
import type { ModelCheckVerdict } from "./model-check-probe.js";

/** `checking` until the first probe of the pair answers; `verified` once one did; `failed`
 * after a probe got no reply or the wrong one. Only `verified` lets the pair's roles run. */
type ModelCheckStatus = "checking" | "verified" | "failed";

interface ModelCheckEntry {
  pair: string;
  status: ModelCheckStatus;
  /** Consecutive failed probes; 0 once one answers. */
  failures: number;
  /** Epoch ms from which the next probe may start; null when none is scheduled (verified). */
  probeAt: number | null;
  /** The back-off that set probeAt (0 while verified); each failed probe doubles it. */
  retryMs: number;
  /** A probe is in flight: no second one starts until it reports. */
  probing: boolean;
  /** When the last probe reported (epoch ms). */
  checkedAt?: number;
  /** The last failed probe's verdict: why, the reply's excerpt ("" when none came back), and
   * the run's own error when it had one. Cleared when a probe answers. */
  reason?: "no reply" | "wrong answer";
  reply?: string;
  detail?: string;
}

/** Every checked pair, keyed by its pair name (config-views.ts seamPairName). */
export type ModelCheckMap = Record<string, ModelCheckEntry>;

/** The store `.tumwater/state/model-checks.json` holds (src/paths.ts modelChecksPath): one
 * entry per checked pair in exactly the shape the transitions above produce — no new verdict
 * model — plus the time it was written, so a restart can tell a verdict it just wrote from one
 * days old. `savedAt` is null when the file carried no usable stamp, which the gate reads as
 * "older than the suspicion interval": its verdicts are not trusted. Internal to this file:
 * the gate reads `pairs` and `savedAt` off the value `readModelCheckStore` returns. */
interface ModelCheckStore {
  pairs: ModelCheckMap;
  savedAt: number | null;
}

/** How the check retries. A test seam (the orchestrator's RunOptions accepts an override);
 * production uses MODEL_CHECK_POLICY. */
export interface ModelCheckPolicy {
  /** The first wait before a failed pair is probed again. */
  retryMs: number;
  /** The cap each failed probe's doubling stops at. */
  maxRetryMs: number;
  /** The least time between two suspicion re-checks of a verified pair. */
  suspectMinMs: number;
}

/** A minute first: a local server restarting or a provider's brief outage answers again
 * within it. Doubling to at most 30 minutes keeps a pair that stays broken overnight to a
 * couple of probes an hour, and bounds how long an operator who fixed the server waits for the
 * team to notice (editing the pair re-checks it at once). Suspicion re-checks at most every ten
 * minutes: a model that sometimes forgets the sentinel costs one short probe, not one per run. */
export const MODEL_CHECK_POLICY: ModelCheckPolicy = {
  retryMs: 60_000,
  maxRetryMs: 30 * 60_000,
  suspectMinMs: 10 * 60_000,
};

/** This poll's map for the pairs the team can run on now: a pair already checked keeps its
 * entry, a new one starts `checking` with a probe due at once, and a pair no seam resolves to
 * any more is dropped, so it is checked afresh if it comes back. */
export function rekeyModelChecks(map: ModelCheckMap, pairs: readonly string[], now: number): ModelCheckMap {
  const next: ModelCheckMap = {};
  for (const pair of pairs) {
    next[pair] = map[pair] ?? { pair, status: "checking", failures: 0, probeAt: now, retryMs: 0, probing: false };
  }
  return next;
}

/** The pairs whose probe is due now, in map order. */
export function dueModelChecks(map: ModelCheckMap, now: number): string[] {
  return Object.values(map)
    .filter((e) => !e.probing && e.probeAt !== null && now >= e.probeAt)
    .map((e) => e.pair);
}

/** Apply `f` to the pair's entry when the map holds one, else return the map unchanged: a pair
 * the poll dropped has nothing to update. */
function withEntry(map: ModelCheckMap, pair: string, f: (e: ModelCheckEntry) => ModelCheckEntry): ModelCheckMap {
  const e = map[pair];
  return e === undefined ? map : { ...map, [pair]: f(e) };
}

/** The map once the pair's probe has started: probing until recordModelCheck hears back. */
export function startModelCheck(map: ModelCheckMap, pair: string): ModelCheckMap {
  return withEntry(map, pair, (e) => ({ ...e, probing: true }));
}

/** Fold one probe's verdict into the pair's entry. An answer verifies the pair and clears the
 * failure; a failure re-schedules the probe after the back-off — the policy's first wait, then
 * doubled per failure up to its cap; no evidence (an aborted probe) only frees the probe slot. */
export function recordModelCheck(
  map: ModelCheckMap,
  pair: string,
  verdict: ModelCheckVerdict,
  now: number,
  policy: ModelCheckPolicy = MODEL_CHECK_POLICY,
): ModelCheckMap {
  return withEntry(map, pair, (e) => {
    if (verdict.ok === null) return { ...e, probing: false };
    if (verdict.ok) return { pair, status: "verified", failures: 0, probeAt: null, retryMs: 0, probing: false, checkedAt: now };
    const retryMs = e.retryMs === 0 ? policy.retryMs : Math.min(e.retryMs * 2, policy.maxRetryMs);
    return {
      pair,
      status: "failed",
      failures: e.failures + 1,
      probeAt: now + retryMs,
      retryMs,
      probing: false,
      checkedAt: now,
      reason: verdict.reason,
      reply: verdict.reply,
      ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
    };
  });
}

/** Fold a `no reply` probe verdict in WITHOUT failing the pair, because the team's own runs on
 * that pair were answered while the probe waited: a server that answers the team and leaves the
 * probe silent is queueing the probe, not dead (BUGS.md busy model check 2/2). A verified pair
 * stays verified with the probe slot cleared and `checkedAt: now`, so `suspectModelCheck`'s
 * `suspectMinMs` rate limit is what spaces the next suspicion probe — the deferred probe does
 * not re-fire every poll. A `checking` pair stays checking with its next probe due
 * `policy.retryMs` later and its `failures` and `retryMs` untouched: a deferred verdict is not
 * a failed probe, so it neither starts nor grows a back-off. Every other entry — a failed pair,
 * which keeps its own doubled back-off — is returned as it was. */
export function busyModelCheck(
  map: ModelCheckMap,
  pair: string,
  now: number,
  policy: ModelCheckPolicy = MODEL_CHECK_POLICY,
): ModelCheckMap {
  return withEntry(map, pair, (e) => {
    if (e.status === "verified") return { ...e, status: "verified", probeAt: null, probing: false, checkedAt: now };
    if (e.status === "checking") return { ...e, probeAt: now + policy.retryMs, probing: false };
    return e;
  });
}

/** A run on a verified pair ended, or is waiting, the way a serving fault does: schedule a
 * re-check now, unless one is already due or in flight, or the pair was checked within the
 * policy's suspectMinMs. The pair stays verified (its roles keep running) until the re-check
 * says otherwise. */
export function suspectModelCheck(
  map: ModelCheckMap,
  pair: string,
  now: number,
  policy: ModelCheckPolicy = MODEL_CHECK_POLICY,
): ModelCheckMap {
  return withEntry(map, pair, (e) =>
    e.status === "verified" && !e.probing && e.probeAt === null && now - (e.checkedAt ?? 0) >= policy.suspectMinMs
      ? { ...e, probeAt: now }
      : e,
  );
}

/** The map once an operator has asked for the check to run now (the dashboard's `Re-check
 * now`, part 1/2 of the re-check plan): every failed pair whose probe is not already in
 * flight probes again on the next poll (probeAt set to `now`), and every other entry — a
 * verified pair, a checking pair, a failed pair whose probe is in flight — is returned
 * byte-for-byte as it was. `failures` and `retryMs` are left untouched, so if the forced
 * probe fails again the next automatic wait continues the existing back-off (the doubling
 * keeps going) rather than restarting it from the first wait. */
export function recheckModelChecks(map: ModelCheckMap, now: number): ModelCheckMap {
  const next: ModelCheckMap = {};
  for (const [pair, e] of Object.entries(map)) {
    next[pair] = e.status === "failed" && !e.probing ? { ...e, probeAt: now } : e;
  }
  return next;
}

/** The map once every pair is re-opened for probing (a restart that found a stale store): each
 * entry keeps its status and counts but its probe is due at once and no probe is in flight, so
 * the first poll probes every pair instead of trusting a verdict days old. Distinct from
 * `recheckModelChecks`, which moves only `failed` entries and leaves a `verified` one with
 * `probeAt: null` — that would trust a stale verdict forever. */
export function reopenModelChecks(map: ModelCheckMap, now: number): ModelCheckMap {
  const next: ModelCheckMap = {};
  for (const [pair, e] of Object.entries(map)) next[pair] = { ...e, probing: false, probeAt: now };
  return next;
}

/** The entries the store keeps: every pair except one whose probe is in flight — that probe
 * dies with the process, so a restart must not find the pair mid-probe forever (no probe ever
 * reports and `dueModelChecks` skips a probing entry). Shared by the writer and the gate's
 * only-when-changed check so the compared string is the file's content. */
export function persistableModelChecks(map: ModelCheckMap): ModelCheckMap {
  const next: ModelCheckMap = {};
  for (const [pair, e] of Object.entries(map)) if (!e.probing) next[pair] = e;
  return next;
}

/** One persisted entry, or undefined for any foreign shape — the same hand-editable boundary
 * every other state file's reader enforces: a non-object and a `probing` entry (dropped by
 * `persistableModelChecks`, so one on disk means a hand edit or an older build, and a restart
 * must not leave the pair looking mid-probe forever) are dropped rather than trusted. Every
 * number is forced finite, so a hand-edited `retryMs: "x"` or `failures: null` cannot poison
 * the back-off comparisons. An unknown `status` reads as `failed` rather than being dropped or
 * guessed as `verified`: the roles stay held either way, and `failed` keeps a back-off instead
 * of letting the pair be probed every poll. For the same reason a `failed` entry's `retryMs` is
 * floored at the policy's first wait (a corrupt 0 cannot make the check spam a provider) and a
 * missing `probeAt` reads as overdue (0) — every pair but a verified one always has a probe
 * scheduled, so a store that lost it is re-probed at once, never held forever. A `verified`
 * entry keeps its null `probeAt`: nothing is scheduled, and suspicion is what re-probes it. The
 * entry's `pair` is always the record key: a hand-edited entry naming another pair would publish
 * a row the poll's rekey cannot match. */
function parseModelCheckEntry(pair: string, v: unknown, policy: ModelCheckPolicy): ModelCheckEntry | undefined {
  if (!isJsonObject(v) || v.probing === true) return undefined;
  const verified = v.status === "verified";
  const failed = v.status !== "checking" && !verified;
  const probeAt = finiteNumber(v.probeAt, verified ? null : 0);
  const retryMs = finiteNumber(v.retryMs, 0);
  const checkedAt = finiteNumber(v.checkedAt, undefined);
  const rawFailures = finiteNumber(v.failures, 0);
  const reason = v.reason === "no reply" || v.reason === "wrong answer" ? v.reason : undefined;
  const reply = typeof v.reply === "string" ? v.reply : undefined;
  const detail = typeof v.detail === "string" ? v.detail : undefined;
  return {
    pair,
    status: v.status === "checking" ? "checking" : v.status === "verified" ? "verified" : "failed",
    failures: rawFailures >= 0 ? rawFailures : 0,
    probeAt,
    retryMs: failed ? Math.max(retryMs, policy.retryMs) : retryMs,
    probing: false,
    ...(checkedAt !== undefined ? { checkedAt } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(reply !== undefined ? { reply } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

/** The persisted verdict store (.tumwater/state/model-checks.json), read and normalized: no
 * file, a torn file and a non-object body all read as an empty store, and a missing or foreign
 * `savedAt` as null ("not fresh" — the gate re-probes what it cannot date). The gate's restart
 * path: verdicts and the back-off they earned survive a restart instead of every pair starting
 * `checking` again (plans/model-check.md follow-ups). */
export function readModelCheckStore(root: string, policy: ModelCheckPolicy = MODEL_CHECK_POLICY): ModelCheckStore {
  const rec = readJsonFile<{ pairs?: unknown; savedAt?: unknown }>(modelChecksPath(root));
  const pairs: ModelCheckMap = {};
  if (rec !== null && isJsonObject(rec.pairs)) {
    for (const [pair, v] of Object.entries(rec.pairs)) {
      const e = parseModelCheckEntry(pair, v, policy);
      if (e !== undefined) pairs[pair] = e;
    }
  }
  return { pairs, savedAt: rec === null ? null : finiteNumber(rec.savedAt, null) };
}

/** The persisted verdicts alone, as a map (the store's `savedAt` is the gate's business). */
export function readModelCheckPairs(root: string, policy: ModelCheckPolicy = MODEL_CHECK_POLICY): ModelCheckMap {
  return readModelCheckStore(root, policy).pairs;
}

/** Persist the verdicts, best-effort like the poll heartbeat (`stampHeartbeat`): a read-only
 * working tree or a full disk must never break the check. Entries whose probe is in flight are
 * dropped (`persistableModelChecks`) and `savedAt` is stamped here, so a restart can tell a
 * verdict written now from one a previous process wrote and re-probe what it cannot date. */
export function writeModelCheckPairs(root: string, map: ModelCheckMap, savedAt: number = Date.now()): void {
  try {
    writeJsonAtomic(modelChecksPath(root), { pairs: persistableModelChecks(map), savedAt });
  } catch {
    // Best-effort: the in-memory map stays the live source for this process.
  }
}
/** Whether the pair's roles wait: everything but a verified pair holds them. A pair with no
 * entry holds nothing (the check is off, or the pair was never in use). */
export function modelCheckHolds(e: ModelCheckEntry | undefined): boolean {
  return e !== undefined && e.status !== "verified";
}

/** Whether the pair failed its last probe — the one state the budget gate's chain steps past
 * (a `checking` pair stays a candidate so it can be checked). */
export function modelCheckFailed(map: ModelCheckMap, pair: string): boolean {
  return map[pair]?.status === "failed";
}

/** Whether the pair answered its last probe — the one state a tier whose primary failed may be
 * moved onto (budget-fallback-view.ts). */
export function modelCheckVerified(map: ModelCheckMap, pair: string): boolean {
  return map[pair]?.status === "verified";
}

/** What a failed probe says about the pair, in words: the reply it got (quoted) or that none
 * came back (with the run's own error). Shared by the warning, the doctor row and the alert. */
export function modelCheckFault(c: { reason?: string; reply?: string; detail?: string }): string {
  if (c.reason === "wrong answer") return `replied "${c.reply ?? ""}" instead of the probe's one-word answer`;
  return `gave no reply${c.detail ? ` (${c.detail})` : ""}`;
}
