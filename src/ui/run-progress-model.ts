import { callBuffersOutput } from "../pi/command-shape.js";
import type { RunnerState } from "../runner/runner-state.js";
import { readLiveProgress, type LiveProgress, type ProgressRunKind } from "./progress-data.js";
import { compactTokens } from "../text/format.js";
import { pad2 } from "../text/datetime.js";

/** The in-flight run's PROGRESS display model (split from status-model.ts, which keeps the
 * role-phase ladder, the merge cells, and the row derivations): how an in-flight run renders
 * its live detail — elapsed, turn, context, current tool, stall — derived from the live log
 * tail (progress-data.ts) and shared by BOTH observer surfaces: the terminal table
 * (status-render.ts's state cell) and the JSON/GUI payload (status-payload.ts), plus the
 * phase ladder's in-flight branches (status-model.ts's rolePhase), so the three cannot
 * drift apart. This is the disk-reading half: every helper here reads (or accepts a caller's
 * precomputed) live log tail, while status-model.ts derives labels from the snapshot. */

/** Seconds/minutes/hours elapsed formatting shared by the progress helpers and the phase
 * ladder's elapsed branches (rolePhase's merge and parked branches). The hours bucket
 * rounds to whole minutes off the total, so a rounded-up 59m5Xs carries into the next hour
 * ("2h0m"); rounding the remainder alone would print the impossible "1h60m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad2(s % 60)}s`;
  const totalMinutes = Math.round(s / 60);
  return `${Math.floor(totalMinutes / 60)}h${totalMinutes % 60}m`;
}

/** The label for a role's in-flight run: `<label>` plus how long it has been running
 * ("working 3m", "reviewing 2m") — shared by workingDetail and the review-gate branch of
 * rolePhase so their elapsed formatting cannot drift. A run with no recorded start time
 * renders as just the bare label. (A merge's elapsed is its marker's, never the run's —
 * rolePhase's merge branch builds that head itself.) */
export function inFlightLabel(s: RunnerState, label: string): string {
  const elapsed = s.lastRunStartedAt ? duration(Date.now() - s.lastRunStartedAt) : "";
  return `${label} ${elapsed}`.trim();
}

/** One rule for whether a log tail's progress describes THIS run: the log's newest write
 * (quietMs is measured from the raw log's mtime) must have happened after the run started.
 * Until the current agent run writes its first line, the log's tail is the PREVIOUS run — the
 * baseline check (worktree reset plus suite) can take 30–130 s, and a run waking after 5+
 * minutes idle would otherwise show the earlier run's turn/context/tool and a "no pi output"
 * quiet time measured from before the run even began, tripping the STALL alert on every
 * such run's baseline (BUGS.md 2026-09-30). Once the run writes, its mtime is inside the
 * run, so quietMs can never exceed the run's own age and the honest quiet measure survives.
 * Applied by every progress reader (workingDetail, the reviewing branch of rolePhase, the
 * token metrics, roleRowCells' precomputed tail) and by status-render's state cell via
 * runProgress, so the TUI, the GUI payload, and the alert cannot drift apart. A state with
 * no recorded start (a stale `running` flag after a crash) cannot be judged and keeps the
 * tail as before. `p` may be undefined (the caller's "no tail fetched" sentinel) or null
 * ("no log"); both read as no progress. */
function progressOfRun(s: RunnerState, p: LiveProgress | null | undefined): LiveProgress | null {
  if (!p) return null;
  if (s.lastRunStartedAt === undefined) return p;
  const elapsed = Math.max(0, Date.now() - s.lastRunStartedAt);
  if (p.quietMs > elapsed) return null; // Newest write predates this run: a previous run's tail.
  return { ...p, quietMs: Math.min(p.quietMs, elapsed) };
}

/** The stall phrases a phase label can carry — inFlightDetail appends "tool call stalled:
 * <tool>", "no model reply for <duration>", and "no agent output for <duration>" to the head — as
 * a regex SOURCE string plus the
 * compiled matcher, single-homed beside the code that renders those phrases. Every consumer
 * that must recognize a stall inside a rendered phase label goes through these two, so the
 * server-side alert (team-alert-status.ts) and the dashboard's browser twin (gui-client-model.ts,
 * interpolating the source into its String.raw script) cannot drift from the wording the cell
 * actually renders. */
export const STALL_SOURCE = String.raw`tool call stalled[^·]*|no model reply for [^·]*|no agent output for [^·]*`;

