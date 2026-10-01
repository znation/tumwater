import type { TumwaterConfig } from "./config-schema.js";
import type { LoopState } from "./loop-state.js";
import type { BuildStatus } from "./build-info.js";
import { openQuestions } from "./backlog.js";
import { defaultConfig, enabledRoleIds, isCustomRole, loadConfigCached } from "./config.js";
import { fallbackPair } from "./config-views.js";
import { fallbackModelFree, fleetModelsFree, piModelsPath } from "./pi-models.js";
import { cachedByStat, type StatKeyedValue } from "./stat-cache.js";
import { queuedRolePromptCount, queuedRolePromptEntries } from "./inbox.js";
import { quietHoursStatus } from "./quiet-hours.js";
import { readEvents } from "./event-read.js";
import { currentBranchFromHeadFile, readBranchHead, targetBranch } from "./git.js";
import { statePath } from "./paths.js";
import { DIRECTOR_ROLE } from "./roles.js";
import { freshLoopState, loadLoopState } from "./loop-state.js";
import {
  orchestratorAlive,
  pausedRoles,
  readOrchestratorInfo,
  standingFleetPause,
} from "./fleet-state.js";
import { readLandingMarker, type LandingInFlight } from "./landing-slot.js";
import type { TestCounts } from "./build-check.js";
import { fleetDailyCost } from "./budget.js";
import { queuedLandings } from "./landing-queue.js";

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
  /** The director queue's file basenames, same order as inboxPrompts — the address the
   * dashboard's per-row cancel affordance sends (/api/prompt-cancel cancels by queue file,
   * not by list position, so a 1 s-stale poll can never cancel the wrong entry). Same single
   * inbox pass as inboxPrompts (queuedRolePromptEntries), so the two arrays cannot drift. */
  inboxFiles: string[];
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
   * needs a badge even on a disabled fleet. While the orchestrator runs, `spentUsd` is the
   * scheduler's OWN published figure (the gate's poll, over the runners' live in-memory
   * states — BUGS.md 2026-09-30): what an operator sees is what the scheduler enforces. Not
   * running, it is the persisted loop states' sum — a stopped fleet's files are final. The
   * per-loop rows always read their persisted copies, so while ticks are in flight the
   * per-loop cells can sit under the header/total figure: that difference is exactly the
   * charge the scheduler has already counted. `free` is true when every model the fleet could
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
  /** The roles the operator has individually paused (`tumwater pause --role <id>` marker
   * set): an idle loop in this set also reads `paused`, the same cell as under the fleet
   * pause. Fresh per poll like `paused` — no cache, for the same mid-resume reason. */
  pausedRoles: string[];
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
  /** The running harness's build (src/build-info.ts) as the orchestrator published it: the stamp
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
   * content reads — see queuedRolePromptCount), like `inbox`/`inboxPrompts`. */
  roleInbox: Record<string, number>;
  /** Each non-director role's queued prompts with the queue-file basename that addresses
   * them (the /api/prompt-cancel target), execution order — the dashboard renders one cancel
   * row per prompt instead of a bare count. Roles with an empty queue are absent (unlike
   * roleInbox, which lists every role with 0): there is no row to render. Same read pass as
   * the previews (queuedRolePromptEntries, stat-keyed like the director's); filled only when
   * the count above is nonzero, so the common empty case costs one listing per role. */
  roleInboxPrompts: Record<string, Array<{ file: string; preview: string }>>;
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
  landQueue: {
    depth: number;
    /** Each queued change in execution order (oldest first): what the GUI's land-queue
     * drawer lists — position, role, summary, short sha, age. Filled from the same
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
  mainCheck?: {
    sha?: string;
    status: "passed" | "failed" | "skipped";
    counts?: TestCounts;
    at: number;
  };
}

/** A runner summary block as the build_check event carries it (build-check-events.ts spreads
 * the outcome's counts through): parseTestCounts's exported TestCounts, single-homed in
 * build-check.ts beside its parser. Structurally checked on read (asCounts): the event log is
 * loose-typed. */

function asCounts(v: unknown): TestCounts | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const c = v as Record<string, unknown>;
  return typeof c.tests === "number" && typeof c.pass === "number" && typeof c.fail === "number" && typeof c.skipped === "number"
    ? { tests: c.tests, pass: c.pass, fail: c.fail, skipped: c.skipped }
    : undefined;
}

/** How far mainCheckForPoll may grow its event tail. The per-poll default (readEvents' 200)
 * covers a healthy fleet — a merge-scope check rides every landing and every redeploy — but a
 * burst of quiet or failing ticks logs hundreds of events without moving main, and a tail
 * that ends before the last check makes the header badge vanish and reappear as ticks tick
 * by. Growing until the check is found keeps "absent" meaning what the field's contract says
 * (no merge-scope check has run) rather than "the window ended"; the cap keeps the worst
 * per-poll scan bounded — readTailText reads bytes proportional to the line count, and this
 * runs every poll, so it stays below history's one-ask bound (HISTORY_SCAN_MAX_EVENTS, 20k).
 * Past the cap the badge drops, the same graceful loss log rotation already imposes. */
const MAIN_CHECK_SCAN_MAX_EVENTS = 5_000;

/** Per-root note that the previous poll had to grow past the default 200-event tail without
 * finding a merge-scope check. A check rides every landing, so a poll that grew all the way to
 * the cap is a burst of quiet or failing ticks — hundreds of events between landings — and the
 * next poll's growth starts straight at the cap instead of re-scanning the ×4 ladder's
 * intermediate windows (200→800→3200→5000 ≈ 9.2k re-parsed events per fresh tail, vs 5.2k for
 * 200→cap; measured on a 6k-event check-free log, ~2.3 ms → ~1.2 ms per append+poll). A poll
 * that finds a check clears the note, so the ordinary find-in-200 / find-in-800 path pays the
 * same small windows as before. In-memory only: a wrong guess costs the ladder it skipped, never
 * a wrong verdict — every window's scan is complete for its size. */
