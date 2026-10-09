import type { LoopState } from "../loop/loop-state.js";
import type { BuildStatus } from "../build/build-info.js";
import { openQuestions } from "../backlog/backlog.js";
import { isCustomRole } from "../config/config.js";
import { loopIds } from "../roles/loop-ids.js";
import {
  fallbackPair,
  modelFallbackView,
  modelSelectorField,
  resolveTierFallbacks,
  roleSeamTier,
  configForRole,
  tierFallbackLabels,
  tiersResolveDistinctPairs,
  type ModelFallbackView,
} from "../config/config-views.js";
import type { ModelTier } from "../config/config-schema.js";
import { isJsonObject } from "../files/json-object.js";
import { fallbackModelFree, fleetModelsFree, pairFree, piModelsPath, readPiProviders } from "../pi/pi-models.js";
import { configForStatus, liveLandingMarker, loopStateForPoll, mainCheckForPoll, type MainCheckStatus } from "./status-polls.js";
import { queuedRolePromptEntries } from "../inbox/inbox.js";
import { deliverableAt } from "../inbox/prompt-not-before.js";
import { quietHoursStatus, roleQuietHold } from "../scheduling/quiet-hours.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { pausedRoles, standingFleetPause } from "../fleet/fleet-state.js";
import {
  orchestratorAlive,
  readOrchestratorInfo,
  type DiskStatus,
} from "../fleet/orchestrator-info.js";
import { readLandingMarker, type LandingInFlight } from "../landing/landing-slot.js";
import { budgetReached, fleetDailyCost, modelPairName, projectCapHit } from "../budget/budget.js";
import { roleCapPaused } from "../gates/role-cap-gates.js";
import { queuedLandings } from "../landing/landing-queue.js";

/** Status data collection: one fresh snapshot of the fleet for observers (`tumwater
 * status`, TUI, GUI). Rendering lives in status-render.ts; the per-poll cached readers
 * snapshot() reads through (main-check scan, last-known-good config, loop-state stat cache)
 * live in status/status-polls.ts. */

