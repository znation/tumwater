import type { LoopState } from "../loop/loop-state.js";
import { readLiveProgress, type LiveProgress, type ProgressRunKind } from "./progress-data.js";
import { compactTokens } from "../text/format.js";

/** The in-flight tick's PROGRESS display model (split from status-model.ts, which keeps the
 * loop-phase ladder, the landing cells, and the row derivations): how a running tick renders
 * its live detail — elapsed, turn, context, current tool, stall — derived from the live log
 * tail (progress-data.ts) and shared by BOTH observer surfaces: the terminal table
 * (status-render.ts's state cell) and the JSON/GUI payload (status-payload.ts), plus the
 * phase ladder's in-flight branches (status-model.ts's loopPhase), so the three cannot
 * drift apart. This is the disk-reading half: every helper here reads (or accepts a caller's
 * precomputed) live log tail, while status-model.ts derives labels from the snapshot. */

/** Seconds/minutes/hours elapsed formatting shared by the progress helpers and the phase
 * ladder's elapsed branches (loopPhase's landing and parked branches). */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m`;
}

/** The label for a loop's in-flight tick: `<label>` plus how long it has been running
 * ("working 3m", "reviewing 2m") — shared by workingDetail and the review-gate branch of
 * loopPhase so their elapsed formatting cannot drift. A tick with no recorded start time
 * renders as just the bare label. (A landing's elapsed is its marker's, never the tick's —
 * loopPhase's landing branch builds that head itself.) */
export function inFlightLabel(s: LoopState, label: string): string {
  const elapsed = s.lastTickStartedAt ? duration(Date.now() - s.lastTickStartedAt) : "";
  return `${label} ${elapsed}`.trim();
}

/** One rule for whether a log tail's progress describes THIS tick: the log's newest write
 * (quietMs is measured from the raw log's mtime) must have happened after the tick started.
 * Until this tick's pi run writes its first line, the log's tail is the PREVIOUS run — the
 * baseline check (worktree reset plus suite) can take 30–130 s, and a tick waking after 5+
 * minutes idle would otherwise show the earlier run's turn/context/tool and a "no pi output"
 * quiet time measured from before the tick even began, tripping the STALL alert on every
 * such tick's baseline (BUGS.md 2026-09-30). Once the run writes, its mtime is inside the
 * tick, so quietMs can never exceed the tick's own age and the honest quiet measure survives.
 * Applied by every progress reader (workingDetail, the reviewing branch of loopPhase, the
 * token metrics, loopRowCells' precomputed tail) and by status-render's state cell via
 * tickProgress, so the TUI, the GUI payload, and the alert cannot drift apart. A state with
 * no recorded start (a stale `running` flag after a crash) cannot be judged and keeps the
 * tail as before. `p` may be undefined (the caller's "no tail fetched" sentinel) or null
 * ("no log"); both read as no progress. */
function progressOfTick(s: LoopState, p: LiveProgress | null | undefined): LiveProgress | null {
  if (!p) return null;
  if (s.lastTickStartedAt === undefined) return p;
  const elapsed = Math.max(0, Date.now() - s.lastTickStartedAt);
  if (p.quietMs > elapsed) return null; // Newest write predates this tick: a previous run's tail.
  return { ...p, quietMs: Math.min(p.quietMs, elapsed) };
}

/** The stall phrases a phase label can carry — inFlightDetail appends "tool call stalled:
 * <tool>" and "no pi output for <duration>" to the head — as a regex SOURCE string plus the
 * compiled matcher, single-homed beside the code that renders those phrases. Every consumer
 * that must recognize a stall inside a rendered phase label goes through these two, so the
 * server-side alert (fleet-alerts.ts) and the dashboard's browser twin (gui-client-model.ts,
 * interpolating the source into its String.raw script) cannot drift from the wording the cell
 * actually renders. */
export const STALL_SOURCE = String.raw`tool call stalled[^·]*|no pi output for [^·]*`;

/** STALL_SOURCE compiled — the server-side matcher (fleet-alerts.ts's stuck alert). */
export const STALL_RE = new RegExp(STALL_SOURCE);

/** The shared parts assembly for an in-flight state cell: `head` (the phase label with its
 * own elapsed — inFlightLabel for a tick, the landing branch's own for a landing) plus turn,
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
  // only flag a stall once at least five minutes have passed without any pi output.
  if (p.quietMs >= 300_000) parts.push(`no pi output for ${duration(p.quietMs)}`);
  return parts.join(" · ");
}

/** Which pi run kind (progress-data.ts's ProgressRunKind) a loop's in-flight cells should read:
 * the review gate's reviewer run ("gate") while the tick is under review — its `session`
 * event is the log's newest and its counts are what "reviewing" describes — the author's
 * own run ("author") for every other in-flight phase. One home for the rule so the TUI
 * table and the GUI payload cannot drift (the precomputed `live` tail must name the same
 * run the phase label does). status-model's loopRowCells is its only reader. */
export function progressKind(s: LoopState): ProgressRunKind {
  return s.phase === "review" ? "gate" : "author";
}

/** progressOfTick with the tail read folded in — the one home for the
 * `live === undefined ? readLiveProgress(...) : live` idiom. Callers holding this frame's
 * already-fetched tail pass it as `live` (renderStatus reads once per running loop and
 * threads it through every helper); standalone callers pass undefined and this reads the
 * role's log itself — the author accumulator by default, the gate one via `kind`. Every
 * tail-reading caller outside this module routes through it; status-model.ts's staged branch
 * is the one exception, keeping its raw readLiveProgress call because it feeds inFlightDetail
 * a freshly read gate tail for the landing label, not a per-frame threaded one. */
export function tickProgress(
  root: string,
  s: LoopState,
  live?: LiveProgress | null,
  kind: ProgressRunKind = "author",
): LiveProgress | null {
  return progressOfTick(s, live === undefined ? readLiveProgress(root, s.role, kind) : live);
}

/** The state cell for a working loop: elapsed · turns · live context · current tool. Pass
 * `live` — this frame's already-fetched tail (renderStatus reads once per running loop and
 * threads it through every helper) — to avoid re-reading the log; without it, this reads on
 * its own for standalone callers. */
export function workingDetail(root: string, s: LoopState, live?: LiveProgress | null): string {
  const p = tickProgress(root, s, live);
  return inFlightDetail(inFlightLabel(s, "working"), p);
}
