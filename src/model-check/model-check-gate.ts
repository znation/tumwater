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
  seamPairName,
  withModelOverrides,
  type ResolvedModelConfig,
} from "../config/config-views.js";
import { tierChainSteps } from "../config/config-fallbacks.js";
import type { RoleRunner } from "../runner/runner.js";
import { runnerEnabled } from "../roles/runner-ids.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { logEventBestEffort, warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { publishInfoFields, type ModelCheckInfo, type OrchestratorInfo } from "../team/team-orchestrator-info.js";
import { humanSeconds } from "../text/datetime.js";
import { errorMessage, joinWithMore, squash } from "../text/text.js";
import { REPLY_EXCERPT_CHARS, type ModelCheckVerdict } from "./model-check-probe.js";
import {
  MODEL_CHECK_POLICY,
  dueModelChecks,
  modelCheckFailed,
  modelCheckFault,
  modelCheckHolds,
  modelCheckVerified,
  recordModelCheck,
  rekeyModelChecks,
  startModelCheck,
  suspectModelCheck,
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
 * failed does not start on it), and the probes in flight. */
export class ModelCheckGate {
  checks: ModelCheckMap = {};
  held: ReadonlySet<string> = new Set();
  private uses = new Map<string, PairUse>();
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
  }

  /** One poll: re-key the map to the pairs in use, act on the runs waiting on an unanswered
   * model request (unansweredRuns), start every due probe, and return (and keep for the start
   * gate) the roles that wait — each runner whose next run's pair is not verified, and every
   * role but the director while the reviewer's pair is not (no change can merge without a
   * review, and the director's prompt outranks the wait as it outranks every autonomous gate).
   * Publishes the `modelChecks` block when it changed. */
  poll(input: ModelCheckPollInput): ReadonlySet<string> {
    const now = this.now();
    const runSeams = new Map<RoleRunner, ResolvedModelConfig>();
    for (const r of input.runners) if (runnerEnabled(r.config, r.role)) runSeams.set(r, r.runConfig());
    this.uses = pairsInUse(input, runSeams);
    this.checks = rekeyModelChecks(this.checks, [...this.uses.keys()], now);
    this.unansweredRuns(input.runners);
    if (!this.signal.aborted) for (const pair of dueModelChecks(this.checks, now)) this.launch(pair);
    const reviewPair = input.liveConfig.review.enabled ? seamPairName(reviewConfig(input.roleConfig)) : null;
    const reviewHolds = reviewPair !== null && modelCheckHolds(this.checks[reviewPair]);
    const held = new Set<string>();
    for (const [r, seam] of runSeams) {
      if (modelCheckHolds(this.checks[seamPairName(seam)]) || (reviewHolds && r.role !== DIRECTOR_ROLE)) held.add(r.role);
    }
    this.held = held;
    this.publish(input.info);
    return held;
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
        warnEventBestEffort(
          this.root,
          r.role,
          `run handed back: its model request to ${pair} is unanswered and the pair failed its model check — the run resumes on a pair that answers`,
        );
      }
    }
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

  /** Fold a probe's verdict in, logging the edges: one warning when a pair enters `failed`
   * (from checking or verified — a later failed re-check stays quiet, the published block and
   * the doctor row carry its latest reply), and one model_check_passed when a failed pair
   * answers again. A pair the team stopped using meanwhile is dropped, its verdict with it. */
  private settle(pair: string, verdict: ModelCheckVerdict): void {
    const prev = this.checks[pair];
    if (prev === undefined) return;
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

  private publish(info: OrchestratorInfo): void {
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