export interface StatusSnapshot {
  running: boolean;
  pid?: number;
  inbox: number;
  /** Previews of those queued prompts in execution order, each via promptPreview (the shared
   * one-line preview width also used by the event previews) — full text would bloat the GUI
   * payload, and dashboards clip display width themselves. Fresh per poll like `questions`. */
  inboxPrompts: string[];
  /** The director queue's file basenames, same order as inboxPrompts — the address the
   * dashboard's per-row cancel affordance sends (/api/prompt-cancel cancels by queue file,
   * not by list position, so a 1 s-stale poll can never cancel the wrong entry). Same single
   * inbox pass as inboxPrompts (queuedRolePromptEntries), so the two arrays cannot drift. */
  inboxFiles: string[];
  /** The director queue's enqueue stamps (epoch ms parsed from each queue filename by
   * queueFileStamp — null for a hand-placed name), same order as inboxPrompts — the
   * established pairing pattern; the dashboard's Queued tab shows each prompt's age from it.
   * Same single inbox pass as inboxPrompts (queuedRolePromptEntries), so the arrays cannot
   * drift. */
  inboxQueuedAt: Array<number | null>;
  /** The director queue's not-before times (epoch ms parsed from each queue file's
   * `tumwater:not-before` marker line by notBeforeMs — null when absent or malformed), same
   * order as inboxPrompts — the established pairing pattern; the dashboard's Queued tab shows
   * each deferred prompt's delivery countdown from it. Same single inbox pass as inboxPrompts
   * (queuedRolePromptEntries), so the arrays cannot drift. */
  inboxNotBefore: Array<number | null>;
  /** Open questions awaiting a human answer (QUESTIONS.md's ## Open) — the header badge. */
  questions: number;
  /** One row per enabled loop. `custom` marks user-defined loops (tumwater.json's
   * customLoops) for the dashboards' asterisk — display-only metadata computed here at the
   * source, from the same last-known-good config that produced the role list, so a transiently
   * broken tumwater.json keeps marking its customs rather than flipping them unmarked
   * mid-poll. LoopState itself stays the persisted type; this intersection is view-layer only. */
  loops: Array<LoopState & {
    custom: boolean;
    /** The selector this loop's pi runs resolve at (`provider/id[:thinking]`, the
     * configForRole view) — present whenever a model resolves, both for a single string
     * `model` and under a tier map. The model seam tier (roleSeamTier) is a tier-map-only
     * affordance (model-tiers.md part 7a, "Observability"): it stays absent with a single
     * string model, where every role rides the same pair. Fresh per poll, like `custom`. */
    modelTier?: ModelTier;
    model?: string;
    /** While a model-fallback episode is active (PLANS.md "Model failure fallback"): the
     * tier-resolved fallback pair this loop's ticks run on, when the episode began, and the
     * provider-class failure that tripped it. Absent while the episode is not running the
     * fallback (no episode, or a due probe on the primary), so the common row shape is
     * unchanged. */
    fallback?: ModelFallbackView;
  }>;
  /** The daily cost budget, unconditionally (cap 0 = disabled — the display decides what to
   * show): today's fleet spend vs the cap, for the header badge on both dashboards (`· budget:
   * $X/$Y today` while enabled, `· no cap` when disabled) and the editable affordance that
   * needs a badge even on a disabled fleet. While the orchestrator runs, `spentUsd` is the
   * scheduler's OWN published figure (the gate's poll, over the runners' live in-memory
   * states — BUGS.md 2026-09-30): what an operator sees is what the scheduler enforces. Not
   * running, it is the persisted loop states' sum — a stopped fleet's files are final. The
   * per-loop rows always read their persisted copies, so while ticks are in flight the
   * per-loop cells can sit under the header/total figure: that difference is exactly the
   * charge the scheduler has already counted. `free` is true when every model the fleet could
   * use resolves to an unpriced or zero-cost entry in pi's models.json (src/pi/pi-models.ts):
   * spend can never accumulate against a cap that cannot be reached, so both dashboards read
   * `· budget: n/a` instead of a dollar figure. `fallback` is the cost-free model role loops
   * switch to once the cap is reached (plans/fallback-model.md) — non-null ONLY when one is
   * configured AND pi's definitions price it at zero, i.e. exactly when the gate would engage
   * it rather than pausing, so the dashboards' three-valued gate matches the scheduler's. */
  budget: {
    spentUsd: number;
    capUsd: number;
    /** When today's linear burn will reach the cap (epoch ms, the badge's `~cap at HH:MM`
     * forecast), or null when no forecast may be stated — no cap, no spend yet, the cap
     * already reached (the gate's own states supersede a forecast), or a burn that misses
     * midnight (budget.ts's projectCapHit, the one home of the rule). Computed once per poll
     * from the same materialized spend `spentUsd` renders, so every observer shows one
     * computed fact rather than three derivations. `status --json` and `/api/status` carry it
     * to scripts through the snapshot's own serialization. */
    capHitAt: number | null;
    free: boolean;
    fallback: { provider?: string; model?: string } | null;
    /** The per-tier fallback labels (part 7b/8): tier → `provider/model[ (from <tier>)]` —
     * non-null ONLY while the cap is reached and the tiers resolve to two or more distinct
     * pairs, the badge's tier-list state; a single fallback (the other tiers borrowing its
     * pair) leaves it undefined so the badge keeps today's single-pair text byte-identical.
     * Optional so literal budget blocks in the tests stand. The labels come from the same
     * resolution (resolveTierFallbacks over the published demotions) the per-role pause set
     * above reads, so the badge and the loop rows cannot disagree about which pair a tier
     * runs on. */
    tiers?: Partial<Record<string, string>> | null;
  };
  /** True while the operator has paused the fleet (`tumwater pause` marker present): every
   * idle role loop's state cell reads `paused`. Fresh per poll like `questions` — no cache,
   * because a 2-second-stale pause flag would mislead an operator mid-resume. */
  paused: boolean;
  /** The roles the operator has individually paused (`tumwater pause --role <id>` marker
   * set): an idle loop in this set also reads `paused`, the same cell as under the fleet
   * pause. Fresh per poll like `paused` — no cache, for the same mid-resume reason. */
  pausedRoles: string[];
  /** The roles the per-role daily cost cap holds (`maxDailyCostUsdPerRole`): an idle loop
   * in this set reads `cap paused`, its own spend state — more specific than the fleet's
   * `budget paused`. Computed with roleCapPaused against the caps of the same
   * last-known-good config that produced the loop list (a transiently broken tumwater.json
   * degrades with the whole config, like `quietHours`), so the verdict an operator sees is
   * the scheduler's — the fleet budget gate's rule. The director is exempt, exactly as the
   * gate exempts it (role-cap-gates.ts). Always present, empty when none — the `pausedRoles`
   * shape. Fresh per poll, like `pausedRoles`: a live `config set` edit shows on the next
   * poll, and local midnight lifts the hold by itself. */
  capPaused: string[];
  /** The roles whose budget tier resolved to pause while the cap is reached (part 5c/8): a
   * loop whose `model` tier (roleSeamTier) has no usable free pair — none configured, one
   * priced above zero, or its fallback breaker demoted — reads `budget paused`, the same cell
   * the fleet gate's old fleet-wide verdict filled. Computed with resolveTierFallbacks over
   * the SAME usable predicate the scheduler's gate folds (price at zero, and not among the
   * running orchestrator's published demotions), against the same last-known-good config as
   * `capPaused`, so the verdict an operator sees is the scheduler's — the per-tier pause set
   * (gate-polls.ts's budgetPausedRoles). The director is exempt, exactly as the gate exempts
   * it. Always present, empty when none — the `capPaused` shape. Fresh per poll, like
   * `capPaused`. */
  budgetPausedRoles: string[];
  /** The roles the per-role quiet-hours window holds (`quietHoursPerRole`): keyed by role
   * id to that role's window string as written (trimmed by quietHoursStatus's parser rule —
   * the schedule as written, not a reformat). An idle loop in this map reads the fleet
   * gate's own quiet wording, scoped to its window — `quiet until <end>`. Computed with
   * roleQuietHold against the same last-known-good config as `capPaused` (a transiently
   * broken tumwater.json degrades with the whole config), the director exempt exactly as
   * the scheduler's gate exempts it. Empty when no per-role window holds anyone — the
   * `capPaused` shape's keyed sibling. Fresh per poll, like `capPaused`: a live `config
   * set quietHoursPerRole` edit shows on the next poll. */
  roleQuietPaused: Record<string, string>;
  /** The fleet marker's standing deadline (ms epoch) while a timed pause
   * (`tumwater pause --for <duration>`) holds — undefined for an indefinite fleet pause, a
   * role-only pause, or an expired `until` (fleet-state's read side already treats expiry as
   * unpaused, so the field cannot outlive the pause it describes). Fleet-scoped: only the
   * fleet marker's deadline may be claimed by a header badge, since only it covers the whole
   * fleet. JSON.stringify drops the undefined field, so `status --json` carries it only while
   * a timed fleet pause stands. Fresh per poll, like `paused`. */
  pausedUntil?: number;
  /** The standing fleet pause's operator reason (`tumwater pause --reason <text>`), absent
   * for a reasonless pause, a role-only pause, or no pause at all — read from the same
   * standing marker read as `paused`/`pausedUntil`, so a reason is never advertised after
   * the pause it describes has lifted or been replaced (last write wins). JSON.stringify
   * drops the undefined field. Fresh per poll, like `paused`. */
  pauseReason?: string;
  /** The configured quiet-hours window as written (trimmed — "Quiet hours … part 2/2,
   * observability"), present only while the config's `quietHours` parses to a real window:
   * absent when unset or empty (off), because a schedule the gate is not holding must never
   * be advertised as one it is. A malformed value degrades with the whole config
   * (configForStatus's last-known-good hold, or the defaults when none exists) — the badge
   * never flashes off on one broken write. Standing information — the header badge shows it
   * in every configured state, like the budget badge's cap figure. Fresh per poll like
   * `paused`: a live `config set quietHours` edit shows on the next poll, the same
   * fresh-read rule the gate itself follows. */
  quietHours?: string;
  /** True while the LOCAL wall clock sits inside that window: idle role loops start no new
   * ticks (the director keeps steering). Decided by quiet-hours.ts's inQuietHours — the
   * scheduler's own predicate — so the dashboards and the hold cannot disagree. Fresh per
   * poll, like `quietHours`. */
  inQuietHours: boolean;
  /** The running harness's build (src/build/build-info.ts) as the orchestrator published it: the stamp
   * plus whether main's build inputs have moved past it. Null when no harness is running or its
   * dist carries no stamp. Both dashboards render it in the header — a stale build is the one
   * fact about the fleet that nothing inside the fleet can otherwise see. */
  build: BuildStatus | null;
  /** Prompts queued per loop (`tumwater prompt --role <id>`, PLANS.md "Per-role prompts 2/2"),
   * keyed by role id for every enabled loop except the director — the director's queue IS the
   * shared `inbox` above, so counting it here too would double-report the same prompts. Every
   * enabled loop appears (0 included) so `status --json` consumers see one stable shape, like
   * `landQueue`; the dashboards render a `p:N` marker and the GUI's per-row prompt affordance
   * from it. Counts only — full previews stay in each queue file, readable via
   * `tumwater prompt --list --role <id>`. Fresh per poll (a directory listing per role, no
   * content reads — the stat-keyed prompt cache), like `inbox`/`inboxPrompts`. */
  roleInbox: Record<string, number>;
  /** Each non-director role's queued prompts with the queue-file basename that addresses
   * them (the /api/prompt-cancel target), execution order — the dashboard renders one cancel
   * row per prompt instead of a bare count. Roles with an empty queue are absent (unlike
   * roleInbox, which lists every role with 0): there is no row to render. Same read pass as
   * the previews (queuedRolePromptEntries, stat-keyed like the director's — each entry also
   * carries its enqueue stamp, queuedAtMs, for the Queued tab's age); filled only when
   * the count above is nonzero, so the common empty case costs one listing per role. */
  roleInboxPrompts: Record<string, Array<{ file: string; preview: string; queuedAtMs: number | null; notBeforeMs: number | null }>>;
  /** The durable land queue (plans/merge-queue.md 4/5), unconditionally (depth 0 when
   * empty) so `status --json` consumers see one stable shape: the number of committed-but-
   * unlanded changes in the landing pipeline, and — only while a landing is actually
   * running — which ones. `inFlight` requires three things to agree: the 4/5 marker
   * exists, a queue entry with its sha still exists (entries are dropped only AFTER an
   * outcome — 3/5 — so in-flight always implies depth ≥ 1), and the orchestrator is alive.
   * The cross-check makes every crash ordering self-healing: a stale marker without a
   * matching entry never displays. The check is liveLandingMarker's: an older-generation
   * single-change marker displays only while its sha is queued; one with per-change records
   * keeps just the records whose entry is still queued and displays while one is not yet
   * `done`. */
  landQueue: {
    depth: number;
    /** Each queued change in execution order (oldest first) for `status --json` readers —
     * position, role, summary, sha, age. Filled from the same
     * `queuedLandings` pass the depth already costs (shallow per-entry copies without the
     * optional `body`/`highFriction`), only when `depth > 0`, absent when empty — the same
     * filling discipline `roleInboxPrompts` follows: there is nothing to render, so the
     * common empty case carries no field. */
    entries?: Array<{ role: string; sha: string; tick: number; summary: string; enqueuedAt: number }>;
    inFlight?: LandingInFlight;
  };
  /** Main's newest merge-scope build check (PLANS.md "Retire the README freshness stamp"):
   * the latest `build_check` event at the `landing`/`batch`/`baseline` scope, read from the
   * event tail — the live replacement for the committed README stamp the readme role used to
   * maintain. `sha` is the main commit the check verified: a `landed` event after the check
   * names it via its `commit` field (a landing/batch check runs pre-merge; the landing's own
   * `landed` commit is the head it produced), otherwise main's current tip (a baseline check
   * runs ON the tip, and a later landing would have logged a newer check). Unresolvable from
   * either source — no landing yet and no readable ref — drops the field. Absent entirely
   * before any merge-scope check has run (and in tests that assemble snapshots by hand). */
  mainCheck?: MainCheckStatus;
  /** The disk floor's measured state (plans/disk-floor.md, part 4/4), read from the running
   * orchestrator's published info file: free space (one decimal), the configured floor and
   * reclaim threshold, whether the hold is on, and the last reclaim pass. Absent when no
   * orchestrator runs, its build predates the field, or statfs could not measure the volume —
   * every surface then renders exactly as before. */
  disk?: DiskStatus;
}

