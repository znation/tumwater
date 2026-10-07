/** The run's watchdog clocks, split out of pi.ts's runPi (2026-10-04, organize): the tick
 * deadline and the quiet watchdog (quiet-kill plus the stalled-tool-call warning) — the
 * timing policy of one pi run, which changes for different reasons than the spawn, stream,
 * and result-distillation wiring that drives it (pi.ts keeps those). The factory owns all
 * the mutable state the two timers kept in runPi's closure (the progress window, the
 * zero-byte grace, the warned-call set) and exposes the flags the run's close handler reads
 * back; pi.ts feeds the parser live through the deps accessors, so no notification path is
 * needed when events land. */
import { bufferedCommandStallMs, commandBuffersOutput } from "./command-shape.js";
import type { OpenToolCall } from "./pi-event-line.js";

interface PiWatchdogDeps {
  /** The parser's forward-progress counter, read live at each check. */
  progressCount(): number;
  /** The currently open tool calls, read live at each check. */
  openToolCalls(): OpenToolCall[];
  tickTimeoutMs: number;
  quietMs: number;
  stallMs: number;
  /** Give the deadline one extension when a progress event landed within the last
   * `progressWindowMs` of the base budget (the gate's fresh-session reviewer and conflict
   * resolver; authoring runs resume next tick and keep one deadline). */
  extendOnProgress?: boolean;
  /** Kill the run's process tree (terminateChild on the spawned child). */
  kill(): void;
  onToolCallStalled?: (message: string) => void;
}

/** The flags the run's close handler and finish() read back, plus the feed and teardown
 * calls the data handlers and settle path make. The booleans are live getters: they change
 * while the run is in flight, so a copied field would go stale. */
interface PiWatchdogs {
  /** The tick deadline fired. */
  readonly timedOut: boolean;
  /** The wall-clock budget the deadline actually used: the base budget, doubled when a
   * progressing gate run took its one extension. Feeds the kill message's seconds. */
  readonly timeoutBudgetMs: number;
  /** The deadline fired on a run still making progress — same window the quiet watchdog
   * honors, so the two watchdogs agree on what a healthy run looks like (BUGS.md 2026-09-29). */
  readonly timedOutProgressing: boolean;
  /** The quiet watchdog killed the run as hung. */
  readonly quietKilled: boolean;
  /** Any byte arrived (stdout or stderr): the run has demonstrably begun. */
  readonly sawOutput: boolean;
  /** A stdout byte: ends the zero-byte starting phase without touching progress. */
  noteByte(): void;
  /** A stderr byte: rare and meaningful (crash traces, warnings) — ends the starting phase
   * and counts as progress, so a crashing run's last words refresh the quiet window. */
  noteStderr(): void;
  /** Stop both timers: the run settled (finished, or settled early on a broken raw log). */
  stop(): void;
}

/** Start one pi run's two watchdog clocks: the tick deadline (kills the process tree when it
 * fires, recording whether the run was still progressing) and the quiet/stall interval
 * (quiet-kills a run that stopped making progress and warns on stalled tool calls). Returns
 * the live flags the run's close handler reads and the note/stop calls its data handlers and
 * settle path make. */
