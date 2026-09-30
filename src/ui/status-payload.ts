import path from "node:path";
import { openBugs, openQuestions, plannedPlans } from "../backlog.js";
import { readEvents, type HarnessEvent } from "../events.js";
import { eventMessage, formatEvent } from "../event-format.js";
import { dailyCost } from "../budget.js";
import { snapshot } from "./status.js";
import { buildBadge, budgetBadge, isActivePhase, landingBadge, loopRowCells, mainCheckBadge, yieldMultiplierFor } from "./status-model.js";
import { fleetAlerts } from "./fleet-alerts.js";

/** How many recent events the payload carries — enough for the dashboard's activity feed to
 * still show a screenful of notable events (landings, failures, questions) after it filters
 * out the routine ones (tick starts, wakes, passing checks). */
const RECENT_EVENTS = 80;

/** One event as the dashboard's activity feed consumes it. `result` is a tick's outcome, a
 * landing's result, or a build check's status — whichever string the event carries. */
function eventItem(e: HarnessEvent): { ts: number; loop: string; type: string; result?: string; message: string } {
  const result = typeof e.result === "string" ? e.result : typeof e.status === "string" ? e.status : undefined;
  return { ts: e.ts, loop: String(e.loop), type: e.type, ...(result === undefined ? {} : { result }), message: eventMessage(e) };
}

/** The one fleet-state document both observer surfaces carry: `GET /api/status` (gui.ts)
 * spreads it and adds the serving process's own `serverBuildSha` (the page's cue to notice a
 * newer build and reload), while `tumwater status --json` (cli.ts) prints it verbatim — every
 * other field is shared, so the dashboard and the CLI can never drift apart. Assembled here —
 * not in gui.ts — because it is shared data collection for observers, not part of serving HTTP:
 * snapshot() supplies the core state, and the per-loop phase/metrics fields come from the same
 * status-model helpers the TUI table uses. */
