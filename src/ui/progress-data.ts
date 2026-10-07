import {
  applyToolExecutionEvent,
  parsePiEventLine,
  toolCallCommand,
  type OpenToolCall,
  type PiRunKind,
} from "../pi/pi-event-line.js";
import { bufferedCommandStallMs, commandBuffersOutput } from "../pi/command-shape.js";
import { describeToolCall } from "../text/phrases.js";
import { squash } from "../text/text.js";
import { defaultConfig, liveConfig } from "../config/config.js";
import { landWorktreePath } from "../paths.js";
import { statRoleLog, readCompleteLines, type TailState, withTail } from "../files/tail.js";

/** Live view of an in-flight tick, derived from the tail of the loop's raw pi log.
 * The log is append-only across ticks AND runs: a role makes several kinds of pi run into
 * the one `roleLogPath` file — the authoring tick's run in its own worktree, and the review
 * gate's runs (reviewer, conflict resolver) in its `_land-<role>` lander worktree. Every run
 * starts with the harness's `tumwater_run` marker (src/pi/pi.ts), written before pi spawns so
 * it precedes pi's first `session` event; a kind-bearing marker names the run's kind, and a
 * session no kind-bearing marker preceded falls back to the legacy `cwd` test (the worktree
 * the session's `cwd` names). The reader keeps one accumulator per run kind
 * (readLiveProgress's `kind`), so a gate run starting mid-tick resets only the gate's counts,
 * never the working tick's (BUGS.md 2026-09-22). Everything after a run's opening marker (or,
 * for a legacy log, its `session` event) is folded into that run's accumulator; lines from two
 * truly concurrent runs of different kinds interleave unattributed and land in the newer run's
 * accumulator — the best attribution the line format allows, since only the marker and
 * `session` carry the run's identity. */
export interface LiveProgress {
  /** Assistant turns completed so far. */
  turns: number;
  /** Tool executions started so far. */
  toolCalls: number;
  /** Context tokens of the latest assistant message. */
  contextTokens: number;
  /** Output tokens generated in this run (usage.output summed over assistant messages). */
  outputTokens: number;
  /** Largest single-request context submitted in this run (max, not sum). */
  peakContextTokens: number;
  /** Short human label of the most recent tool call, e.g. `bash npm test`. */
  lastTool?: string;
  /** Tool calls started but not yet ended in this run (pi runs a message's tool calls
   * concurrently by default), keyed by pi's toolCallId. lastActivityAt moves only on
   * content-bearing updates, so a hung command's entry goes stale while its siblings keep
   * streaming — readLiveProgress turns the first one past the configured stall threshold into
   * stalledTool. Tail state like every other field: freshProgress restores it to undefined. */
  openToolCalls?: OpenToolCall[];
  /** What the loop is working on: first assistant text of the current run (~60 chars). */
  currentWork?: string;
  /** ms since pi last emitted anything (from file mtime). */
  quietMs: number;
  /** The first open tool call that has been silent for at least the configured stall
   * threshold — the in-flight cell's "tool call stalled" flag names it. Derived, not folded:
   * silence is a property of wall-clock time, so readLiveProgress recomputes it on every read
   * (like quietMs) instead of feedLine setting it from any single line. */
  stalledTool?: string;
}

/** How much log tail a first observation scans initially (or after rotation); findSeedOffset
 * grows the window in doubling steps until it contains the log's last `session` event, so
 * this is the floor, not the guarantee. Steady-state polls only parse the bytes appended
 * since the previous poll, so this window is read at attach time only, not every second. */
const TAIL_BYTES = 4 * 1024 * 1024;

/** Byte offset a first observation of the log (size `size`) seeds from: the start of the
 * smallest suffix window, grown from TAIL_BYTES in doubling steps, that contains a complete
 * `session` event line — or 0 when the log carries none. A bare `size - TAIL_BYTES` seed
 * opens mid-run whenever the log (which accumulates across ticks up to logMaxBytes) is
 * larger than the window, and the first observation then counts every assistant turn after
 * that offset as if it were one run — a number with no defined meaning (BUGS.md 2026-09-22).
 * Seeding at the window that contains the last session anchors the read at a real run
 * boundary: the session event resets the accumulator, so the turns reported are exactly the
 * current run's. Doubling keeps the scan bounded (~log2 reads over a rotated log) and cheap
 * (the type-first pre-filter skips message_update lines without JSON.parse); attach-time
 * only — steady-state polls never rescan. The window is injectable for tests. */
