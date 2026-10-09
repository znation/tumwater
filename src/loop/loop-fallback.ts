import type { LoopState } from "./loop-state.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { ResolvedModelConfig } from "../config/config-views.js";
import { logEventBestEffort } from "../events/events.js";
import { modelFallbackVerdict, providerFailureReason, recordModelFallback } from "./model-fallback.js";
import type { FallbackRunContext } from "./loop-tick.js";

/** What the fallback fold needs from its `LoopRunner` host: the loop identity for the event,
 * the shared state it reads/writes, and the runner's save. */
interface FallbackContext {
  root: string;
  role: string;
  state: LoopState;
  save(): void;
}

/** Fold one AUTHORING run's verdict into the role's model-fallback state
 * (src/loop/model-fallback.ts) and emit the episode's started/ended events. Only the run
 * that actually happened is evidence: a tick that never invoked pi (a skipped director
 * inbox, a recovered leftover, a red-main block) returns from runTick before this is
 * reached, and modelFallbackVerdict reports an aborted/killed/timed-out run as
 * inconclusive — so neither can end an episode without the primary having answered.
 * A role whose tier resolves to no fallback pair never trips, and an episode persisted from a
 * config that HAD a pair is cleared when a live edit removes it (or sets it to "pause"), so a
 * stale "on fallback" mark cannot outlive the config that created it. Persists on any state
 * change; the tick's own finalize save carries it too. */
export function foldModelFallbackPhase(
  ctx: FallbackContext,
  fallbackCtx: FallbackRunContext,
  pi: PiRunResult,
): void {
  const s = ctx.state;
  const prior = s.modelFallback;
  const now = Date.now();
  const verdict = modelFallbackVerdict(pi);
  const reason = providerFailureReason(pi.transientRateLimit, pi.backendKind);
  const wasIn = prior !== undefined && prior.since > 0;
  if (fallbackCtx.fallback === null) {
    // No fallback pair resolves any more: the feature is off for this role. End a persisted
    // episode (the primary just ran, so this tick IS the return), and drop any pre-trip count
    // so a later config starts from zero. A killed/aborted/timed-out run is no verdict, so it
    // leaves the episode in place exactly as it does on a configured fallback.
    if (prior === undefined) return;
    if (wasIn && verdict === "inconclusive") return;
    emitFallbackEnded(ctx, prior, fallbackCtx.primary, now, wasIn);
    s.modelFallback = undefined;
    ctx.save();
    return;
  }
  const next = recordModelFallback(prior, { verdict, probe: fallbackCtx.probe, now, reason });
  const willBeIn = next !== undefined && next.since > 0;
  if (!wasIn && willBeIn) {
    logEventBestEffort(ctx.root, {
      loop: ctx.role,
      type: "model_fallback_started",
      provider: fallbackCtx.fallback.provider,
      model: fallbackCtx.fallback.model,
      reason: next?.reason,
    });
  } else if (wasIn && !willBeIn && prior !== undefined) {
    emitFallbackEnded(ctx, prior, fallbackCtx.primary, now, wasIn);
  }
  if (next !== prior) {
    s.modelFallback = next;
    ctx.save();
  }
}

/** Log the model_fallback_ended event for an episode that was active. Split out so the two
 * ending paths — a successful probe and a config that dropped the pair — name the primary
 * pair and duration the same way. A pre-trip state (no episode) has no ended event. */
function emitFallbackEnded(
  ctx: FallbackContext,
  prior: NonNullable<LoopState["modelFallback"]>,
  primary: ResolvedModelConfig,
  now: number,
  wasIn: boolean,
): void {
  if (!wasIn) return;
  logEventBestEffort(ctx.root, {
    loop: ctx.role,
    type: "model_fallback_ended",
    provider: primary.provider,
    model: primary.model,
    durationMs: now - (prior.since || now),
  });
}