/** STALL_SOURCE compiled — the server-side matcher (team-alert-status.ts's stuck alert). */
export const STALL_RE = new RegExp(STALL_SOURCE);

/** The shared parts assembly for an in-flight state cell: `head` (the phase label with its
 * own elapsed — inFlightLabel for a run, the merge branch's own for a merge) plus turn,
 * live context, current tool, and the ≥5-min no-output stall flag. `p` is null when there is
 * no progress (no log yet) — falls back to the bare head. */
export function inFlightDetail(head: string, p: LiveProgress | null): string {
  if (!p) return head;
  const parts = [head, `turn ${p.turns + 1}`];
  if (p.contextTokens > 0) parts.push(`ctx ${compactTokens(p.contextTokens)}`);
  // A tool call open and silent past the configured stall threshold names itself in the cell —
  // the same rule as runPi's warning event, derived from the raw log tail. It takes lastTool's
  // slot when it is that tool (the common single-call case) instead of repeating the label.
  if (p.stalledTool) parts.push(`tool call stalled: ${p.stalledTool}`);
  else if (p.lastTool) parts.push(p.lastTool);
  // Silence under five minutes is normal (slow local-model prefills, long tool calls);
  // only flag a stall once at least five minutes have passed without any pi output. While a
  // tool call that buffers its output (a redirect or pipe — the run prompt's prescribed
  // `> check.log` verify shape) is open, that flat threshold would cry wolf inside the call's
  // own generous wall-clock stall window: the silence is the prescribed shape, not a hang,
  // and a real stall past that window has already named itself as `tool call stalled: <tool>`
  // above. Defer to the call so a slow suite stops being read as a hang (BUGS.md 2026-10-28).
  const hasOpenBuffered =
    p.openToolCalls?.some((call) => callBuffersOutput(p.agent, call.command || call.label)) ?? false;
  // A model request left unanswered past the stall threshold names the cause instead: the
  // provider has not replied (BUGS.md 2026-10-29). pi's retries write to the log, so the bare
  // silence measure restarts with each attempt, while this one spans the whole wait.
  if (p.unansweredReply) {
    const { waitedMs, attempts } = p.unansweredReply;
    parts.push(`no model reply for ${duration(waitedMs)}${attempts > 1 ? ` (${attempts} attempts)` : ""}`);
  } else if (p.quietMs >= 5 * 60_000 && !hasOpenBuffered) {
    parts.push(`no agent output for ${duration(p.quietMs)}`);
  }
  return parts.join(" · ");
}

/** Which pi run kind (progress-data.ts's ProgressRunKind) a role's in-flight cells should read:
 * the review gate's reviewer run ("gate") while the run is under review — its `session`
 * event is the log's newest and its counts are what "reviewing" describes — the author's
 * own run ("author") for every other in-flight phase. One home for the rule so the TUI
 * table and the GUI payload cannot drift (the precomputed `live` tail must name the same
 * run the phase label does). status-model's roleRowCells is its only reader. */
export function progressKind(s: RunnerState): ProgressRunKind {
  return s.phase === "review" ? "gate" : "author";
}

/** progressOfRun with the tail read folded in — the one home for the
 * `live === undefined ? readLiveProgress(...) : live` idiom. Callers holding this frame's
 * already-fetched tail pass it as `live` (renderStatus reads once per running role and
 * threads it through every helper); standalone callers pass undefined and this reads the
 * role's log itself — the author accumulator by default, the gate one via `kind`. Every
 * tail-reading caller outside this module routes through it; status-model.ts's staged branch
 * is the one exception, keeping its raw readLiveProgress call because it feeds inFlightDetail
 * a freshly read gate tail for the merge label, not a per-frame threaded one. */
export function runProgress(
  root: string,
  s: RunnerState,
  live?: LiveProgress | null,
  kind: ProgressRunKind = "author",
): LiveProgress | null {
  return progressOfRun(s, live === undefined ? readLiveProgress(root, s.role, kind) : live);
}

/** The state cell for a working role: elapsed · turns · live context · current tool. Pass
 * `live` — this frame's already-fetched tail (renderStatus reads once per running role and
 * threads it through every helper) — to avoid re-reading the log; without it, this reads on
 * its own for standalone callers. */
export function workingDetail(root: string, s: RunnerState, live?: LiveProgress | null): string {
  const p = runProgress(root, s, live);
  return inFlightDetail(inFlightLabel(s, "working"), p);
}