/** One fresh fleet snapshot for observers. `modelsPath` overrides pi's model definitions
 * location (default ~/.pi/agent/models.json) — a test seam, like doctor's pathEnv. `now` pins
 * the poll's clock for the budget figures (the persisted day-stamp check and the burn-rate
 * projection) — one instant for the whole block, and the seam that keeps a test's expected
 * projection from racing the snapshot's own `Date.now()`; production callers take the default
 * and read the live clock, as always. */
export function snapshot(root: string, modelsPath = piModelsPath(), now = Date.now()): StatusSnapshot {
  const cfg = configForStatus(root);
  // One row per loop id (part 5b/7): an instance role shows `feature` and `feature-2`.
  const roles = loopIds(cfg);
  // One read of the orchestrator info file per poll: it serves both the displayed pid and the
  // liveness check (passing it to orchestratorAlive skips its own re-read).
  const info = readOrchestratorInfo(root);
  const loops = roles.map((r) => {
    const base = { ...loopStateForPoll(root, r), custom: isCustomRole(cfg, r) };
    // Every row carries the selector its config resolves to, so the dashboards show which
    // model a role rides even with a single string `model`. A tier-name `roles.<id>.model`
    // and a role selector override both resolve through configForRole — the same view the
    // seam consumes. Part 7a (model-tiers.md "Observability"): the seam tier tag is added
    // only with a tier map declared, where it names the tier a role rides.
    const eff = configForRole(cfg, r);
    // Model failure fallback, part 2/2: while the role's episode is active its ticks run on
    // the tier-resolved fallback pair, so the row names that pair, the episode's start, and
    // the failure that tripped it. `now` is the poll's own clock (the snapshot seam), so
    // every row agrees on what "active" means.
    const episode = modelFallbackView(base.modelFallback, cfg, r, now);
    return {
      ...base,
      ...modelSelectorField(eff),
      ...(isJsonObject(cfg.model) ? { modelTier: roleSeamTier(cfg, r) } : {}),
      ...(episode !== null ? { fallback: episode } : {}),
    };
  });
  // One inbox pass per poll serves all four director fields (queuedRolePromptEntries lists
  // the directory and reads each file once): the count is the entries' length, so a prompt
  // enqueued or dequeued mid-snapshot can never make the header badge disagree with its
  // numbered previews, and each preview keeps its queue-file address beside it.
  const queued = queuedRolePromptEntries(root, DIRECTOR_ROLE);
  const inboxPrompts = queued.map((e) => e.preview);
  const inboxFiles = queued.map((e) => e.file);
  const inboxQueuedAt = queued.map((e) => e.queuedAtMs);
  const inboxNotBefore = queued.map((e) => e.notBeforeMs);
  // One directory listing pass per role per poll (below) fills the per-role counts; the
  // director is excluded because its queue is the shared inbox above.
  // A role with prompts queued also fills its cancel-addressable entries — the
  // stat-keyed prompt cache keeps an unchanged file at one stat per poll. Entries follow the
  // full list, deferred prompts included (the Queued tab lists and cancels them; only the
  // deliverable count above excludes them).
  const roleInbox: Record<string, number> = {};
  const roleInboxPrompts: StatusSnapshot["roleInboxPrompts"] = {};
  // One listing pass per role serves both the deliverable count and the cancel-addressable
  // entries: queuedRolePromptRecords already carries each readable prompt's notBeforeMs, and
  // deliverableAt is exactly `notBeforeMs === null || notBeforeMs <= now` (prompt-not-before.ts)
  // over the same cached text — so the old second pass (queuedRolePromptCount's own readdir +
  // deliverability filter, once per role per poll across all 12 non-director loops) repeated
  // work the entries pass had just done. One clock read outside the loop pins the count and the
  // entries to the same instant.
  const nowMs = Date.now();
  for (const r of roles) {
    if (r === DIRECTOR_ROLE) continue;
    const entries = queuedRolePromptEntries(root, r);
    roleInbox[r] = entries.filter((e) => deliverableAt(e.notBeforeMs, nowMs)).length;
    if (entries.length) roleInboxPrompts[r] = entries;
  }
  const running = orchestratorAlive(root, info);
  // One fleet-pause-marker read per poll serves both the paused flag and its deadline:
  // isFleetPaused + pausedUntil would each re-read the same marker file every second.
  const fleetPause = standingFleetPause(root);
  // One land-queue pass per poll (landing-queue.ts's stat cache keeps an unchanged queue at one
  // stat per file) serves the depth; inFlight is the 4/5 marker only when a live orchestrator
  // still has a queue entry for what the marker names (per change, for a batch) — the
  // cross-check makes every crash ordering self-healing (a stale marker alone never displays,
  // and needs no cleanup pass).
  const landings = queuedLandings(root);
  const landingMarker = readLandingMarker(root);
  const landQueue: StatusSnapshot["landQueue"] = { depth: landings.length };
  if (landings.length > 0) {
    landQueue.entries = landings.map((e) => ({
      role: e.role,
      sha: e.sha,
      tick: e.tick,
      summary: e.summary,
      enqueuedAt: e.enqueuedAt,
    }));
  }
  const inFlight =
    running && landingMarker ? liveLandingMarker(landingMarker, new Set(landings.map((e) => e.sha))) : undefined;
  if (inFlight) landQueue.inFlight = inFlight;
  // The running orchestrator's published gate figures (read once above, with the pid and the
  // demotion): the scheduler's own sum over its live runner states. Only while running — the
  // exit removes the info file, so a stale file beside a dead pid must not speak for a fleet
  // whose persisted files are final.
  const publishedSpend = running && info?.budget ? info.budget.spentUsd : null;
  // The one materialized spend the budget block renders and the burn-rate projection both
  // read — the scheduler's published figure while running, the persisted states' sum otherwise.
  const spentUsd = publishedSpend ?? fleetDailyCost(loops, now);
  // Quiet hours 2/2 — one parse and one clock read per poll serve both the window string the
  // header badge renders and the in-window boolean the active reading turns on; the value is
  // read fresh from the same cached config load the budget block uses, so a live edit shows
  // on the next poll exactly when the gate applies it.
  const quiet = quietHoursStatus(cfg.quietHours, new Date());
  // The per-tier budget pause set (part 5c/8): the same resolution the scheduler's gate folds,
  // over the SAME usable predicate an observer can re-derive — the price check, and the pair
  // not among the running orchestrator's published per-pair demotions (a demotion lives in
  // the orchestrator's memory, so it publishes them; the legacy single-pair field
  // `fallbackDemoted` is the engaged pair's entry of the same map). Computed only while the
  // cap is reached — the hold never stands under an open gate — and the director exempt.
  const budgetReachedNow = budgetReached({ spentUsd, capUsd: cfg.maxDailyCostUsd });
  const providers = readPiProviders(modelsPath);
  const publishedDemotions = info?.fallbackDemotions ?? {};
  const usable = (p: { provider?: string; model?: string }) =>
    pairFree(providers, p.provider, p.model) && !(modelPairName(p) in publishedDemotions);
  const servingResolved = resolveTierFallbacks(cfg, usable);
  const budgetPausedRoles = budgetReachedNow
    ? roles.filter(
        (r) => r !== DIRECTOR_ROLE && servingResolved[roleSeamTier(cfg, r)].pair === null,
      )
    : [];
  return {
    running,
    pid: info?.pid,
    build: running && info?.build ? info.build : null,
    inbox: inboxPrompts.length,
    inboxPrompts,
    inboxFiles,
    inboxQueuedAt,
    inboxNotBefore,
    roleInbox,
    roleInboxPrompts,
    questions: openQuestions(root).length,
    loops,
    // Unconditional (never null): a disabled fleet still shows its spend and the badge is
    // the affordance for SETTING a cap. models.json itself is stat-cached inside pi-models.ts,
    // so an unchanged catalog costs one stat per poll, not a re-read plus parse.
    budget: {
      spentUsd,
      capUsd: cfg.maxDailyCostUsd,
      // One projection per poll, from the same spend the field above renders: null exactly
      // when no forecast may be stated (no cap, no spend, cap reached, burn misses midnight).
      capHitAt: projectCapHit({ spentUsd, capUsd: cfg.maxDailyCostUsd }, now),
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
      tiers:
        budgetReachedNow && tiersResolveDistinctPairs(servingResolved)
          ? tierFallbackLabels(servingResolved)
          : null,
    },
    paused: fleetPause !== null,
    pausedRoles: pausedRoles(root),
    capPaused: loops
      .filter((l) => l.role !== DIRECTOR_ROLE && roleCapPaused(l, cfg.maxDailyCostUsdPerRole?.[l.role]))
      .map((l) => l.role),
    budgetPausedRoles,
    // The per-role quiet windows' held roles (PLANS.md quietHoursPerRole): keyed role →
    // window, so the dashboards can render the same `quiet until <end>` wording the fleet
    // badge uses, scoped to the loop's own schedule. The window string comes back out of
    // the same config the hold was decided from, so the label cannot name a window that is
    // not holding (roleQuietHold true implies a parseable, non-empty string there).
    roleQuietPaused: Object.fromEntries(
      loops
        .filter((l) => l.role !== DIRECTOR_ROLE && roleQuietHold(cfg.quietHoursPerRole, l.role, new Date()))
        .map((l) => [l.role, cfg.quietHoursPerRole?.[l.role] ?? ""]),
    ),
    pausedUntil: fleetPause?.until,
    pauseReason: fleetPause?.reason,
    quietHours: quiet.window ?? undefined,
    inQuietHours: quiet.inWindow,
    landQueue,
    mainCheck: mainCheckForPoll(root, cfg),
    // The disk floor's published state (plans/disk-floor.md, part 4/4): only while the
    // orchestrator runs — the exit removes the info file, so a stale file beside a dead pid
    // must not speak for a stopped fleet — and only when the last poll could measure the
    // volume. Absent otherwise, so the surfaces render exactly as before.
    disk: running && info?.disk ? info.disk : undefined,
  };
}
