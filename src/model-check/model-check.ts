/** The model check's per-pair state (plans/model-check.md): one entry per provider/model pair
 * the team can run on, saying whether a probe (model-check-probe.ts) has shown the pair can
 * answer. Pure data with pure transitions, like the fallback breaker
 * (src/budget/fallback-breaker.ts) it sits beside: the orchestrator holds the map in memory
 * (model-check-gate.ts), so a restart checks every pair again. A pair is checked when it first
 * appears — startup, a config edit that routes a seam to it, a budget fallback engaging it — and
 * a failed pair is checked again on a doubling back-off until it answers, so the roles it holds
 * resume on their own. A verified pair is checked again only on suspicion (suspectModelCheck): a
 * run on it ended without changes and without declaring nothing-to-do, the shape a serving
 * fault takes. */

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

/** A run on a verified pair ended the way a serving fault ends: schedule a re-check now, unless
 * one is already due or in flight, or the pair was checked within the policy's suspectMinMs. The
 * pair stays verified (its roles keep running) until the re-check says otherwise. */
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

/** What a failed probe says about the pair, in words: the reply it got (quoted) or that none
 * came back (with the run's own error). Shared by the warning, the doctor row and the alert. */
export function modelCheckFault(c: { reason?: string; reply?: string; detail?: string }): string {
  if (c.reason === "wrong answer") return `replied "${c.reply ?? ""}" instead of the probe's one-word answer`;
  return `gave no reply${c.detail ? ` (${c.detail})` : ""}`;
}