const mainCheckGrewFull = new Set<string>();
const MAIN_CHECK_FULL_SET_MAX = 64;

/** The newest merge-scope build_check in the event tail, with the main sha it verified
 * (mainCheck's derivation — see the field's comment). A gate-scope check is excluded: it
 * verified a role worktree, not main. The tail grows until a merge-scope check is inside it
 * (see MAIN_CHECK_SCAN_MAX_EVENTS): a check older than the default tail must still badge the
 * header, and every event after the check — the landed pairing the sha needs — is newer, so
 * one window holds the whole derivation. */
function mainCheckForPoll(root: string, cfg: TumwaterConfig): StatusSnapshot["mainCheck"] {
  let check: ReturnType<typeof readEvents>[number] | undefined;
  let events: ReturnType<typeof readEvents> = [];
  const grewFull = mainCheckGrewFull.has(root);
  for (let window = 200; ; window = grewFull ? MAIN_CHECK_SCAN_MAX_EVENTS : Math.min(window * 4, MAIN_CHECK_SCAN_MAX_EVENTS)) {
    events = readEvents(root, window);
    for (const e of events) {
      if (e.type === "build_check" && (e.scope === "landing" || e.scope === "batch" || e.scope === "baseline")) {
        check = e;
      }
    }
    // Found, the log is shorter than the window (nothing older exists to find), or the cap
    // is reached: the tail is final. A stale `check` from a previous, smaller window cannot
    // happen — each iteration rescans from scratch, and a later window's scan sees every
    // event the smaller one did.
    if (check || events.length < window || window >= MAIN_CHECK_SCAN_MAX_EVENTS) break;
  }
  if (mainCheckGrewFull.size >= MAIN_CHECK_FULL_SET_MAX) mainCheckGrewFull.clear();
  if (check) mainCheckGrewFull.delete(root);
  else mainCheckGrewFull.add(root);
  if (!check || typeof check.ts !== "number" || typeof check.status !== "string") return undefined;
  let landedAfter: (typeof events)[number] | undefined;
  let landedBefore: (typeof events)[number] | undefined;
  for (const e of events) {
    if (e.type !== "landed" || typeof e.ts !== "number") continue;
    if (e.ts > check.ts) landedAfter = e;
    else landedBefore = e;
  }
  const branch = targetBranch(cfg.baseBranch, currentBranchFromHeadFile(root));
  const sha =
    (typeof landedAfter?.commit === "string" ? landedAfter.commit : undefined) ??
    readBranchHead(root, branch) ??
    (typeof landedBefore?.commit === "string" ? landedBefore.commit : undefined);
  const counts = asCounts(check.counts);
  return {
    ...(sha ? { sha } : {}),
    status: check.status as "passed" | "failed" | "skipped",
    ...(counts ? { counts } : {}),
    at: check.ts,
  };
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
  // One inbox pass per poll serves all three director fields (queuedRolePromptEntries lists
  // the directory and reads each file once): the count is the entries' length, so a prompt
  // enqueued or dequeued mid-snapshot can never make the header badge disagree with its
  // numbered previews, and each preview keeps its queue-file address beside it.
  const queued = queuedRolePromptEntries(root, DIRECTOR_ROLE);
  const inboxPrompts = queued.map((e) => e.preview);
  const inboxFiles = queued.map((e) => e.file);
  // One directory listing per role per poll (no content reads — queuedRolePromptCount) fills
  // the per-role counts; the director is excluded because its queue is the shared inbox above.
  // A role with prompts queued gets one read pass for its cancel-addressable entries — the
  // stat-keyed prompt cache keeps an unchanged file at one stat per poll.
  const roleInbox: Record<string, number> = {};
  const roleInboxPrompts: StatusSnapshot["roleInboxPrompts"] = {};
  for (const r of roles) {
    if (r === DIRECTOR_ROLE) continue;
    roleInbox[r] = queuedRolePromptCount(root, r);
    if (roleInbox[r] > 0) {
      const entries = queuedRolePromptEntries(root, r);
      if (entries.length) roleInboxPrompts[r] = entries;
    }
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
  // Quiet hours 2/2 — one parse and one clock read per poll serve both the window string the
  // header badge renders and the in-window boolean the active reading turns on; the value is
  // read fresh from the same cached config load the budget block uses, so a live edit shows
  // on the next poll exactly when the gate applies it.
  const quiet = quietHoursStatus(cfg.quietHours, new Date());
  return {
    running,
    pid: info?.pid,
    build: running && info?.build ? info.build : null,
    inbox: inboxPrompts.length,
    inboxPrompts,
    inboxFiles,
    roleInbox,
    roleInboxPrompts,
    questions: openQuestions(root).length,
    loops,
    // Unconditional (never null): a disabled fleet still shows its spend and the badge is
    // the affordance for SETTING a cap. models.json itself is stat-cached inside pi-models.ts,
    // so an unchanged catalog costs one stat per poll, not a re-read plus parse.
    budget: {
      spentUsd: publishedSpend ?? fleetDailyCost(loops),
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
    paused: fleetPause !== null,
    pausedRoles: pausedRoles(root),
    pausedUntil: fleetPause?.until,
    pauseReason: fleetPause?.reason,
    quietHours: quiet.window ?? undefined,
    inQuietHours: quiet.inWindow,
    landQueue,
    mainCheck: mainCheckForPoll(root, cfg),
  };
}
