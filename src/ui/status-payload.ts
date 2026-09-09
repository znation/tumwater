import { openBugs, openQuestions, plannedPlans } from "../backlog.js";
import { readEvents } from "../events.js";
import { formatEvent } from "./event-format.js";
import { readLiveProgress } from "./progress.js";
import { budgetReached, dailyCost } from "../state.js";
import { snapshot } from "./status.js";
import { buildBadge, displayTokenMetrics, loopPhase } from "./status-render.js";

/** The one fleet-state document both observer surfaces serve: `GET /api/status` (gui.ts) and
 * `tumwater status --json` (cli.ts) print the same payload, so the dashboard and the CLI can
 * never drift apart. Assembled here — not in gui.ts — because it is shared data collection for
 * observers, not part of serving HTTP: snapshot() supplies the core state, and the per-loop
 * phase/metrics fields come from the same status-render helpers the TUI table uses. */

/** JSON payload for GET /api/status (and `tumwater status --json`). */
export function statusPayload(root: string): object {
  const snap = snapshot(root);
  // The budget gate is fleet-wide (plans/daily-cost-budget.md): when today's spend has
  // reached the cap, every idle role loop's phase reads `budget paused` — one flag covers
  // both dashboards through loopPhase.
  const budgetPausedNow = budgetReached(snap.budget);
  return {
    running: snap.running,
    pid: snap.pid,
    // The running harness's build stamp and staleness (src/build-info.ts); null when no
    // harness runs or its dist carries no stamp — machine-readable for `status --json`.
    build: snap.build,
    // The header's build badge pre-formatted through status-render's buildBadge — the same
    // string the TUI/status table renders. Sent display-ready (like phase and events) because
    // the page is browser JS that cannot import TypeScript, and this multi-branch text must
    // not be re-derived client-side where it could drift from the TUI header.
    buildBadge: buildBadge(snap.build),
    inbox: snap.inbox,
    // Previews of the queued director prompts in execution order (truncated server-side —
    // see StatusSnapshot.inboxPrompts); the page lists them in its project status panel.
    inboxPrompts: snap.inboxPrompts,
    // The daily cost budget while enabled — the page derives its `· budget: $X/$Y today`
    // header badge from this (absent when disabled).
    budget: snap.budget ?? null,
    // Operator pause (`tumwater pause` marker present): every idle role loop's phase reads
    // `paused` ahead of budget/main-red — one flag covers both dashboards through loopPhase.
    paused: snap.paused,
    loops: snap.loops.map((s) => {
      // One live tail read per running loop per poll (was up to three — see renderStatus).
      const live = s.running ? readLiveProgress(root, s.role) : null;
      const m = displayTokenMetrics(root, s, live);
      return {
        role: s.role,
        phase: loopPhase(s, snap.running, root, budgetPausedNow, live, snap.paused),
        // What a working loop is doing right now (first assistant text of the in-flight run).
        // Null when idle — never show a stale item from a finished tick.
        currentWork: live?.currentWork ?? null,
        ticks: s.ticks,
        commits: s.commits,
        generated: m.generated,
        peakCtx: m.peakCtx,
        costUsd: s.totalCostUsd,
        // The loop's spend for the local day (the daily budget window): 0 while its stamp
        // is stale or missing — same helper and semantics as the TUI's `today` column.
        todayUsd: dailyCost(s),
        lastResult: s.lastResult ?? null,
        lastSummary: s.lastSummary ?? null,
        lastTickEndedAt: s.lastTickEndedAt ?? null,
      };
    }),
    events: readEvents(root, 40).map((e) => formatEvent(e)),
    // Project status (planned features + open bugs + open questions), fresh per poll like
    // events — loops edit these files constantly, so there is no cache to go stale. The page
    // derives the header badge count from this list's length.
    plans: plannedPlans(root),
    bugs: openBugs(root),
    questions: openQuestions(root),
  };
}
