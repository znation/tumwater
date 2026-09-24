import type { TumwaterConfig } from "../config-schema.js";
import type { LoopState } from "../types.js";
import type { BuildStatus } from "../build-info.js";
import { openQuestions } from "../backlog.js";
import { defaultConfig, enabledRoleIds, fallbackPair, isCustomRole, loadConfigCached } from "../config.js";
import { fallbackModelFree, fleetModelsFree, piModelsPath } from "../pi-models.js";
import { cachedByStat, type StatKeyedValue } from "../stat-cache.js";
import { promptPreview, queuedPrompts } from "../inbox.js";
import { statePath } from "../paths.js";
import { freshLoopState, loadLoopState } from "../state.js";
import { isFleetPaused, orchestratorAlive, readOrchestratorInfo } from "../fleet-state.js";
import { readLandingMarker, type LandingInFlight } from "../landing-slot.js";
import { fleetDailyCost } from "../budget.js";
import { queuedLandings } from "../land-queue.js";

/** Status data collection: one fresh snapshot of the fleet for observers (`tumwater
 * status`, TUI, GUI). Rendering lives in status-render.ts. */

export interface StatusSnapshot {
  running: boolean;
  pid?: number;
  inbox: number;
  /** Previews of those queued prompts in execution order, each via promptPreview (the shared
   * one-line preview width also used by the event previews) — full text would bloat the GUI
   * payload, and dashboards clip display width themselves. Fresh per poll like `questions`. */
  inboxPrompts: string[];
  /** Open questions awaiting a human answer (QUESTIONS.md's ## Open) — the header badge. */
  questions: number;
  /** One row per enabled loop. `custom` marks user-defined loops (tumwater.json's
   * customLoops) for the dashboards' asterisk — display-only metadata computed here at the
   * source, from the same last-known-good config that produced the role list, so a transiently
   * broken tumwater.json keeps marking its customs rather than flipping them unmarked
   * mid-poll. LoopState itself stays the persisted type; this intersection is view-layer only. */
  loops: Array<LoopState & { custom: boolean }>;
  /** The daily cost budget, unconditionally (cap 0 = disabled — the display decides what to
   * show): today's fleet spend vs the cap, for the header badge on both dashboards (`· budget:
   * $X/$Y today` while enabled, `· no cap` when disabled) and the editable affordance that
   * needs a badge even on a disabled fleet. Spend lags in-flight ticks by up to one tick
   * boundary — exactly like the cost column. `free` is true when every model the fleet could
   * use resolves to an unpriced or zero-cost entry in pi's models.json (src/pi-models.ts):
   * spend can never accumulate against a cap that cannot be reached, so both dashboards read
   * `· budget: n/a` instead of a dollar figure. `fallback` is the cost-free model role loops
   * switch to once the cap is reached (plans/fallback-model.md) — non-null ONLY when one is
   * configured AND pi's definitions price it at zero, i.e. exactly when the gate would engage
   * it rather than pausing, so the dashboards' three-valued gate matches the scheduler's. */
  budget: {
    spentUsd: number;
    capUsd: number;
    free: boolean;
    fallback: { provider?: string; model?: string } | null;
  };
  /** True while the operator has paused the fleet (`tumwater pause` marker present): every
   * idle role loop's state cell reads `paused`. Fresh per poll like `questions` — no cache,
   * because a 2-second-stale pause flag would mislead an operator mid-resume. */
  paused: boolean;
  /** The running harness's build (src/build-info.ts) as the orchestrator published it: the stamp
   * plus whether main's build inputs have moved past it. Null when no harness is running or its
   * dist carries no stamp. Both dashboards render it in the header — a stale build is the one
   * fact about the fleet that nothing inside the fleet can otherwise see. */
  build: BuildStatus | null;
  /** The durable land queue (plans/merge-queue.md 4/5), unconditionally (depth 0 when
   * empty) so `status --json` consumers see one stable shape: the number of committed-but-
   * unlanded changes in the landing pipeline, and — only while a landing is actually
   * running — which ones. `inFlight` requires three things to agree: the 4/5 marker
   * exists, a queue entry with its sha still exists (entries are dropped only AFTER an
   * outcome — 3/5 — so in-flight always implies depth ≥ 1), and the orchestrator is alive.
   * The cross-check makes every crash ordering self-healing: a stale marker without a
   * matching entry never displays. The marker is checked per change (liveLandingMarker):
   * only its records whose entry is still queued are kept, and it displays while one of them
   * is not yet `done`. */
  landQueue: { depth: number; inFlight?: LandingInFlight };
}

/** The 4/5 cross-check against the queue: the marker as observers may display it, or
 * undefined when nothing it names is still in flight. An older generation's single-change
 * marker displays only while its sha is still queued; a marker with per-change records keeps
 * just its records whose sha is still queued — a change whose entry was dropped is finished,
 * whatever its record last said — and displays only while one of those is not `done`. */
function liveLandingMarker(marker: LandingInFlight, queued: ReadonlySet<string>): LandingInFlight | undefined {
  if (!marker.changes) return queued.has(marker.sha) ? marker : undefined;
  const changes = marker.changes.filter((c) => queued.has(c.sha));
  return changes.some((c) => c.status !== "done") ? { ...marker, changes } : undefined;
}

