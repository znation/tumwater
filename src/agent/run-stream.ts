/** The streaming pipeline of the backend agent runner (plans/agent-backends.md "The seam"):
 * everything the run does live with the child's stdout/stderr after spawn — the native-to-
 * canonical stdout line splitting with its over-long-line discard, the stderr window and its
 * fallback-clone warning matcher, the stream-minted session's second ledger record, and the
 * settle/flush that resolves the run's promise. It is the part of the runAgent split (part
 * 2/2) that the coordinator (src/agent/run-agent.ts) delegates to behind the `AgentStream`
 * interface: run-agent wires the child's `data` events to `feedStdout`/`feedStderr`, binds the
 * settlement state's stream getters, and keeps the watchdogs, abort wiring and the
 * `error`/`exit`/`close` listeners itself. This module imports only run-agent's, run-spawn's
 * and run-settle's type surfaces, so there is no runtime import cycle. */

import { removeTree } from "../files/files.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { startPiWatchdogs } from "../pi/pi-watchdogs.js";
import type { AgentBackend } from "./agent-backend.js";
import type { PiRunOptions } from "./run-agent.js";
import type { AppendLog, SpawnedRun } from "./run-spawn.js";
import { recordSession } from "./session-ledger.js";

/** How many trailing stderr characters are carried into the next chunk's warning match, so a
 * warning split across two `data` events is still seen. The warnings are short lines, so a few
 * hundred characters always cover a straddle. */
const STDERR_MATCH_TAIL = 512;

/** The largest native stdout line the runner will buffer. A complete native event is one JSON
 * object; a line this long is already at the default whole-log cap (`logMaxBytes`, 16 MiB), so
 * continuing to buffer it can only be a malformed stream. Past it `feedCanonical` drops the
 * buffered line and skips input to the next newline, so a backend that streams bytes with no
 * newline — each byte resetting the quiet watchdog — cannot grow the buffer until the run
 * timeout (4 h by default) exhausts the harness's memory. */
export const MAX_NATIVE_LINE_CHARS = 16 * 1024 * 1024;

/** The live streaming surface a run's coordinator binds to: the two `data`-event feed entry
 * points, the settlement state's stream getters (`onLine`/`feedCanonical`/`finish`/`settled`/
 * `stderr`/`fallbackClone`), all owned by one `createAgentStream` call so the pipeline's
 * mutable locals are shared by exactly the closures that need them. */
export interface AgentStream {
  feedStdout(chunk: Buffer): void;
  feedStderr(chunk: Buffer): void;
  onLine: (line: string) => void;
  feedCanonical: (text: string, final?: boolean) => void;
  finish: (result: PiRunResult) => void;
  settled: () => boolean;
  stderr: () => string;
  fallbackClone: () => string | undefined;
}

/** Build the streaming pipeline for one spawned run. The coordinator passes the bundle, its
 * watchdogs, the abort wiring, the two logs the flush-at-settle writes, the run's TMPDIR it
 * removes at settle, and the promise's `resolve` — everything the moved closures captured
 * before the refactor — and this call returns the single `AgentStream` the coordinator binds
 * the child's `data` events and the settlement state to. */
