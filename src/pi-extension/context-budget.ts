/**
 * Bundled pi extension: tells the model how full its context window is, at a few fixed
 * thresholds, by appending one short note to the tool result that crosses each one. Loaded on
 * every pi run via `-e <this file>` from src/pi/pi-args.ts, after bounded-output and context-shake.
 *
 * Why: a run cannot see its own context usage. pi (1.0.0) does compact mid-run, but only once the
 * projected context passes contextWindow − reserveTokens (16,384 by default — ~87% of the budget
 * fallback's ~127k window), and that compaction replaces the run's earlier reads with a lossy
 * summary; past it, a run that keeps reading hits the window and lands nothing. context-shake
 * reclaims the oldest bulky tool results first, so the notes now sit above that reclaim line: the
 * 70% note names the crossing, context-shake elides what it can in the same turn_end, and at 85%
 * the note is the stop-reading backstop for a run whose remaining results were not reclaimable.
 * The failure mode the numbers exist for is the fallback's local model (Qwen3.8-27B): its longest
 * ticks peaked at 96–110k tokens (coverage, steward, telemetry, plan; 2026-09-29..10-01) while the
 * prompt's reading budget could only say "your window is finite". On a large-window model the
 * thresholds are rarely reached, so the extension costs nothing there.
 *
 * The threshold logic is a pure, exported function (`contextNote`) so it is unit-testable without
 * pi; the default export is a thin adapter over pi's `tool_result` event and `ctx.getContextUsage()`
 * (pi docs, extensions.md "Context and session changes"). One note per threshold per process: a
 * resumed session (--continue) starts a fresh process and re-warns at most once, at the highest
 * threshold it has already passed. The token counts render through format.ts's compactTokens, the
 * harness's one token format (text.ts imports nothing, so pi can load it beside this file).
 */

import { compactTokens } from "../text/format.js";
import { readContextUsage } from "./context-usage.js";

/** Context-usage percentages at which the model is told where it stands. */
export const CONTEXT_THRESHOLDS: readonly number[] = [50, 70, 85];

/** The note for a context usage reading, or null when no threshold above `lastWarned` has been
 * crossed. Returns the threshold it fired for, so the caller can remember it. Pure. */
export function contextNote(
  percent: number | null | undefined,
  tokens: number | null | undefined,
  contextWindow: number,
  lastWarned: number,
): { threshold: number; text: string } | null {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return null;
  const crossed = CONTEXT_THRESHOLDS.filter((t) => percent >= t && t > lastWarned);
  const threshold = crossed[crossed.length - 1];
  if (threshold === undefined) return null;
  const used =
    tokens !== null && tokens !== undefined && contextWindow > 0
      ? ` (${compactTokens(tokens)} of ${compactTokens(contextWindow)} tokens)`
      : "";
  const advice =
    threshold >= 85
      ? "Stop reading now: finish what is in progress, then end your reply in the form your instructions require."
      : threshold >= 70
        ? "Wrap up: make the smallest change that completes your task, verify it, and end your reply."
        : "Finish the task you chose with what you have; start no new exploration.";
  return { threshold, text: `[tumwater: your context window is ${Math.floor(percent)}% full${used}. ${advice}]` };
}

/** Minimal structural types for pi's extension API — pi itself loads this file, so the real
 * types are not needed at compile time and stay out of the dependency tree. */
interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

interface ContextBudgetToolResultEvent {
  content?: Array<{ type?: string; text?: string }>;
}

interface ContextBudgetContext {
  getContextUsage?: () => ContextUsage | undefined;
}

interface PiExtensionApi {
  on(
    event: string,
    handler: (event: ContextBudgetToolResultEvent, ctx?: ContextBudgetContext) => unknown,
  ): void;
}

/** The default export's guard reads the thresholds at call time (not module load), so the
 * degenerate "no thresholds configured" case stays testable: an empty list warns at nothing
 * and never asks for a usage projection. Once the last threshold has fired it stops asking
 * for usage at all — getContextUsage rebuilds the session projection and its token estimate
 * on every call. */
export default function contextBudget(pi: PiExtensionApi): void {
  const lastThreshold = CONTEXT_THRESHOLDS[CONTEXT_THRESHOLDS.length - 1] ?? 0;
  let lastWarned = 0;
  pi.on("tool_result", (event, ctx) => {
    if (lastWarned >= lastThreshold) return undefined;
    const usage = readContextUsage(ctx);
    if (!usage) return undefined;
    const note = contextNote(usage.percent, usage.tokens, usage.contextWindow, lastWarned);
    if (!note) return undefined;
    lastWarned = note.threshold;
    const content = Array.isArray(event.content) ? event.content : [];
    return { content: [...content, { type: "text", text: `\n\n${note.text}` }] };
  });
}