export function findSeedOffset(file: string, size: number, window = TAIL_BYTES): number {
  for (;;) {
    const from = Math.max(0, size - window);
    const { lines } = readCompleteLines(file, from, size);
    if (lines.some((line) => parsePiEventLine<ProgressEvent>(line, PROGRESS_TYPES)?.type === "session")) return from;
    if (from === 0) return 0; // No session anywhere in the log — the whole file is the best anchor there is.
    window *= 2;
  }
}

/** Which of a role's pi run kinds a LiveProgress describes: `author` — the tick's own
 * run in the role's worktree (the working cell's subject) — or `gate` — the review gate's
 * runs in the role's lander worktree (the reviewing cell's subject). The same union the
 * raw-log marker carries (pi-event-line.ts's PiRunKind), named here for the display layer. */
export type ProgressRunKind = PiRunKind;

/** Per-file incremental state for readLiveProgress: where we last stopped reading and
 * the progress accumulated from everything read so far — one accumulator per run kind
 * (ProgressRunKind), since a gate run's `session` event must not reset the author run's
 * counts. Bounded by the number of distinct log paths observed in this process
 * (one root × its roles for a TUI/GUI). */
const tails = new Map<string, TailState<RoleLogTail>>();

/** The tail state for one role log: per-kind accumulators plus the current run kind (`cur`),
 * set by the most recent run-opening marker or legacy `session` event, which lines carrying
 * no run identity fold into (see the module premise above). */
interface RoleLogTail {
  author: LiveProgress;
  gate: LiveProgress;
  cur: ProgressRunKind;
  /** True once a kind-bearing `tumwater_run` marker fixed the current run's kind, so its
   * following `session` event keeps that kind instead of the legacy cwd test. Cleared when
   * the session lands (or when a legacy marker resets the state). */
  kindFromMarker: boolean;
}

function freshRoleTail(quietMs: number): RoleLogTail {
  return { author: freshProgress(quietMs), gate: freshProgress(quietMs), cur: "author", kindFromMarker: false };
}

/** Max length of a captured work item, ellipsis included (~60 chars). */
const WORK_ITEM_MAX = 60;

/** First non-empty text block of an assistant message: whitespace-collapsed and truncated to
 * WORK_ITEM_MAX. Thinking/tool-call-only (or empty-text) messages yield undefined, so the
 * work item stays unset until some message actually carries text. */
function workItemFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const raw of content) {
    const block = raw as { type?: unknown; text?: unknown } | null;
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    const squashed = squash(block.text, WORK_ITEM_MAX);
    if (!squashed) continue;
    return squashed;
  }
  return undefined;
}

/** The state of a pi run at time zero — every run-scoped field at its initial value. This is
 * the single definition of "fresh": first observation and rotation seed from it (withTail),
 * and a `session` event restores exactly it (feedLine) — so adding a field to LiveProgress
 * updates both places automatically instead of drifting apart. */
function freshProgress(quietMs: number): LiveProgress {
  return {
    turns: 0,
    toolCalls: 0,
    contextTokens: 0,
    outputTokens: 0,
    peakContextTokens: 0,
    lastTool: undefined,
    // Run-scoped like the rest (a `session` event restores it to "no calls tracked").
    // stalledTool is deliberately NOT part of fresh: it is derived from wall-clock time on
    // every read, never folded from lines.
    openToolCalls: undefined,
    currentWork: undefined,
    quietMs,
  };
}

/** The event types feedLine acts on — everything else (streaming deltas, turn/agent
 * bookkeeping) is ignored. Also passed as parsePiEventLine's pre-filter to skip JSON.parse for
 * pi lines whose type is verifiably not one of these; a new case in the switch must be added
 * here too. `tumwater_run` is the harness's own marker (src/pi/pi.ts), read for its run kind:
 * a kind-bearing marker flips the demux and starts that accumulator fresh before its `session`
 * event lands, and a legacy label-only marker ("review") still flips the demux to gate. */
const PROGRESS_TYPES = new Set([
  "session",
  "tumwater_run",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "message_end",
]);

/** The fields feedLine reads off a parsed progress event (a structural subset of pi's JSON). */
interface ProgressEvent {
  type?: string;
  /** session events only: the worktree the run started in — the LEGACY run-kind discriminator
   * for a session no kind-bearing marker preceded (new logs demux by the marker's kind). */
  cwd?: string;
  /** tumwater_run events only: the harness's run kind ("author" | "gate") — the primary demux
   * key for logs written since part 1/5 of the worktree pool. */
  kind?: string;
  /** tumwater_run events only: the harness's label for the run ("review"). */
  label?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  message?: { role?: string; content?: unknown; usage?: { totalTokens?: number; output?: number } };
}