export function startPiWatchdogs(deps: PiWatchdogDeps): PiWatchdogs {
  let lastProgressAt = Date.now();
  let lastProgressCount = 0;
  let sawOutput = false;
  let timedOut = false;
  let timedOutProgressing = false;
  let quietKilled = false;

  // A gate run earns one deadline extension while it is still making progress, so a large
  // diff's review can finish instead of timing out mid-verification and being re-read from
  // scratch on the next attempt (BUGS.md 2026-10-07). "Still making progress" means a
  // progress event landed within `progressWindowMs` of the deadline — the quiet watchdog's
  // own recency window, but never more than half the tick budget, so a quiet window
  // configured longer than the budget cannot let a run that stopped progressing past the
  // base deadline. The window does not depend on the quiet watchdog being enabled: a
  // progressing gate run earns its extension even when quietTimeoutSeconds is 0. One
  // checkpoint timer snapshots the progress count `progressWindowMs` before the deadline;
  // only progress since that snapshot counts, so a run that progressed early and then
  // stalled keeps today's bound.
  const progressWindowMs =
    deps.quietMs > 0 ? Math.min(deps.quietMs, deps.tickTimeoutMs / 2) : deps.tickTimeoutMs / 2;
  let checkpointProgress = 0;
  const checkpoint = setTimeout(
    () => {
      checkpointProgress = deps.progressCount();
    },
    Math.max(0, deps.tickTimeoutMs - progressWindowMs),
  );

  let extended = false;
  let timeoutBudgetMs = deps.tickTimeoutMs;
  let timeout: ReturnType<typeof setTimeout>;
  const fireDeadline = () => {
    if (deps.extendOnProgress && !extended && deps.progressCount() > checkpointProgress) {
      extended = true;
      timeoutBudgetMs = deps.tickTimeoutMs * 2;
      timeout = setTimeout(fireDeadline, deps.tickTimeoutMs); // one more slice; the next firing is final
      return;
    }
    timedOut = true;
    // A deadline that fires on a run still making progress killed a slow run, not a hung
    // one: "recent progress" is the same window the quiet watchdog itself honors, so the
    // two watchdogs agree on what a healthy run looks like (BUGS.md 2026-09-29). A run
    // with no progress event at all — never emitted a byte, or bytes without one structured
    // event — keeps today's discard path: it has not demonstrably begun.
    timedOutProgressing = deps.progressCount() > 0 && Date.now() - lastProgressAt <= deps.quietMs;
    deps.kill();
  };
  timeout = setTimeout(fireDeadline, deps.tickTimeoutMs);

  // Quiet watchdog: a healthy run makes PROGRESS continuously even when slow — messages
  // start and end, turns and tool calls complete. Prolonged lack of progress means a hung
  // tool (an interactive command waiting for input) or a zombie stream (a dead generation
  // whose connection drips content-free keepalive updates for hours) that would otherwise
  // burn the whole tick timeout. Raw output bytes deliberately do NOT reset the clock:
  // keepalives are bytes without progress. Checked on an interval against the wall clock,
  // so it also fires promptly after a machine sleep rather than pausing with a suspended
  // timer. The stall warning below rides the same interval: it needs no kill of its own,
  // only a periodic look at which open tool calls have gone silent.
  // A run that has not yet produced progress is starting, not hung: process creation and
  // model connect are legitimately slow on a loaded machine (a full test suite, a busy
  // fleet), and charging that startup latency as pi silence quiet-kills runs that never
  // had the chance to speak (BUGS.md 2026-09-23). The one extra quiet window that fix
  // granted a zero-progress run still false-killed under merge-check load: the kill runs
  // on an interval against the wall clock, so the firing check can predate the child's
  // first bytes entirely — fork/exec starved by the same load, or bytes already written
  // but not yet drained (a firing timer phase precedes the poll phase that delivers
  // stdout, and a suspended machine resumes the same way). The 2026-09-23 fix therefore
  // gave a byte-silent run no quiet kill at all, delegating its bound to the tick timeout
  // — which holds only while tickTimeoutSeconds is near the quiet window's scale (BUGS.md
  // 2026-09-29: the live 54000 s config left a wedged model connection 15 hours in a
  // concurrency slot). A zero-byte run now gets a finite bound of its own, independent of
  // the tick timeout: max(two quiet windows, 30 min). Startup latency under healthy load
  // stays far below it, so the runs the 2026-09-23 fix protected are still protected; a
  // run that is genuinely wedged before its first byte (dead connection, unscheduled
  // fork/exec) is reaped at half an hour instead of at the tick timeout. The false
  // positive it can cost — a machine so loaded the child has not been scheduled in 30
  // minutes — is a quiet kill, which resumes the session and the worktree's edits like
  // an interruption: a restart, not discarded work. Once bytes have flowed the run has
  // begun; bytes without progress keep the doubled window (the zombie-stream case), and
  // once real progress has landed quietTimeoutSeconds applies unchanged.
  const zeroByteSilenceMs = Math.max(deps.quietMs * 2, 30 * 60_000);
  const allowedSilenceMs = () =>
    deps.progressCount() > 0 ? deps.quietMs : sawOutput ? deps.quietMs * 2 : zeroByteSilenceMs;
  // The stall warning's threshold (distinct from the kill above): one hung tool call is
  // surfaced by name even while sibling calls keep streaming, so total silence is not
  // required. One warning per stalled call — the interval keeps firing until the kill or
  // the call ends.
  const warnedStalledCalls = new Set<string>();
  const checkEveryMs = deps.quietMs > 0 ? deps.quietMs : deps.stallMs;
  const quietCheck =
    checkEveryMs > 0
      ? setInterval(
          () => {
            if (deps.progressCount() > lastProgressCount) {
              lastProgressCount = deps.progressCount();
              lastProgressAt = Date.now();
            } else if (deps.quietMs > 0 && Date.now() - lastProgressAt > allowedSilenceMs()) {
              quietKilled = true;
              deps.kill();
            }
            if (deps.stallMs > 0) {
              for (const call of deps.openToolCalls()) {
                if (warnedStalledCalls.has(call.id)) continue;
                // A command whose stdout is piped or redirected holds its bytes away from
                // pi until it exits, so "no output" there is the prescribed shape, not
                // evidence of a hang (BUGS.md 2026-09-28: the tick prompt tells every loop
                // to pipe its verification through `tail`, and the resulting false alarms
                // were the digest's top warning cluster, drowning real hangs). Silence is
                // not the only way such a command hangs, though: a leaked grandchild
                // holding the pipe open keeps `tail` from ever seeing EOF (BUGS.md
                // 2026-10-06: a 19-min piped verify raised no warning and held a restart's
                // drain). So a buffered call gets a wall-clock threshold instead — open
                // far longer than any healthy verify run — with the duration, not
                // silence, named as the evidence. The call's full raw command is
                // classified, never its display label: the label truncates at 32 chars,
                // so an operator past that point would be invisible there.
                if (commandBuffersOutput(call.command || call.label)) {
                  const openMs = Date.now() - call.lastActivityAt;
                  const bufferedStallMs = bufferedCommandStallMs(deps.stallMs);
                  if (openMs >= bufferedStallMs) {
                    warnedStalledCalls.add(call.id);
                    deps.onToolCallStalled?.(
                      `tool call stalled: ${call.label} — no exit for ${Math.round(openMs / 60_000)}m`,
                    );
                  }
                  continue;
                }
                const silentMs = Date.now() - call.lastActivityAt;
                if (silentMs >= deps.stallMs) {
                  warnedStalledCalls.add(call.id);
                  // Whole minutes read cleaner in the feed; sub-minute thresholds stay in seconds.
                  const silent =
                    silentMs < 60_000
                      ? `${Math.round(silentMs / 1000)}s`
                      : `${Math.round(silentMs / 60_000)}m`;
                  deps.onToolCallStalled?.(`tool call stalled: ${call.label} — no output for ${silent}`);
                }
              }
            }
          },
          Math.min(Math.max(checkEveryMs / 2, 250), 30_000),
        )
      : undefined;

  return {
    get timedOut() {
      return timedOut;
    },
    get timeoutBudgetMs() {
      return timeoutBudgetMs;
    },
    get timedOutProgressing() {
      return timedOutProgressing;
    },
    get quietKilled() {
      return quietKilled;
    },
    get sawOutput() {
      return sawOutput;
    },
    noteByte() {
      sawOutput = true; // any byte ends the starting phase, progress or not
    },
    noteStderr() {
      sawOutput = true;
      lastProgressAt = Date.now();
    },
    stop() {
      clearTimeout(timeout);
      clearTimeout(checkpoint);
      if (quietCheck) clearInterval(quietCheck);
    },
  };
}
