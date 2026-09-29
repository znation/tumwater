import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { TumwaterConfig } from "./config-schema.js";
import { ensureDir, ensureParentDir, rotateIfLarge } from "./files.js";
import { agentBinSourceLabel, resolveAgentBin, type ResolvedAgentBin } from "./readiness.js";
import { terminateChild, withoutLaunchServicesCheckIn } from "./process.js";
import { PiStreamParser, type BackendFailureKind } from "./pi-stream.js";
export type { BackendFailureKind } from "./pi-stream.js";

/** True when the command's stdout cannot reach pi live while the command runs, so a stretch of
 * silence carries no hang signal and the stall warning would be a false alarm. Two shapes do
 * this: a pipe (`npm test 2>&1 | tail -8`) holds every byte in the pipeline until the upstream
 * command exits, and a stdout redirect (`npm test > /tmp/out`) sends the bytes to a file
 * instead of pi's pipe. Both are shapes the tick prompt itself prescribes for verification
 * runs, so the stall detector must not read their silence as a stall. A bare `2>&1` is NOT
 * such a shape: it points stderr at stdout's destination — pi's live pipe — so output still
 * streams and a hang stays detectable. `2>` and `2>>` likewise leave or append only stderr.
 * The classifier scans the command text and errs toward "buffered" on shapes it cannot
 * parse — a skipped warning for `echo "a > b"` costs far less than the cry-wolf the false
 * alarms cause. Exported for tests. */
export function commandBuffersOutput(command: string): boolean {
  if (command.includes("|")) return true; // a pipeline stage buffers until its upstream exits
  for (let i = 0; i < command.length; i++) {
    if (command[i] !== ">") continue;
    const prev = i > 0 ? command[i - 1] : "";
    if (command[i + 1] === ">") {
      // `>>` appends to a file: stdout leaves the pipe unless an fd names stderr (`2>>`).
      // The pair is one operator — when `2>>` leaves stdout live, skip past its second `>`
      // so the scan does not re-read it as a fresh stdout redirect.
      if (prev !== "2") return true;
      i += 1;
      continue;
    }
    if (prev === "2") continue; // `2>` / `2>&1`: stderr leaves or dups, stdout still streams
    if (prev === "&") return true; // `&>`: both streams leave the pipe
    if (command.slice(i + 1, i + 3) === "&1") continue; // `>&1` dups stdout onto itself
    return true; // `>` / `>&` / `<>`: stdout's destination is no longer pi's pipe
  }
  return false;
}

/** pi crashing on malformed JSON, as Node's JSON.parse phrases it on pi's stderr — five ticks in
 * the first 18 days died this way (one of them 2 h 39 m of director work on a fresh steering
 * prompt), each traced to a torn chunk from the model server rather than to the session. Matched
 * against the child's stderr at exit; exported for tests. */
