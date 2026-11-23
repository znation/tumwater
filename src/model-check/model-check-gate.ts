/** The model check's per-poll wiring (plans/model-check.md): which pairs the team can run on,
 * the probes that check them (model-check-probe.ts, launched in the background, never awaited
 * by the poll), the roles held while a pair is unchecked or failed, the warning and recovery
 * events, and the `modelChecks` block observers read from the info file. The state machine it
 * drives is model-check.ts. Held in memory by the orchestrator beside the gate family
 * (src/gates/gate-polls.ts) and polled after it, once the budget gate has assigned each
 * runner the config its next run uses. Each poll also acts on the runs in flight whose model
 * request has gone unanswered (RoleRunner.unansweredRunPair): their pair is re-checked, and
 * once it fails the run is handed back resumably. */

import type { ModelTier, TumwaterConfig } from "../config/config-schema.js";
import {
  pairOverrides,
  resolverConfig,
  reviewConfig,
  roleSeamTier,
  seamPairName,
  withModelOverrides,
  type ResolvedModelConfig,
} from "../config/config-views.js";
import { BORROW_ORDER, tierChainSteps } from "../config/config-fallbacks.js";
import type { RoleRunner } from "../runner/runner.js";
import { runnerEnabled } from "../roles/runner-ids.js";
import { logEventBestEffort, warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { publishInfoFields } from "../team/team-orchestrator-info.js";
import type { ModelCheckInfo, OrchestratorInfo } from "../team/team-orchestrator-info-types.js";
import { humanSeconds } from "../text/datetime.js";
import { errorMessage, joinWithMore, squash } from "../text/text.js";
import { REPLY_EXCERPT_CHARS, type ModelCheckVerdict } from "./model-check-probe.js";
import {
  MODEL_CHECK_POLICY,
  busyModelCheck,
  dueModelChecks,
  modelCheckFailed,
  modelCheckFault,
  modelCheckHolds,
  modelCheckVerified,
  persistableModelChecks,
  readModelCheckStore,
  recheckModelChecks,
  recordModelCheck,
  rekeyModelChecks,
  reopenModelChecks,
  startModelCheck,
  suspectModelCheck,
  writeModelCheckPairs,
  type ModelCheckMap,
  type ModelCheckPolicy,
} from "./model-check.js";

/** Probe one seam and judge its reply: runModelCheck in production, a fake in tests. */
export type ModelCheckProber = (seam: ResolvedModelConfig, signal: AbortSignal) => Promise<ModelCheckVerdict>;

/** One pair the team can run on: the seam a probe runs (the first seam seen on the pair) and
 * the labels of every seam on it, in the order they resolved. */
interface PairUse {
  seam: ResolvedModelConfig;
  seams: string[];
}

/** One poll's inputs: the runners (their configs already assigned by the budget gate), the
 * live config the chain steps come from, the config merges review under (the budget view),
 * the tiers the budget gate moved off a primary that failed this check, and the info file the
 * block is published in. */
interface ModelCheckPollInput {
  runners: readonly RoleRunner[];
  liveConfig: TumwaterConfig;
  roleConfig: TumwaterConfig;
  checkMoved?: ReadonlySet<ModelTier>;
  info: OrchestratorInfo;
}

/** Every pair the team can run on now, keyed by pair name: each enabled runner's next run
 * (its runConfig, which names the budget fallback during a cap episode), the reviewer and the
 * conflict resolver under the config merges use, every step of every tier's fallback chain
 * — so a fallback is checked before the cap engages it, and the doctor can say whether it
 * answers — and the own primary of each tier the budget gate moved for a failed check
 * (`primary:<tier>`): no runner names it any more, but it must stay checked, failed and on its
 * back-off, so the tier moves back once it answers instead of being forgotten and retried. */
function pairsInUse(input: ModelCheckPollInput, runSeams: ReadonlyMap<RoleRunner, ResolvedModelConfig>): Map<string, PairUse> {
  const { liveConfig, roleConfig } = input;
  const out = new Map<string, PairUse>();
  const add = (label: string, seam: ResolvedModelConfig): void => {
    const pair = seamPairName(seam);
    const use = out.get(pair);
    if (use === undefined) out.set(pair, { seam, seams: [label] });
    else if (!use.seams.includes(label)) use.seams.push(label);
  };
  for (const [r, seam] of runSeams) add(r.role, seam);
  if (liveConfig.review.enabled) add("review", reviewConfig(roleConfig));
  add("resolver", resolverConfig(roleConfig));
  for (const { tier, step, pair } of tierChainSteps(liveConfig)) {
    add(step === 0 ? `fallback:${tier}` : `fallback:${tier}#${step}`, withModelOverrides(liveConfig, tier, pairOverrides(pair)));
  }
  for (const tier of input.checkMoved ?? []) add(`primary:${tier}`, withModelOverrides(liveConfig, tier, {}));
  return out;
}

/** The model check's live state for one orchestrator run: the per-pair map, the roles the
 * latest poll held (read at permit time by the start gate, so a waiter parked before a pair
 * failed does not start on it), and the probes in flight. The map is seeded from the persisted
 * store (.tumwater/state/model-checks.json, model-check.ts readModelCheckStore) so a restart
 * keeps each pair's verdict and its earned back-off, and written back from `poll` whenever its
 * content changes. */
export class ModelCheckGate {
  checks: ModelCheckMap = {};
  held: ReadonlySet<string> = new Set();
  private uses = new Map<string, PairUse>();
  /** The runners the latest poll saw: `settle` reads their `lastAnsweredAt` to tell a pair whose
   * server is answering the team from one that answers nothing (busy model check 2/2). */
  private lastRunners: readonly RoleRunner[] = [];
  /** When each pair's in-flight probe started (epoch ms), set by `launch` and read by `settle`:
   * an answer at or after it means the server was serving the team while the probe waited. */
  private readonly probeStartedAt = new Map<string, number>();
  private reviewPair: string | null = null;
  /** The JSON body this gate last persisted (null until its first write): `poll` writes only
   * when what it would write differs from it, the same only-when-changed rule
   * publishInfoFields applies to the info block, so a steady poll leaves the file untouched. */
  private lastSavedJson: string | null = null;
  /** The store's own `savedAt` stamp as it now stands (null when nothing has been stamped):
   * published onto every info row so observers can tell a verdict read from disk at restart
   * from one probed in this process. */
  private savedAt: number | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly stop = new AbortController();
  private readonly signal: AbortSignal;

  constructor(
    private readonly root: string,
    private readonly prober: ModelCheckProber,
    signal: AbortSignal,
    private readonly policy: ModelCheckPolicy = MODEL_CHECK_POLICY,
    private readonly now: () => number = Date.now,
  ) {
    this.signal = AbortSignal.any([signal, this.stop.signal]);
    // Restart seeding: the persisted verdicts (and the back-off they earned) carry over, so a
    // failed pair stays held and keeps its doubling interval instead of starting the wait from
    // one retryMs again. A store with no usable stamp, or one older than the policy's
    // suspicion interval, is re-opened for probing — every entry gets `probeAt: now` — so a
    // verdict days old is re-tested rather than trusted (that is today's restart behaviour for
    // stale data; only a store written within the interval keeps its verdicts).
    const store = readModelCheckStore(root, policy);
    this.savedAt = store.savedAt;
    const stale = store.savedAt === null || now() - store.savedAt > policy.suspectMinMs;
    this.checks = stale ? reopenModelChecks(store.pairs, now()) : store.pairs;
  }

  /** One poll: re-key the map to the pairs in use, act on the runs waiting on an unanswered
   * model request (unansweredRuns), start every due probe, and return (and keep for the start
   * gate) the roles that wait — exactly the runners whose next run's pair is not verified
   * (no exemption: a role runs on its own pair, so a failed pair holds only the roles on it).
   * The reviewer's verdict parks the no-role post-merge review drain, not roles: review is
   * post-merge ("Every commit is verified on main"), so no role start, verify or landing waits
   * on it — the drain reads it through `reviewHeld()`. Publishes the `modelChecks` block when
   * it changed. */
  poll(input: ModelCheckPollInput): ReadonlySet<string> {
    const now = this.now();
    const runSeams = new Map<RoleRunner, ResolvedModelConfig>();
    for (const r of input.runners) if (runnerEnabled(r.config, r.role)) runSeams.set(r, r.runConfig());
    this.uses = pairsInUse(input, runSeams);
    this.lastRunners = input.runners;
    this.checks = rekeyModelChecks(this.checks, [...this.uses.keys()], now);
    this.unansweredRuns(input.runners);
    if (!this.signal.aborted) for (const pair of dueModelChecks(this.checks, now)) this.launch(pair);
    this.reviewPair = input.liveConfig.review.enabled ? seamPairName(reviewConfig(input.roleConfig)) : null;
    const held = new Set<string>();
    for (const [r, seam] of runSeams) {
      if (modelCheckHolds(this.checks[seamPairName(seam)])) held.add(r.role);
    }
    this.held = held;
    this.publish(input.info);
    this.persist();
    return held;
  }

  /** Whether the reviewer's pair has not answered its last check — the orchestrator ORs this
   * into the post-merge review drain's hold (with the reviewer's provider hold), so a failed
   * or still-checking reviewer pair parks only the drain, never a role start, verify or
   * landing (review runs after the merge; docs/how-it-works.md's review section). False while
   * review is off. */
  reviewHeld(): boolean {
    return this.reviewPair !== null && modelCheckHolds(this.checks[this.reviewPair]);
  }

  /** Whether the pair failed its last probe — the budget gate's chain steps past it. */
  failed(pair: string): boolean {
    return modelCheckFailed(this.checks, pair);
  }

  /** Whether the pair answered its last probe — the only step the budget gate moves a tier
   * whose primary failed onto. */
  verified(pair: string): boolean {
    return modelCheckVerified(this.checks, pair);
  }

  /** A run on `pair` gave evidence the pair may have stopped answering properly — it ended
   * without changes and without declaring nothing-to-do, it failed before any reply, or its
   * request is waiting unanswered: re-check the pair (rate-limited by the policy); the next
   * poll starts the probe. */
  suspect(pair: string): void {
    this.checks = suspectModelCheck(this.checks, pair, this.now(), this.policy);
  }

  /** An operator asked for the check to run now (the dashboard's `Re-check now` button part 1/2
   * of the re-check plan): clear every failed pair's back-off (its probeAt moves to now) so the
   * next poll probes it immediately, instead of waiting out the doubling back-off. It only
   * schedules — the next `poll()` is what starts the probes through `launch`, so a probe already
   * in flight is left alone, and a probe still `checking` (never reported) stays due at its own
   * time. The marker that triggered it is consumed by the orchestrator, not here. */
  recheckNow(): void {
    this.checks = recheckModelChecks(this.checks, this.now());
  }

  /** The runs in flight whose model request has waited toolCallStallSeconds unanswered: each
   * suspects its pair, every poll while it waits — suspectModelCheck's rate limit makes that
   * one probe per suspectMinMs, so a hang the probe does not reproduce is looked at again
   * while it lasts. Once the pair has failed, the run is handed back resumably (session and
   * worktree kept, resume cause "model-check"): it is producing nothing, and it holds a team
   * slot for as long as the backend keeps it waiting (2 h a run on 2026-10-29). It resumes on
   * whatever its tier runs on next: the verified step the tier moves to, or the same pair once
   * it answers again. A run whose requests are being answered is not handed back, even on a
   * pair that failed its probe: it finishes, as every in-flight run did before
   * (plans/model-check.md "In-flight runs"). */
  private unansweredRuns(runners: readonly RoleRunner[]): void {
    for (const r of runners) {
      const pair = r.unansweredRunPair();
      if (pair === null) continue;
      this.suspect(pair);
      if (this.failed(pair) && r.handBackRun("model-check")) {
        const resume = this.answersElsewhere(pair, roleSeamTier(r.config, r.role)) ? "a pair that answers" : "this pair once it answers again";
        warnEventBestEffort(
          this.root,
          r.role,
          `run handed back: its model request to ${pair} is unanswered and the pair failed its model check — the run resumes on ${resume}`,
        );
      }
    }
  }

  /** Whether a pair other than `pair` that `tier`'s check move can land on (a step of its own
   * chain or of a chain it borrows in BORROW_ORDER, or the primary a check move left) answered
   * its last probe: the only case in which a handed-back run has another pair to resume on —
   * the reviewer's pair, or a chain the tier never borrows, is not one. With none, the run
   * waits for `pair` itself. */
  private answersElsewhere(pair: string, tier: ModelTier): boolean {
    const onTier = (label: string): boolean =>
      label === `primary:${tier}` ||
      BORROW_ORDER[tier].some((t) => label === `fallback:${t}` || label.startsWith(`fallback:${t}#`));
    return [...this.uses].some(([other, use]) => other !== pair && use.seams.some(onTier) && this.verified(other));
  }

  /** Abort the probes in flight and wait for them to settle — the shutdown's last step, so no
   * probe outlives the generation that started it. */
  async close(): Promise<void> {
    this.stop.abort();
    await Promise.allSettled([...this.inFlight]);
  }

  /** Wait for the probes in flight (a test seam: the probe is otherwise fire-and-forget). */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  private launch(pair: string): void {
    const use = this.uses.get(pair);
    if (use === undefined) return;
    this.checks = startModelCheck(this.checks, pair);
    this.probeStartedAt.set(pair, this.now());
    const task = this.prober(use.seam, this.signal)
      .catch((err: unknown): ModelCheckVerdict => ({
        ok: false,
        reason: "no reply",
        reply: "",
        detail: squash(errorMessage(err), REPLY_EXCERPT_CHARS),
      }))
      .then((verdict) => this.settle(pair, verdict));
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  /** Whether a runner's own runs on `pair` were answered while its probe waited: the busy-vs-dead
   * signal part 1/2 put on the runner (`lastAnsweredAt`, recorded by the stream parser's answered
   * hook). `startedAt` is the probe's start, absent when the probe was never launched here. */
  private teamAnsweredSince(pair: string, startedAt: number | null): boolean {
    if (startedAt === null) return false;
    return this.lastRunners.some((r) => {
      const answered = r.lastAnsweredAt(pair);
      return answered !== null && answered >= startedAt;
    });
  }

  /** Fold a probe's verdict in, logging the edges: one warning when a pair enters `failed`
   * (from checking or verified — a later failed re-check stays quiet, the published block and
   * the doctor row carry its latest reply), and one model_check_passed when a failed pair
   * answers again. A pair the team stopped using meanwhile is dropped, its verdict with it.
   * A `no reply` probe that waited while the pair answered the team's own runs fails nothing
   * (busy model check 2/2): the server was queueing the probe, not dead, so `busyModelCheck`
   * defers it and one informational `model_check_busy` event says so instead of a warning. */
  private settle(pair: string, verdict: ModelCheckVerdict): void {
    const prev = this.checks[pair];
    if (prev === undefined) return;
    if (
      verdict.ok === false &&
      verdict.reason === "no reply" &&
      prev.status !== "failed" &&
      this.teamAnsweredSince(pair, this.probeStartedAt.get(pair) ?? null)
    ) {
      this.checks = busyModelCheck(this.checks, pair, this.now(), this.policy);
      logEventBestEffort(this.root, {
        source: TUMWATER_SOURCE,
        type: "model_check_busy",
        pair,
      });
      return;
    }
    this.checks = recordModelCheck(this.checks, pair, verdict, this.now(), this.policy);
    const seams = this.uses.get(pair)?.seams ?? [];
    if (verdict.ok === false && prev.status !== "failed") {
      const next = this.checks[pair]!;
      warnEventBestEffort(this.root, TUMWATER_SOURCE, modelCheckWarning(pair, verdict, seams, next.retryMs));
    } else if (verdict.ok === true && prev.status === "failed") {
      logEventBestEffort(this.root, {
        source: TUMWATER_SOURCE,
        type: "model_check_passed",
        pair,
        failures: prev.failures,
      });
    }
  }

  /** Write the map to the persisted store when its content differs from the last write
   * (probing entries excluded on both sides, so a probe in flight is not a change). Not from
   * `settle` alone: the busy deferral, `recheckNow()` and `suspect()` land in the same map and
   * are worth keeping, and the next poll writes them. Best-effort inside writeModelCheckPairs. */
  private persist(): void {
    const json = JSON.stringify(persistableModelChecks(this.checks));
    if (json === this.lastSavedJson) return;
    this.savedAt = this.now();
    writeModelCheckPairs(this.root, this.checks, this.savedAt);
    this.lastSavedJson = json;
  }

  private publish(info: OrchestratorInfo): void {
    const savedAt = this.savedAt;
    const list: ModelCheckInfo[] = Object.values(this.checks).map((e) => ({
      pair: e.pair,
      status: e.status,
      seams: this.uses.get(e.pair)?.seams ?? [],
      ...(e.failures > 0 ? { failures: e.failures } : {}),
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
      ...(e.reply !== undefined ? { reply: e.reply } : {}),
      ...(e.detail !== undefined ? { detail: e.detail } : {}),
      ...(e.status === "failed" && e.probeAt !== null ? { probeAt: e.probeAt } : {}),
      ...(e.checkedAt !== undefined ? { checkedAt: e.checkedAt } : {}),
      ...(savedAt !== null ? { savedAt } : {}),
    }));
    publishInfoFields(this.root, info, [["modelChecks", list.length > 0 ? list : undefined]]);
  }
}

/** The warning a pair entering `failed` logs: the pair, what came back, which seams wait, and
 * when it is checked again. */
function modelCheckWarning(
  pair: string,
  verdict: Extract<ModelCheckVerdict, { ok: false }>,
  seams: readonly string[],
  retryMs: number,
): string {
  const on = seams.length > 0 ? ` (${joinWithMore(seams, 6)})` : "";
  return `model check failed: ${pair} ${modelCheckFault(verdict)} — runs on it wait${on}; next check in ${humanSeconds(Math.round(retryMs / 1000))}`;
}