export function statusPayload(root: string): object {
  const snap = snapshot(root);
  // One event read feeds both feed shapes below, so `events[i]` and `eventItems[i]` always
  // describe the same event.
  const recent = readEvents(root, RECENT_EVENTS);
  const questions = openQuestions(root);
  const loops = snap.loops.map((s) => {
    // loopRowCells single-homes the per-loop tail read + metrics + phase derivation the
    // TUI table (status-render.ts's renderStatus) repeats, so the two dashboards cannot
    // drift apart.
    const { live, generated, peakCtx, phase } = loopRowCells(snap, root, s);
    return {
      role: s.role,
      // User-defined-loop marker (computed in snapshot — see StatusSnapshot.loops): the GUI
      // renders it as an asterisk beside the loop name.
      custom: s.custom,
      phase,
      // In-flight flag derived from the same rendered phase (isActivePhase's three
      // prefixes: working/reviewing/landing) — the GUI shows `abort` on a row only when
      // this is true, without re-deriving the prefixes client-side.
      inFlight: isActivePhase(phase),
      // What a working loop is doing right now (first assistant text of the in-flight run).
      // Null when idle — never show a stale item from a finished tick.
      currentWork: live?.currentWork ?? null,
      ticks: s.ticks,
      commits: s.commits,
      generated,
      peakCtx,
      costUsd: s.totalCostUsd,
      // The loop's spend for the local day (the daily budget window): 0 while its stamp
      // is stale or missing — same helper and semantics as the TUI's `today` column.
      todayUsd: dailyCost(s),
      lastResult: s.lastResult ?? null,
      lastSummary: s.lastSummary ?? null,
      // The last failure's text (a tick error, a failed landing's reason); the dashboard shows it
      // beside a problem result that carries no summary of its own.
      lastError: s.lastError ?? null,
      lastTickEndedAt: s.lastTickEndedAt ?? null,
      // The scheduling facts behind the `next run` column: raw epoch ms and seconds, formatted
      // client-side like lastTickEndedAt/costUsd — the GUI's fmtNextRun twin applies the same
      // rules nextRunCell does (see status-render.ts).
      nextRunAt: s.nextRunAt,
      backoffSeconds: s.backoffSeconds,
      // The yield multiplier behind the next-run cell's `×N` suffix (yield-scaled
      // clocks, PLANS.md): the payload carries the computed number, not the ring, so the
      // GUI's JS twin applies the same display rule without re-deriving the role sets.
      yieldMultiplier: yieldMultiplierFor(s),
    };
  });
  return {
    // The project directory's name — the dashboards' title (the TUI header's `tumwater · <name>`).
    project: path.basename(path.resolve(root)),
    running: snap.running,
    pid: snap.pid,
    // The running harness's build stamp and staleness (src/build-info.ts); null when no
    // harness runs or its dist carries no stamp — machine-readable for `status --json`.
    build: snap.build,
    // The header's build badge pre-formatted through status-model's buildBadge — the same
    // string the TUI/status table renders. Sent display-ready (like phase and events) because
    // the page is browser JS that cannot import TypeScript, and this multi-branch text must
    // not be re-derived client-side where it could drift from the TUI header.
    buildBadge: buildBadge(snap.build),
    // The header's daily-cost-budget badge preformatted through status-model's budgetBadge —
    // the same string the TUI/status table renders (n/a for an all-free fleet; `· no cap`
    // when disabled). Sent display-ready like buildBadge so the page cannot re-derive it.
    budgetBadge: budgetBadge(snap.budget),
    // The land queue (plans/merge-queue.md 4/5): depth always (machine-readable for
    // `status --json`; 0 when idle) plus the in-flight landing's identity only while one is
    // actually running. Raw data here, like budget — and the display-ready header badge
    // preformatted through status-model's landingBadge, so the page cannot re-derive it.
    landQueue: snap.landQueue,
    landingBadge: landingBadge(snap.landQueue),
    // Main's newest merge-scope check (PLANS.md "Retire the README freshness stamp"): the
    // raw block is machine-readable for `status --json`, and the header badge is
    // preformatted through status-model's mainCheckBadge — the same string the TUI/status
    // header renders — so the page cannot re-derive the verdict client-side. Omitted (not
    // null) before any merge-scope check has run — the same omit-undefined idiom as
    // pausedUntil.
    ...(snap.mainCheck ? { mainCheck: snap.mainCheck } : {}),
    mainCheckBadge: mainCheckBadge(snap.mainCheck),
    inbox: snap.inbox,
    // Previews of the queued director prompts in execution order (truncated server-side —
    // see StatusSnapshot.inboxPrompts); the page lists them in its project status panel.
    inboxPrompts: snap.inboxPrompts,
    // Queue-file addresses beside the previews (same order — see StatusSnapshot.inboxFiles):
    // the queued-prompts section's per-row cancel affordance POSTs one to /api/prompt-cancel.
    // Raw data, like inbox/inboxPrompts.
    inboxFiles: snap.inboxFiles,
    // Per-role queued-prompt counts (PLANS.md "Per-role prompts 2/2"): the loop table's
    // `p:N` state marker and the queued-prompts section's per-loop lines render from it.
    // Raw data, like inbox/inboxPrompts.
    roleInbox: snap.roleInbox,
    // Per-role queued prompts with their queue-file addresses (see
    // StatusSnapshot.roleInboxPrompts): the queued-prompts section renders each as its own
    // row with a cancel link, replacing the bare "r: N queued" count line. Raw data, like
    // inboxFiles.
    roleInboxPrompts: snap.roleInboxPrompts,
    // The raw daily-cost-budget data, unconditionally (capUsd 0 = disabled; spend still
    // reported) — machine-readable for `status --json`; the display-ready header badge is
    // the preformatted `budgetBadge`.
    budget: snap.budget,
    // Operator pause (`tumwater pause` marker present): every idle role loop's phase reads
    // `paused` ahead of budget/main-red — one flag covers both dashboards through loopPhase.
    paused: snap.paused,
    pausedRoles: snap.pausedRoles,
    // The fleet marker's standing timed-pause deadline (ms epoch), absent when the fleet is
    // not timed-paused (undefined drops from the JSON). Raw data, like paused/pausedRoles —
    // machine-readable for `status --json`; the planned GUI pause-badge countdown reads it
    // client-side (PLANS.md "Pause countdown").
    pausedUntil: snap.pausedUntil,
    loops,
    // The recent event feed as the one-line text `tumwater logs` prints…
    events: recent.map((e) => formatEvent(e)),
    // …and the same events as data for the dashboard's activity feed: when, which loop, what
    // kind (the event type plus its result or check status, which decide the row's tone), and
    // the message without formatEvent's time/loop columns — the page renders those itself.
    eventItems: recent.map(eventItem),
    // Project status (planned features + open bugs + open questions), fresh per poll like
    // events — loops edit these files constantly, so there is no cache to go stale. The page
    // derives the header badge count from this list's length.
    plans: plannedPlans(root),
    bugs: openBugs(root),
    questions,
    // What needs the operator (fleet-alerts.ts's fleetAlerts): the dashboard's alert banners and
    // the TUI's attention lines, phrased once.
    alerts: fleetAlerts(snap, questions, loops, Date.now()),
  };
}