export function createAgentStream(input: {
  opts: PiRunOptions;
  backend: AgentBackend;
  spawned: SpawnedRun;
  wd: ReturnType<typeof startPiWatchdogs>;
  onAbort: () => void;
  rawLog: AppendLog;
  nativeLog: AppendLog;
  runTmp: string;
  resolve: (result: PiRunResult) => void;
}): AgentStream {
  const { opts, backend, spawned, wd, onAbort, rawLog, nativeLog, runTmp, resolve } = input;
  const { parser, translator, decoder, stderrDecoder, preSpawnSessionId } = spawned;
  // The stream's mutable state (its own per-run locals, shared by exactly the closures below):
  // the stderr window and its warning matcher tail, the settled guard, and the translator's
  // native-line buffer.
  let stderr = "";
  // The fallback-clone warning arrives at the START of a run, while `stderr` keeps only the
  // last 64 KiB; match each chunk (with a short carried tail for a straddle) so a chatty run
  // that pushes the warning out of that window still surfaces the mispriced id.
  let fallbackClone: string | undefined;
  let stderrTail = "";
  let settled = false;
  // The translator's native line buffer: feed the decoder's text through it and only complete
  // lines reach the translator, whose canonical output feeds the parser (and the raw log).
  // `nativeOverflow` marks a buffered line that passed MAX_NATIVE_LINE_CHARS without a newline:
  // its remainder is skipped to the next newline so it can never be mistaken for an event.
  let nativeTail = "";
  let nativeOverflow = false;

  const onLine = (line: string) => rawLog.stream.write(line + "\n");
  // The translator's session id, once the stream has named it (codex's `thread.started`).
  // The pre-spawn record for a fresh codex run carries the session name; the id it actually
  // ran with is born in the stream, so the first time this returns one the pre-spawn record
  // lacked, append a second ledger record carrying it (same kind, name, cwd and model) — the
  // record a later `exec resume` resumes (design §4 "Sessions").
  let streamMintedSession = false;
  const emitNativeLine = (line: string) => {
    if (!nativeLog.broken) nativeLog.stream.write(line + "\n");
    for (const canonical of translator.translate(line)) parser.feed(canonical + "\n", onLine);
    const sid = translator.sessionId?.();
    if (sid !== undefined && sid !== preSpawnSessionId && !streamMintedSession) {
      streamMintedSession = true;
      recordSession(opts.sessionDir, {
        agent: backend.id,
        id: sid,
        kind: opts.kind,
        name: opts.sessionName,
        cwd: opts.cwd,
        ...(opts.config.model !== undefined ? { model: opts.config.model } : {}),
        at: Date.now(),
      });
    }
  };
  // Split native stdout into complete lines, translate each, and feed the canonical lines to
  // the parser (which also hands them to onLine for the raw log). A trailing partial native
  // line stays buffered exactly as the parser's own buffer once held it. On the final flush
  // (`final`), a remaining tail is emitted as one line: a backend may close after flushing a
  // complete JSON event but not its newline terminator, and dropping that tail loses the
  // run's authoritative result (cost, final text). A genuinely truncated fragment parses as
  // no data (parseJsonObject → []), so this can only recover the last event.
  const feedCanonical = (text: string, final = false) => {
    // A buffered overflow: discard this line's remainder up to (and including) its newline, so
    // the stream resynchronizes on the next real event line instead of emitting a truncated one.
    if (nativeOverflow) {
      const nl = text.indexOf("\n");
      if (nl < 0) return;
      nativeOverflow = false;
      text = text.slice(nl + 1);
    }
    nativeTail += text;
    let start = 0;
    for (;;) {
      const nl = nativeTail.indexOf("\n", start);
      if (nl < 0) break;
      emitNativeLine(nativeTail.slice(start, nl));
      start = nl + 1;
    }
    if (start > 0) nativeTail = nativeTail.slice(start);
    if (nativeTail.length > MAX_NATIVE_LINE_CHARS) {
      // No newline within the cap: drop the line and warn. On the final flush there is no
      // remainder to skip, so only the buffer is cleared.
      nativeTail = "";
      if (!final) {
        nativeOverflow = true;
        opts.onAgentWarning?.(
          `native output line exceeded ${MAX_NATIVE_LINE_CHARS / (1024 * 1024)} MiB without a newline and was discarded`,
        );
      }
    } else if (final && nativeTail !== "") {
      emitNativeLine(nativeTail);
      nativeTail = "";
    }
  };

  const feedStdout = (chunk: Buffer) => {
    wd.noteByte();
    feedCanonical(decoder.write(chunk));
  };
  const feedStderr = (chunk: Buffer) => {
    // stderr is rare and meaningful (crash traces, warnings): treat it as progress.
    wd.noteStderr();
    const text = stderrDecoder.write(chunk);
    fallbackClone ??= backend.matchStderrWarning?.(text, stderrTail);
    stderrTail = (stderrTail + text).slice(-STDERR_MATCH_TAIL);
    stderr += text;
    if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
  };

  const finish = (result: PiRunResult) => {
    if (settled) return;
    settled = true;
    // A blind image read (plans/image-input.md "Detecting a blind read"): surface it to the
    // caller once, at settle, with the action its kind earned — the authoring run was killed
    // ("fail"), a gate run only recorded it ("logged"). The caller logs the image_blind event
    // with its own role/run context.
    if (parser.imageBlind) {
      opts.onBlindRead?.(parser.imageBlind.path, opts.kind === "author" ? "fail" : "logged");
    }
    // Best-effort: an unremovable scratch dir (read-only subdir, a straggler still writing) must
    // not throw out of the close handler before the run's result resolves.
    try {
      removeTree(runTmp);
    } catch {
      /* left for the OS temp sweep */
    }
    wd.stop();
    opts.signal?.removeEventListener("abort", onAbort);
    // Surface the translator's per-run warnings once, after all native lines were fed.
    for (const warning of translator.warnings?.() ?? []) opts.onAgentWarning?.(warning);
    // Resolve only once the logs have flushed: writes complete on libuv's threadpool, so
    // resolving before 'finish' can leave the tail of <role>.pi.jsonl (or the native log)
    // unwritten — a run that dies right after runAgent settles (an abort during a restart
    // drain, a supervisor swap) loses its last lines. end()'s callback fires on 'finish';
    // if a stream errors instead it never does, so settle from 'error' too — a broken log
    // degrades to a lost log, never a stuck run.
    let resolved = false;
    const settle = () => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };
    let pending = 0;
    const flushed = () => {
      pending -= 1;
      if (pending === 0) settle();
    };
    for (const log of [rawLog, nativeLog]) {
      log.stream.on("error", settle);
      if (!log.broken) {
        pending += 1;
        log.stream.end(flushed);
      }
    }
    if (pending === 0) settle();
  };

  return {
    feedStdout,
    feedStderr,
    onLine,
    feedCanonical,
    finish,
    settled: () => settled,
    stderr: () => stderr,
    fallbackClone: () => fallbackClone,
  };
}
