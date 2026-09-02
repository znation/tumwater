import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { TumwaterConfig, PiRunResult } from "./types.js";
import { ensureDir, ensureParentDir, rotateIfLarge } from "./files.js";
import { extractRefusal, hasVerdictLine, isNothingToDo, REFUSED_SENTINEL } from "./reply-contract.js";

interface PiMessage {
  role: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: { totalTokens?: number; output?: number; cost?: { total?: number } };
  stopReason?: string;
  errorMessage?: string;
}

/** Extract the concatenated text blocks of a pi message. */
function messageText(msg: PiMessage): string {
  return (msg.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/** Context-overflow errors often surface only in retry events, not the final message,
 * so feedLine matches this against every error text it sees. Stateless (no `g` flag), so
 * one shared instance is safe for repeated .test() calls.
 * Module-private: only PiStreamParser.feedLine below matches against it. */
const CONTEXT_ERROR = /context (size|length|window)?\s*(has been |was )?exceeded|exceeds? (the )?context|too (long|large) for .*context/i;

/** LM Studio kills predict streams idle >600 s (e.g. the machine slept mid-run) and reports
 * it back through pi as a server error on an assistant message. Fresh requests succeed
 * within seconds of a wake, so this is retryable — unlike every other error class.
 * Module-private: only PiStreamParser.feedLine below matches against it. */
const TRANSIENT_SERVER_TIMEOUT = /predict stream timed out/i;

/** Accumulates pi's JSON event stream into a PiRunResult. Exported for tests. */
export class PiStreamParser {
  finalText = "";
  /** True once any assistant message contains the nothing-to-do sentinel, so a
   * declaration in an intermediate turn survives later messages overwriting finalText. */
  declaredNothingToDo = false;
  /** True once any assistant message carries the TUMWATER_REFUSED sentinel — same whole-reply
   * scan as the nothing-to-do sentinel (a refusal declared in an intermediate turn must
   * survive later closing remarks). */
  refused = false;
  /** The one-line reason from the FIRST parseable TUMWATER_REFUSED line; "" when the sentinel
   * appeared bare or no message carried a reason. */
  refusedReason = "";
  /** Text of the LAST assistant message carrying a parseable VERDICT line (the review gate's
   * reply contract) — scanned across every message like the sentinel, so a verdict emitted in
   * an intermediate turn survives later closing remarks overwriting finalText. */
  verdictText = "";
  /** Assistant turns completed (message_end events) — feeds PiRunResult.turns, which the
   * commit trailer and the high-friction flag read. */
  turns = 0;
  /** Tokens the model actually generated (usage.output summed across turns). */
  outputTokens = 0;
  /** Largest single-request context seen (usage.totalTokens is the request's whole
   * context, so summing it across turns hugely overstates real consumption). */
  peakContextTokens = 0;
  costUsd = 0;
  stopReason: string | undefined;
  errorMessage: string | undefined;
  /** True when any event reports the provider rejecting the context as too large
   * (e.g. LM Studio's "Context size has been exceeded"). Diagnostic: every tick starts a
   * fresh session, so nothing needs dropping — but the error names the real cause. */
  contextExceeded = false;
  /** True when any event reports the model server killing an idle predict stream
   * (LM Studio's "Engine protocol predict stream timed out", e.g. after OS sleep).
   * Transient: the session is healthy and a fresh attempt usually succeeds. */
  transientServerTimeout = false;
  /** True when the run's LAST assistant message carried no text and no tool call
   * (thinking-only or empty). A compliant finish always ends with a text block (the
   * SUMMARY/sentinel line), so this signals a generation cut off mid-stream — typically
   * pi clamping max output tokens to the sliver left under the declared context window,
   * with the provider misreporting the truncation as a normal stop (LM Studio's
   * /v1/responses reports status "completed" instead of "incomplete"). */
  finalMessageContentless = false;
  /** True when pi auto-compacted the session during (or at the end of) the run. */
  compacted = false;
  /** Incremented for every parsed event that represents real forward progress. A
   * message_update counts only when its streamed content actually GREW — zombie streams
   * (a dead generation whose connection stays open) drip content-free keepalive updates
   * for hours, and those must not reset the harness's hang watchdog. */
  progressCount = 0;
  private updateContentHighWater = 0;
  private buffer = "";

  feed(chunk: string, onLine?: (line: string) => void): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      onLine?.(line);
      this.feedLine(line);
    }
  }

  private feedLine(line: string): void {
    let event: { type?: string; message?: PiMessage; errorMessage?: string; finalError?: string };
    try {
      event = JSON.parse(line);
    } catch {
      return; // Non-JSON noise on stdout; ignore.
    }
    for (const text of [event.errorMessage, event.finalError, event.message?.errorMessage]) {
      if (!text) continue;
      if (CONTEXT_ERROR.test(text)) this.contextExceeded = true;
      // Kept narrow on purpose: a false positive would mask real repeated failures from
      // the session-poisoning heuristic and trigger needless retries.
      if (TRANSIENT_SERVER_TIMEOUT.test(text)) this.transientServerTimeout = true;
    }
    if (event.type === "message_update") {
      // Progress only when the streamed message got longer (content chars or tokens).
      const msg = event.message;
      let chars = 0;
      for (const c of (msg?.content ?? []) as Array<Record<string, unknown>>) {
        for (const key of ["text", "thinking"]) {
          const v = c[key];
          if (typeof v === "string") chars += v.length;
        }
      }
      const grew = chars + (msg?.usage?.totalTokens ?? 0);
      if (grew > this.updateContentHighWater) {
        this.updateContentHighWater = grew;
        this.progressCount += 1;
      }
      return;
    }
    // Every other structured event (turn/tool/message boundaries, retries, session) is
    // real progress; the high-water mark resets so the next message streams from zero.
    this.progressCount += 1;
    this.updateContentHighWater = 0;
    if (event.type === "compaction_start") this.compacted = true;
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    const msg = event.message;
    const text = messageText(msg);
    this.finalMessageContentless = !(msg.content ?? []).some(
      (c) => c.type === "toolCall" || (c.type === "text" && Boolean(c.text?.trim())),
    );
    if (text.trim()) this.finalText = text;
    if (isNothingToDo(text)) this.declaredNothingToDo = true;
    if (text.includes(REFUSED_SENTINEL)) {
      this.refused = true;
      // First reason wins: a compliant run emits the sentinel once, in its final message.
      if (!this.refusedReason) this.refusedReason = extractRefusal(text) ?? "";
    }
    if (hasVerdictLine(text)) this.verdictText = text;
    this.turns += 1;
    this.outputTokens += msg.usage?.output ?? 0;
    this.peakContextTokens = Math.max(this.peakContextTokens, msg.usage?.totalTokens ?? 0);
    this.costUsd += msg.usage?.cost?.total ?? 0;
    this.stopReason = msg.stopReason;
    if (msg.errorMessage) this.errorMessage = msg.errorMessage;
    else if (msg.stopReason !== "error") this.errorMessage = undefined;
  }
}

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
}