// The last config each root loaded successfully. snapshot is polled every second by the
// TUI and GUI, where a throw would kill (or blind) the observer — but tumwater.json can be
// transiently broken while a user edits it live-reload style. On failure we keep showing
// the fleet with the last known-good role set; the orchestrator does the same in its own
// reload poll and surfaces the error as a warning event visible in `tumwater logs`.
const lastGoodConfig = new Map<string, TumwaterConfig>();

/** The config to display loop state against: fresh when valid, otherwise the last
 * known-good one (or defaults if this process never saw a valid file). Never throws.
 * Freshness is stat-keyed (config.loadConfigCached): an unedited tumwater.json costs one
 * stat per poll instead of a read + parse + validate. */
function configForStatus(root: string): TumwaterConfig {
  const { config } = loadConfigCached(root);
  if (config) {
    lastGoodConfig.set(root, config);
    return config;
  }
  return lastGoodConfig.get(root) ?? defaultConfig();
}

// Per-poll loop-state cache (stat-cache.cachedByStat): the TUI and GUI poll snapshot every second,
// but a role's state file changes only at its tick boundaries (start/end) — between ticks it
// sits unchanged for minutes. Serve an unchanged file from the stat-keyed cache: one stat
// syscall per file per poll instead of re-reading and re-parsing JSON that hasn't moved.
// Keyed by state-file path so distinct roots never collide; capped inside cachedByStat so many
// short-lived roots in tests cannot grow it unbounded.
const loopStateCache = new Map<string, StatKeyedValue<LoopState>>();

/** This poll's view of one role's state: fresh when the file changed since this process last
 * read it, cached otherwise (see above). Returns a copy so each snapshot owns its data —
 * mutating one poll's LoopState must not poison later polls. A missing state file yields a
 * fresh state, as loadLoopState does for an unreadable one. */
function loopStateForPoll(root: string, role: string): LoopState {
  const file = statePath(root, role);
  return (
    cachedByStat(
      loopStateCache,
      file,
      file,
      () => loadLoopState(root, role),
      (state) => ({ ...state }), // A copy: callers may treat the result as their own.
    ) ?? freshLoopState(role)
  );
}

/** One fresh fleet snapshot for observers. `modelsPath` overrides pi's model definitions
 * location (default ~/.pi/agent/models.json) — a test seam, like doctor's pathEnv. */
export function snapshot(root: string, modelsPath = piModelsPath()): StatusSnapshot {
  const cfg = configForStatus(root);
  const roles = enabledRoleIds(cfg);
  // One read of the orchestrator info file per poll: it serves both the displayed pid and the
  // liveness check (passing it to orchestratorAlive skips its own re-read).
  const info = readOrchestratorInfo(root);
  const loops = roles.map((r) => ({ ...loopStateForPoll(root, r), custom: isCustomRole(cfg, r) }));
  // One inbox pass per poll serves both fields (queuedPrompts lists the directory and reads
  // each file once): the count is the prompts' length, so a prompt enqueued or dequeued
  // mid-snapshot can never make the header badge disagree with its numbered previews.
  const inboxPrompts = queuedPrompts(root).map(promptPreview);
  const running = orchestratorAlive(root, info);
  // One land-queue pass per poll (land-queue.ts's stat cache keeps an unchanged queue at one
  // stat per file) serves the depth; inFlight is the 4/5 marker only when a live orchestrator
  // still has a queue entry for what the marker names (per change, for a batch) — the
  // cross-check makes every crash ordering self-healing (a stale marker alone never displays,
  // and needs no cleanup pass).
  const landings = queuedLandings(root);
  const landingMarker = readLandingMarker(root);
  const landQueue: StatusSnapshot["landQueue"] = { depth: landings.length };
  const inFlight =
    running && landingMarker ? liveLandingMarker(landingMarker, new Set(landings.map((e) => e.sha))) : undefined;
  if (inFlight) landQueue.inFlight = inFlight;
  return {
    running,
    pid: info?.pid,
    build: running && info?.build ? info.build : null,
    inbox: inboxPrompts.length,
    inboxPrompts,
    questions: openQuestions(root).length,
    loops,
    // Unconditional (never null): a disabled fleet still shows its spend and the badge is
    // the affordance for SETTING a cap. models.json itself is stat-cached inside pi-models.ts,
    // so an unchanged catalog costs one stat per poll, not a re-read plus parse.
    budget: {
      spentUsd: fleetDailyCost(loops),
      capUsd: cfg.maxDailyCostUsd,
      free: fleetModelsFree(cfg, modelsPath),
      // Null unless the gate could actually engage it (configured AND priced at zero AND not
      // demoted by the running orchestrator's breaker): a fallback the scheduler would refuse
      // must not be advertised as one that will save the fleet — and a demoted one is refused
      // until its probe serves, so the dashboards read `budget paused` exactly while the
      // scheduler is (BUGS.md 2026-09-20). Same stat-cached read of models.json as `free` above.
      fallback:
        fallbackModelFree(cfg, modelsPath) && !(running && info?.fallbackDemoted)
          ? (fallbackPair(cfg) ?? null)
          : null,
    },
    paused: isFleetPaused(root),
    landQueue,
  };
}