/** Apply one parsed progress event to a progress object (mutates it). */
function feedLine(progress: LiveProgress, event: ProgressEvent): void {
  switch (event.type) {
    case "session": // A new run starts: everything before it was a previous tick — restore the at-time-zero state.
      Object.assign(progress, freshProgress(progress.quietMs));
      break;
    case "tool_execution_start": {
      progress.toolCalls += 1;
      const label = event.toolName ? describeToolCall(event.toolName, event.args) : undefined;
      if (label) progress.lastTool = label;
      // Track the open call for the stall flag — pi runs a message's tool calls concurrently
      // by default, so several can be open at once and end in completion order. The state
      // machine is shared with runPi's warning (pi.ts); only the fallback label differs here.
      // The full raw command rides along because the flag classifies the command's shape,
      // and describeToolCall's label truncates at 32 chars — an operator past that point
      // would be invisible there.
      applyToolExecutionEvent(
        progress.openToolCalls ??= [],
        event.type,
        event.toolCallId,
        event.partialResult,
        label ?? "tool",
        toolCallCommand(event.args),
      );
      break;
    }
    case "tool_execution_update": {
      // Only content-bearing updates prove the command is alive — bash emits one empty-content
      // update right after start, and a content-free keepalive must not mask a hang.
      if (progress.openToolCalls)
        applyToolExecutionEvent(progress.openToolCalls, event.type, event.toolCallId, event.partialResult);
      break;
    }
    case "tool_execution_end": {
      if (progress.openToolCalls)
        applyToolExecutionEvent(progress.openToolCalls, event.type, event.toolCallId, event.partialResult);
      break;
    }
    case "message_end":
      if (event.message?.role === "assistant") {
        progress.turns += 1;
        const usage = event.message.usage;
        if (usage) {
          progress.contextTokens = usage.totalTokens ?? progress.contextTokens;
          progress.outputTokens += usage.output ?? 0;
          progress.peakContextTokens = Math.max(progress.peakContextTokens, usage.totalTokens ?? 0);
        }
        // The first text the loop speaks in this run is its work item ("I'll implement plan X");
        // later messages never replace it.
        if (!progress.currentWork) progress.currentWork = workItemFromContent(event.message.content);
      }
      break;
  }
}

/** Parse pi event lines of ONE run (the `tumwater_run` marker is ignored; the run's
 * `session` event resets the accumulator). Exported for tests; readLiveProgress routes
 * through feedDemuxed instead, since a real role log can interleave two runs' lines. A
 * `session` event without a cwd (the test fixtures' shape) counts as an author run. */
export function parseProgress(lines: string[], quietMs: number): LiveProgress {
  const progress = freshProgress(quietMs);
  for (const line of lines) {
    const event = parsePiEventLine<ProgressEvent>(line, PROGRESS_TYPES);
    if (event) feedLine(progress, event);
  }
  // Freshly fed lines stamp Date.now(), so nothing is stalled right after parsing — the flag
  // exists here so callers that pass a hand-built tail through workingDetail see the same
  // shape readLiveProgress returns.
  progress.stalledTool = stalledToolLabel(progress.openToolCalls);
  return progress;
}

/** The configured threshold for flagging an open tool call as stalled, in ms (0 when
 * disabled) — the same value runPi's stall warning uses, so the state cell and the event feed
 * agree on "stalled". Resolved through liveConfig (the stat-cached read with defaults
 * fallback): an unedited tumwater.json costs one stat per poll. */
export function toolCallStallMs(root: string): number {
  return Math.max(0, liveConfig(root).toolCallStallSeconds) * 1000;
}

/** The label of the first open tool call that has been silent for at least `stallMs` — the
 * in-flight cell's stall flag. Silence is a property of wall-clock time, not of any single
 * line, so this runs on every read rather than in feedLine; `now` and `stallMs` are injectable
 * for tests (freshly fed lines stamp Date.now(), so nothing is stalled right after parsing).
 * A call whose stdout is piped or redirected holds its bytes away from pi until it exits
 * (BUGS.md 2026-09-28: the tick prompt itself prescribes `npm run test 2>&1 | tail`), so its
 * silence is the prescribed shape and never evidence of a hang — but the command can still
 * hang (a leaked grandchild holding the pipe open), so past a wall-clock threshold it is
 * flagged anyway (BUGS.md 2026-10-06), the same threshold runPi's warning applies so the
 * state cell and the event feed agree on "stalled". */