export const TRANSIENT_PI_CRASH =
  /Unexpected end of JSON input|is not valid JSON|(Unterminated string|Unexpected non-whitespace|Expected ('|")|Bad (control|escaped) character)[^\n]* in JSON/;

/** Distilled result of one pi run. */
export interface PiRunResult {
  ok: boolean;
  /** Text of the last assistant message. */
  finalText: string;
  /** True when any assistant message in the run declared nothing-to-do (the sentinel).
   * Covers the whole reply, not just the last message, so a sentinel emitted in an
   * intermediate turn is not lost to a later closing remark. */
  nothingToDo: boolean;
  /** True when any assistant message carried the TUMWATER_REFUSED sentinel — the run declined
   * its task (see plans/refusal-and-thrash.md). Same whole-reply scan as nothingToDo. */
  refused: boolean;
  /** The one-line reason captured from the first TUMWATER_REFUSED line; empty/undefined when
   * the sentinel appeared without a reason. */
  refusedReason?: string;
  /** Text of the LAST assistant message carrying a parseable VERDICT line — the review
   * gate's reply contract (see buildReviewPrompt). Scanned across every message like the
   * sentinel, so a verdict in an intermediate turn survives later closing remarks. */
  verdictText?: string;
  /** Tokens the model generated in this run (usage.output summed across turns). */
  outputTokens: number;
  /** Largest single-request context of the run. */
  peakContextTokens: number;
  /** Assistant turns completed in this run (message_end events) — feeds the commit trailer
   * and the high-friction flag; a tick sums it across its pre-commit runs. */
  turns: number;
  costUsd: number;
  stopReason?: string;
  errorMessage?: string;
  timedOut: boolean;
  /** The tick timeout fired on a run that was still making progress — a real progress event
   * within the last quietTimeoutSeconds. A slow run, not a hung one: the loop preserves its
   * session and worktree edits and resumes it like a quiet kill instead of discarding them
   * (BUGS.md 2026-09-29). Never true without timedOut. */
  timedOutProgressing: boolean;
  /** The run was killed because the harness is shutting down. */
  aborted: boolean;
  /** The run was killed by the quiet watchdog: no pi progress for over quietTimeoutSeconds —
   * typically one hung tool call (a command waiting on input or scanning far more than
   * intended), not a slow run. Distinct from timedOut (the whole-run tick budget): the session
   * and any worktree edits are intact, so the loop resumes them promptly instead of discarding.
   */
  quietKilled: boolean;
  /** The provider rejected the context as too large. With fresh-per-tick sessions this is
   * purely diagnostic: the next tick starts a new session regardless. */
  contextExceeded: boolean;
  /** True when any event reported the model server killing an idle predict stream (LM
   * Studio's "Engine protocol predict stream timed out", e.g. after OS sleep). A transient
   * failure of the world, not of the session: one fresh retry usually succeeds. */
  transientServerTimeout: boolean;
  /** True when pi itself crashed on malformed JSON — its stderr ends in a JSON.parse failure
   * ("Unterminated string in JSON at position N", "Expected ',' or '}' …") — which in observed
   * runs came from a torn model-server chunk, never from the session. Like the predict-stream
   * timeout it is a transient failure of the world: the session is intact on disk and one
   * `--continue` retry picks the run up where it stopped instead of losing hours of work. */
  transientPiCrash: boolean;
  /** True when any event reported the provider rejecting the request with HTTP 429 (rate
   * limiting). A transient failure of the world, not of the session — the world saying
   * "later": one retry after retryAfterSeconds usually succeeds, so the loop's transient
   * retry covers it instead of discarding the tick's work. */
  transientRateLimit: boolean;
  /** True when any event reported a provider-wide failure that is not rate limiting — the
   * connection down, a 5xx, the model failing to load (src/pi-stream.ts TRANSIENT_BACKEND).
   * A transient failure of the world like the 429 flag, but with no Retry-After hint to wait
   * out: the fleet-wide hold (src/rate-limit-hold.ts), not the per-run retry, answers it. */
  transientBackend: boolean;
  /** Which kind of backend failure the run ended on (src/pi-stream.ts backendKind's
   * classification) — the fleet-wide hold groups its storms by kind. Undefined when
   * transientBackend is false. */
  backendKind?: BackendFailureKind;
  /** The provider's Retry-After delay (seconds) from the rate-limit error text, when one was
   * sent; undefined otherwise. Caps the loop's wait before the transient retry. */
  retryAfterSeconds?: number;
  /** The run's last assistant message carried no text and no tool call (thinking-only or
   * empty). A compliant finish always ends with a text block, so this signals a generation
   * cut off mid-stream — typically pi clamping max output tokens to the sliver left under
   * the declared context window, with the provider misreporting the truncation as a normal
   * stop. Used to diagnose otherwise-mysterious no-sentinel no_change ticks. */
  finalMessageContentless: boolean;
  /** pi auto-compacted the session during (or at the end of) the run. */
  compacted: boolean;
}

/** Options for one non-interactive pi run (runPi). Exported so a caller that builds the
 * same wiring in several places (loop.ts's author run and SUMMARY follow-up) can share one
 * construction helper typed against this exact shape. */
export interface PiRunOptions {
  cwd: string;
  prompt: string;
  config: TumwaterConfig;
  sessionDir: string;
  sessionName: string;
  /** Resume the most recent session in sessionDir instead of starting fresh. Used ONLY
   * for the within-tick transient retry (so the retry keeps the first attempt's partial
   * progress); every tick otherwise starts a fresh session, so context never accumulates
   * across ticks. */
  continueSession?: boolean;
  /** Raw pi JSON event lines are appended here for observability. */
  rawLogFile: string;
  signal?: AbortSignal;
  /** Label this run in the role's transcript (the review gate passes "review"): one compact
   * marker line is written to the raw log before any of pi's output, so every transcript
   * surface renders a labeled separator for it. No label → no write — author-run logs stay
   * byte-identical to today's shape. */
  label?: string;
  /** Called once per stalled tool call when it has been open with no content-bearing update
   * for config.toolCallStallSeconds: the harness logs a warning event naming the command
   * while the quiet watchdog still counts down (the dashboards derive their own flag from the
   * raw log, so only the event needs wiring). */
  onToolCallStalled?: (message: string) => void;
  /** Called once per tool call as it starts, with pi's tool name and raw args (see
   * PiStreamParser) — the review gate collects its reviewer's calls through this to notice a
   * full-suite re-run the harness's green pre-check made redundant. */
  onToolCallStart?: (toolName: string, args: unknown) => void;
}

/** Path to the bundled bounded-output pi extension, resolved from this module's own
 * location so staged builds (.tumwater/build/<sha>) load their own copy. */
function boundedOutputExtensionPath(): string {
  return fileURLToPath(new URL("./pi-extension/bounded-output.js", import.meta.url));
}

/** Build the pi argv for one tick. Exported for tests. */
export function piArgs(
  opts: Pick<PiRunOptions, "config" | "sessionDir" | "sessionName" | "continueSession"> & {
    /** The resolved agent binary (from resolveAgentBin); defaults to "pi". A non-pi
     * agent gets no `-e` flag — the bundled extension is pi-specific. */
    agentBin?: string;
  },
): string[] {
  const { config } = opts;
  const args = ["--print", "--mode", "json", "--session-dir", opts.sessionDir];
  // Each role has its own session dir, so --continue resumes that role's session.
  if (opts.continueSession) args.push("--continue");
  else args.push("-n", opts.sessionName);
  if (config.provider) args.push("--provider", config.provider);
  if (config.model) args.push("--model", config.model);
  if (config.thinking) args.push("--thinking", config.thinking);
  // Bound oversized tool results in-session (PLANS.md "Bound tool output head+tail with a
  // tumwater pi extension"). Loaded before config.piArgs so a user flag still wins.
  if (path.basename(opts.agentBin ?? "pi") === "pi") {
    args.push("-e", boundedOutputExtensionPath());
  }
  args.push(...config.piArgs);
  return args;
}

/** True when `sessionDir` holds at least one pi session file for --continue to resume.
 * Guards the resume-after-shutdown path: with nothing to resume (sessions pruned, or the
 * aborted run died before pi created one), the tick falls back to a fresh start. */
export function hasResumableSession(sessionDir: string): boolean {
  try {
    return fs.readdirSync(sessionDir).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false; // Missing directory — nothing to resume.
  }
}

/** Prefix of PiRunResult.errorMessage when the pi process never started (no session file
 * is created for such a run). The resolved binary follows it, so a configured agentBin
 * reads "failed to spawn <bin>" rather than blaming an ambient "pi". */
const SPAWN_ERROR_PREFIX = "failed to spawn";

/** The spawn-error message for a resolved binary: the default source keeps today's text
 * ("failed to spawn pi: …"); a configured source names the binary and where it came from,
 * so a wrong agentBin does not read as "pi is broken". */
function spawnErrorMessage(resolved: ResolvedAgentBin, errMessage: string): string {
  const source =
    resolved.source === "default" ? "" : ` (resolved from ${agentBinSourceLabel(resolved.source)})`;
  return `${SPAWN_ERROR_PREFIX} ${resolved.bin}${source}: ${errMessage}`;
}

/** Run pi non-interactively in a worktree and distill the result. Never throws. */
export function runPi(opts: PiRunOptions): Promise<PiRunResult> {
  return new Promise((resolve) => {
    ensureDir(opts.sessionDir);
    ensureParentDir(opts.rawLogFile);
    rotateIfLarge(opts.rawLogFile, opts.config.logMaxBytes);
    const rawLog = fs.createWriteStream(opts.rawLogFile, { flags: "a" });
    // A broken raw log (EACCES, ENOSPC) must not crash the process on an unhandled 'error'
    // nor hang the tick: mark it so finish() resolves without waiting for a 'finish' that
    // will never come — a lost transcript is acceptable, a stuck loop is not.
    let rawLogBroken = false;
    rawLog.on("error", () => {
      rawLogBroken = true;
    });
    if (opts.label) {
      // The marker precedes this run's first pi event in file order — written to the same
      // stream stdout lines flow through, before spawn, so ordering is exact by construction;
      // on a failed spawn finish() still ends the stream and flushes it.
      rawLog.write(JSON.stringify({ type: "tumwater_run", label: opts.label }) + "\n");
    }
    const parser = new PiStreamParser(opts.onToolCallStart);
    // Decode stdout incrementally instead of per chunk: a raw Buffer.toString("utf8")
    // replaces any multi-byte character whose bytes straddle two 'data' events with U+FFFD,
    // corrupting that line's text (commit subjects, summaries, transcripts). StringDecoder
    // holds back the incomplete trailing bytes until the next chunk completes them.
    const decoder = new StringDecoder("utf8");
    let stderr = "";
    let timedOut = false;
    let timedOutProgressing = false;
    let settled = false;

    // plans/portability.md §5/7: the agent binary is configurable. resolveAgentBin
    // normalizes path-shaped values to absolute (against the process cwd), so the spawn —
    // which runs with the worktree as cwd — lands on the same file the preflight checked.
    const resolved = resolveAgentBin(opts.config);
    const child = spawn(resolved.bin, [...piArgs({ ...opts, agentBin: resolved.bin }), opts.prompt], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // pi sets its process title at startup, and so does every npm its tool calls run: on
      // macOS each would register with LaunchServices and leak a launchservicesd port.
      env: withoutLaunchServicesCheckIn(process.env),
      // Detached so pi leads its own process group: terminateChild signals the group, so a
      // run's tool-call grandchildren — killed or finished — die with it instead of leaking
      // to launchd.
      detached: true,
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      // A deadline that fires on a run still making progress killed a slow run, not a hung
      // one: "recent progress" is the same window the quiet watchdog itself honors, so the
      // two watchdogs agree on what a healthy run looks like (BUGS.md 2026-09-29). A run
      // with no progress event at all — never emitted a byte, or bytes without one structured
      // event — keeps today's discard path: it has not demonstrably begun. Callback runs
      // after the sync declarations below, so quietMs/lastProgressAt are initialized here.
      timedOutProgressing = parser.progressCount > 0 && Date.now() - lastProgressAt <= quietMs;
      terminateChild(child);
    }, opts.config.tickTimeoutSeconds * 1000);

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      terminateChild(child);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    // Quiet watchdog: a healthy run makes PROGRESS continuously even when slow — messages
    // start and end, turns and tool calls complete. Prolonged lack of progress means a hung
    // tool (an interactive command waiting for input) or a zombie stream (a dead generation
    // whose connection drips content-free keepalive updates for hours) that would otherwise
    // burn the whole tick timeout. Raw output bytes deliberately do NOT reset the clock:
    // keepalives are bytes without progress. Checked on an interval against the wall clock,
    // so it also fires promptly after a machine sleep rather than pausing with a suspended
    // timer. The stall warning below rides the same interval: it needs no kill of its own,
    // only a periodic look at which open tool calls have gone silent.
    let lastProgressAt = Date.now();
    let lastProgressCount = 0;
    let quietKilled = false;
    const quietMs = opts.config.quietTimeoutSeconds * 1000;
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
    let sawOutput = false;
    const zeroByteSilenceMs = Math.max(quietMs * 2, 30 * 60_000);
    const allowedSilenceMs = () =>
      parser.progressCount > 0 ? quietMs : sawOutput ? quietMs * 2 : zeroByteSilenceMs;
    // The stall warning's threshold (distinct from the kill above): one hung tool call is
    // surfaced by name even while sibling calls keep streaming, so total silence is not
    // required. One warning per stalled call — the interval keeps firing until the kill or
    // the call ends.
    const stallMs = Math.max(0, opts.config.toolCallStallSeconds) * 1000;
    const warnedStalledCalls = new Set<string>();
    const checkEveryMs = quietMs > 0 ? quietMs : stallMs;
    const quietCheck =
      checkEveryMs > 0
        ? setInterval(
            () => {
              if (parser.progressCount > lastProgressCount) {
                lastProgressCount = parser.progressCount;
                lastProgressAt = Date.now();
              } else if (quietMs > 0 && Date.now() - lastProgressAt > allowedSilenceMs()) {
                quietKilled = true;
                terminateChild(child);
              }
              if (stallMs > 0) {
                for (const call of parser.openToolCalls) {
                  if (warnedStalledCalls.has(call.id)) continue;
                  // A command whose stdout is piped or redirected holds its bytes away from
                  // pi until it exits, so "no output" there is the prescribed shape, not
                  // evidence of a hang — warn only when silence could mean something
                  // (BUGS.md 2026-09-28: the tick prompt tells every loop to pipe its
                  // verification through `tail`, and the resulting false alarms were the
                  // digest's top warning cluster, drowning real hangs). The call's full raw
                  // command is classified, never its display label: the label truncates at
                  // 32 chars, so an operator past that point would be invisible there.
                  if (commandBuffersOutput(call.command || call.label)) continue;
                  const silentMs = Date.now() - call.lastActivityAt;
                  if (silentMs >= stallMs) {
                    warnedStalledCalls.add(call.id);
                    // Whole minutes read cleaner in the feed; sub-minute thresholds stay in seconds.
                    const silent =
                      silentMs < 60_000
                        ? `${Math.round(silentMs / 1000)}s`
                        : `${Math.round(silentMs / 60_000)}m`;
                    opts.onToolCallStalled?.(`tool call stalled: ${call.label} — no output for ${silent}`);
                  }
                }
              }
            },
            Math.min(Math.max(checkEveryMs / 2, 250), 30_000),
          )
        : undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      sawOutput = true; // any byte ends the starting phase, progress or not
      parser.feed(decoder.write(chunk), (line) => rawLog.write(line + "\n"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // stderr is rare and meaningful (crash traces, warnings): treat it as progress.
      sawOutput = true;
      lastProgressAt = Date.now();
      stderr += chunk.toString("utf8");
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });

    const finish = (result: PiRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (quietCheck) clearInterval(quietCheck);
      opts.signal?.removeEventListener("abort", onAbort);
      // Resolve only once the raw log has flushed: writes complete on libuv's threadpool, so
      // resolving before 'finish' can leave the tail of <role>.pi.jsonl unwritten — a tick
      // that dies right after runPi settles (an abort during a restart drain, a supervisor
      // swap) loses its last lines, and under load readers see an empty or marker-only file.
      // end()'s callback fires on 'finish'; if the stream errors instead it never does, so
      // settle from 'error' too — a broken raw log degrades to a lost log, never a stuck tick.
      let resolved = false;
      const settle = () => {
        if (!resolved) {
          resolved = true;
          resolve(result);
        }
      };
      rawLog.on("error", settle);
      if (rawLogBroken) settle();
      else rawLog.end(settle);
    };

    // Every PiRunResult is built here from what the parser has seen plus how the run ended,
    // so adding a field to PiRunResult touches this single place. The spawn-error path passes
    // only an errorMessage override: at that point no output ever arrived, so the parser holds
    // exactly its initial values — which is precisely what a failed spawn reports.
    const resultFromParser = (overrides: Partial<PiRunResult>): PiRunResult => ({
      ok: false,
      finalText: parser.finalText,
      nothingToDo: parser.declaredNothingToDo,
      refused: parser.refused,
      refusedReason: parser.refusedReason || undefined,
      verdictText: parser.verdictText || undefined,
      outputTokens: parser.outputTokens,
      peakContextTokens: parser.peakContextTokens,
      turns: parser.turns,
      costUsd: parser.costUsd,
      stopReason: parser.stopReason,
      errorMessage: undefined,
      timedOut: false,
      timedOutProgressing: false,
      quietKilled: false,
      aborted,
      contextExceeded: parser.contextExceeded,
      transientServerTimeout: parser.transientServerTimeout,
      transientRateLimit: parser.transientRateLimit,
      transientBackend: parser.transientBackend,
      backendKind: parser.backendFailureKind,
      retryAfterSeconds: parser.retryAfterSeconds,
      transientPiCrash: false,
      finalMessageContentless: parser.finalMessageContentless,
      compacted: parser.compacted,
      ...overrides,
    });

    child.on("error", (err) => {
      finish(resultFromParser({ errorMessage: spawnErrorMessage(resolved, err.message) }));
    });

    // Sweep the group pi led however the run ended, a normal exit included: pi exits before
    // its orphans — a tool call's `(server &)` or `cd … && server &` is reparented to PID 1 but
    // stays in pi's group — and the harness cannot rely on the model's own cleanup (BUGS.md
    // 2026-09-23: qa's unauthenticated `gui --all-interfaces` listened on the LAN for 7.5 hours
    // after a tick that ended "Everything checked out"). On 'exit', not 'close': pi has just
    // been reaped, so the pgid still names only its group (never reissued while a member
    // lives), and an orphan holding pi's stdio open dies now instead of holding 'close' — and
    // the run — open. Synchronous, so it adds nothing to the run's resolution; on the kill
    // paths it re-sends a SIGTERM the group already had.
    child.on("exit", () => terminateChild(child));

    child.on("close", (code) => {
      // Flush any bytes the decoder held back at stream end so a final line is not lost.
      parser.feed(decoder.end(), (line) => rawLog.write(line + "\n"));
      const failed =
        aborted ||
        timedOut ||
        quietKilled ||
        parser.stopReason === "error" ||
        (code !== 0 && !parser.finalText.trim());
      // A nonzero exit whose stderr ends in a JSON.parse failure is pi dying on a torn server
      // chunk: transient, retryable with --continue (the loop decides). Never set for a run the
      // harness itself killed — those have their own cause.
      const crashed = !aborted && !timedOut && !quietKilled && code !== 0 && TRANSIENT_PI_CRASH.test(stderr);
      finish(
        resultFromParser({
          ok: !failed,
          transientPiCrash: crashed,
          errorMessage: aborted
            ? "aborted by harness shutdown"
            : quietKilled
              ? `killed as hung: no pi progress for over ${opts.config.quietTimeoutSeconds}s`
              : timedOut
                ? timedOutProgressing
                  ? `timed out after ${opts.config.tickTimeoutSeconds}s while still making progress — session and worktree edits preserved for resume`
                  : `timed out after ${opts.config.tickTimeoutSeconds}s`
                : (parser.errorMessage ?? (failed ? stderr.trim().slice(-500) || `pi exited ${code}` : undefined)),
          // Kept distinct on purpose: a hung tool call leaves its session and worktree edits
          // intact, so the loop resumes them (quiet_killed) instead of discarding them as an
          // unfulfilled timeout does. A deadline that fired on a run still making progress
          // gets the same treatment (BUGS.md 2026-09-29).
          timedOut,
          timedOutProgressing: timedOut && timedOutProgressing,
          quietKilled,
        }),
      );
    });
  });
}