/** Build the pi argv for one tick. Exported for tests. */
export function piArgs(
  opts: Pick<PiRunOptions, "config" | "sessionDir" | "sessionName" | "continueSession">,
): string[] {
  const { config } = opts;
  const args = ["--print", "--mode", "json", "--session-dir", opts.sessionDir];
  // Each role has its own session dir, so --continue resumes that role's session.
  if (opts.continueSession) args.push("--continue");
  else args.push("-n", opts.sessionName);
  if (config.provider) args.push("--provider", config.provider);
  if (config.model) args.push("--model", config.model);
  if (config.thinking) args.push("--thinking", config.thinking);
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

/** Terminate a pi child: SIGTERM now, escalating to SIGKILL after 10 s if it is still
 * alive. The escalation timer is unref'd so a clean exit does not keep the harness process
 * alive. Shared by the tick-timeout and harness-shutdown paths. */
function terminateChild(child: ChildProcess): void {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
}

/** Prefix of PiRunResult.errorMessage when the pi process never started (no session file
 * is created for such a run). */
const SPAWN_ERROR_PREFIX = "failed to spawn pi";

/** Run pi non-interactively in a worktree and distill the result. Never throws. */
export function runPi(opts: PiRunOptions): Promise<PiRunResult> {
  return new Promise((resolve) => {
    ensureDir(opts.sessionDir);
    ensureParentDir(opts.rawLogFile);
    rotateIfLarge(opts.rawLogFile, opts.config.logMaxBytes);
    const rawLog = fs.createWriteStream(opts.rawLogFile, { flags: "a" });
    const parser = new PiStreamParser();
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn("pi", [...piArgs(opts), opts.prompt], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, opts.config.tickTimeoutSeconds * 1000);

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      terminateChild(child);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    // Quiet watchdog: a healthy run makes PROGRESS continuously even when slow — streamed
    // content grows, turns and tool calls complete. Prolonged lack of progress means a hung
    // tool (an interactive command waiting for input) or a zombie stream (a dead generation
    // whose connection drips content-free keepalive updates for hours) that would otherwise
    // burn the whole tick timeout. Raw output bytes deliberately do NOT reset the clock:
    // keepalives are bytes without progress. Checked on an interval against the wall clock,
    // so it also fires promptly after a machine sleep rather than pausing with a suspended
    // timer.
    let lastProgressAt = Date.now();
    let lastProgressCount = 0;
    let quietKilled = false;
    const quietMs = opts.config.quietTimeoutSeconds * 1000;
    const quietCheck =
      quietMs > 0
        ? setInterval(
            () => {
              if (parser.progressCount > lastProgressCount) {
                lastProgressCount = parser.progressCount;
                lastProgressAt = Date.now();
              } else if (Date.now() - lastProgressAt > quietMs) {
                quietKilled = true;
                terminateChild(child);
              }
            },
            Math.min(Math.max(quietMs / 2, 250), 30_000),
          )
        : undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      parser.feed(chunk.toString("utf8"), (line) => rawLog.write(line + "\n"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // stderr is rare and meaningful (crash traces, warnings): treat it as progress.
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
      rawLog.end();
      resolve(result);
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
      aborted,
      contextExceeded: parser.contextExceeded,
      transientServerTimeout: parser.transientServerTimeout,
      finalMessageContentless: parser.finalMessageContentless,
      compacted: parser.compacted,
      ...overrides,
    });

    child.on("error", (err) => {
      finish(resultFromParser({ errorMessage: `${SPAWN_ERROR_PREFIX}: ${err.message}` }));
    });

    child.on("close", (code) => {
      const failed =
        aborted ||
        timedOut ||
        quietKilled ||
        parser.stopReason === "error" ||
        (code !== 0 && !parser.finalText.trim());
      finish(
        resultFromParser({
          ok: !failed,
          errorMessage: aborted
            ? "aborted by harness shutdown"
            : quietKilled
              ? `killed as hung: no pi progress for over ${opts.config.quietTimeoutSeconds}s`
              : timedOut
                ? `timed out after ${opts.config.tickTimeoutSeconds}s`
                : (parser.errorMessage ?? (failed ? stderr.trim().slice(-500) || `pi exited ${code}` : undefined)),
          timedOut: timedOut || quietKilled,
        }),
      );
    });
  });
}