export function stalledToolLabel(
  open: LiveProgress["openToolCalls"],
  now = Date.now(),
  stallMs = defaultConfig().toolCallStallSeconds * 1000,
): string | undefined {
  if (!open || stallMs <= 0) return undefined;
  for (const call of open) {
    if (commandBuffersOutput(call.command || call.label)) {
      if (now - call.lastActivityAt >= bufferedCommandStallMs(stallMs)) return call.label;
      continue;
    }
    if (now - call.lastActivityAt >= stallMs) return call.label;
  }
  return undefined;
}

/** Fold one raw log line into a role log's per-kind tail state (mutates it): the harness's
 * `tumwater_run` marker or a `session` event switches which accumulator following lines fold
 * into. A marker carries the run's kind, so a `session` preceded by one keeps that kind even
 * when author and gate runs share a worktree (part 1/5 of the worktree pool); only a session
 * no kind-bearing marker preceded falls back to the legacy `cwd` test (the lander worktree
 * path = gate), which is how logs written before the marker carried a kind still demux. A
 * marker also starts that kind's accumulator fresh before the session lands, so a previous
 * run's turns/context can never show in the new run's cell. Everything else folds into the
 * current kind's accumulator. Non-JSON noise is skipped. */
function feedDemuxed(tail: RoleLogTail, line: string, gateCwd: string): void {
  const event = parsePiEventLine<ProgressEvent>(line, PROGRESS_TYPES);
  if (!event) return; // Blank, unparseable, or a type this feed does not act on.
  if (event.type === "session") {
    // A kind-bearing marker before this session already fixed the run's kind; a legacy
    // session with no such marker falls back to the cwd test.
    if (!tail.kindFromMarker) tail.cur = event.cwd === gateCwd ? "gate" : "author";
    tail.kindFromMarker = false;
    tail[tail.cur] = freshProgress(tail[tail.cur].quietMs);
    return;
  }
  if (event.type === "tumwater_run") {
    const kind = event.kind === "gate" || event.kind === "author" ? event.kind : undefined;
    if (kind) {
      // Every run writes this marker before pi spawns, and the landing cell reads the
      // accumulator as soon as the marker's stage says `reviewing` — a poll that can land
      // before the session event. Resetting here means a previous run's turns/context (the
      // last review, or another run the gate spent) can never show in the new run's cell.
      // Safe for the in-tick reviewing cell too: a role's gate is serial, so a marker ends
      // the previous run.
      tail.cur = kind;
      tail.kindFromMarker = true;
      tail[kind] = freshProgress(tail[kind].quietMs);
    } else if (event.label === "review") {
      // Legacy log (no kind): a label-only marker still flips the demux to gate before its
      // session event, exactly as before this change.
      tail.cur = "gate";
      tail.gate = freshProgress(tail.gate.quietMs);
    }
    return;
  }
  feedLine(tail[tail.cur], event);
}

/** Live progress for one of a loop's pi run kinds (`author` — the in-flight tick's run in
 * the role's own worktree, the default; `gate` — the review gate's runs in the role's lander
 * worktree, what the reviewing cell shows), or null when there is no log yet. The raw log is
 * append-only while pi runs and every run starts with a `tumwater_run` marker (src/pi/pi.ts),
 * so after seeding from the tail window once we only read and parse bytes appended since the
 * last poll — observers that call this every second (TUI, GUI) stop rescanning up to TAIL_BYTES
 * of JSON per role per poll. */
export function readLiveProgress(root: string, role: string, kind: ProgressRunKind = "author"): LiveProgress | null {
  const log = statRoleLog(tails, root, role);
  if (!log) return null; // No raw log yet — nothing to show.
  const quietMs = Math.max(0, Date.now() - log.st.mtimeMs);
  // Seed from the tail window; a leading partial line is unparseable and skipped by feedLine.
  const tail = withTail(
    tails,
    log.file,
    log.st,
    (size) => ({ fromOffset: findSeedOffset(log.file, size), value: freshRoleTail(quietMs) }),
    (t, line) => feedDemuxed(t, line, landWorktreePath(root, role)),
  );
  const progress = tail[kind];
  progress.quietMs = quietMs;
  // The stall flag is derived from wall-clock time (like quietMs), not folded from lines —
  // recomputed on every read with the configured threshold. A call already open when this
  // observer first saw the log stamps "now" at seed, so it cannot be flagged retroactively;
  // the mtime-based "no pi output" flag covers late observers.
  progress.stalledTool = stalledToolLabel(progress.openToolCalls, Date.now(), toolCallStallMs(root));
  // Copy the open-call entries: feedLine mutates the stored tail value in place — an
  // un-copied collection would alias one mutable structure across every frame ever returned
  // AND with the live tail state.
  return {
    ...progress,
    openToolCalls: progress.openToolCalls ? progress.openToolCalls.map((c) => ({ ...c })) : undefined,
  };
}
