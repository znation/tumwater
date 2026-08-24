import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TumwaterConfig, PiRunResult } from "./types.js";
import { rotateIfLarge } from "./files.js";
import { isNothingToDo } from "./prompt.js";

interface PiMessage {
  role: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: { totalTokens?: number; cost?: { total?: number } };
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

/** Accumulates pi's JSON event stream into a PiRunResult. Exported for tests. */
export class PiStreamParser {
  finalText = "";
  /** True once any assistant message contains the nothing-to-do sentinel, so a
   * declaration in an intermediate turn survives later messages overwriting finalText. */
  declaredNothingToDo = false;
  totalTokens = 0;
  costUsd = 0;
  stopReason: string | undefined;
  errorMessage: string | undefined;
  /** True when any event reports the provider rejecting the context as too large
   * (e.g. LM Studio's "Context size has been exceeded"). The session is then poisoned:
   * resuming it can never succeed, so the loop must start fresh. */
  contextExceeded = false;
  /** True when any event reports the model server killing an idle predict stream
   * (LM Studio's "Engine protocol predict stream timed out", e.g. after OS sleep).
   * Transient: the session is healthy and a fresh attempt usually succeeds. */
  transientServerTimeout = false;
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
    // Context-overflow errors often surface only in retry events, not the final message.
    const CONTEXT_ERROR = /context (size|length|window)?\s*(has been |was )?exceeded|exceeds? (the )?context|too (long|large) for .*context/i;
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
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    const msg = event.message;
    const text = messageText(msg);
    if (text.trim()) this.finalText = text;
    if (isNothingToDo(text)) this.declaredNothingToDo = true;
    this.totalTokens += msg.usage?.totalTokens ?? 0;
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
  /** Resume the loop's most recent session in sessionDir instead of starting fresh,
   * so context persists across ticks. pi auto-compacts when the context nears the
   * model's window, so a resumed session never overflows. */
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

/** Locate an executable on PATH the same way spawn() would resolve it: a regular file
 * with the execute bit in some PATH directory. Returns its absolute path, or null when
 * missing (or not executable), so callers can fail fast with a clear message instead of
 * letting every tick die with "spawn <name> ENOENT". */
export function findOnPath(name: string, pathEnv: string = process.env.PATH ?? ""): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK); // Directories pass X_OK; require a file.
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory; keep looking.
    }
  }
  return null;
}

/** Terminate a pi child: SIGTERM now, escalating to SIGKILL after 10 s if it is still
 * alive. The escalation timer is unref'd so a clean exit does not keep the harness process
 * alive. Shared by the tick-timeout and harness-shutdown paths. */
function terminateChild(child: ChildProcess): void {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
}

/** Prefix of PiRunResult.errorMessage when the pi process never started; no session file
 * exists then, so callers must not treat the run as having created one. */
export const SPAWN_ERROR_PREFIX = "failed to spawn pi";

/** LM Studio kills predict streams idle >600 s (e.g. the machine slept mid-run) and reports
 * it back through pi as a server error on an assistant message. Fresh requests succeed
 * within seconds of a wake, so this is retryable — unlike every other error class. */
export const TRANSIENT_SERVER_TIMEOUT = /predict stream timed out/i;

/** Run pi non-interactively in a worktree and distill the result. Never throws. */
export function runPi(opts: PiRunOptions): Promise<PiRunResult> {
  return new Promise((resolve) => {
    fs.mkdirSync(opts.sessionDir, { recursive: true });
    fs.mkdirSync(path.dirname(opts.rawLogFile), { recursive: true });
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

    child.on("error", (err) => {
      finish({
        ok: false,
        finalText: "",
        nothingToDo: false,
        totalTokens: 0,
        costUsd: 0,
        errorMessage: `${SPAWN_ERROR_PREFIX}: ${err.message}`,
        timedOut: false,
        aborted,
        contextExceeded: false,
        transientServerTimeout: false,
      });
    });

    child.on("close", (code) => {
      const failed =
        aborted ||
        timedOut ||
        quietKilled ||
        parser.stopReason === "error" ||
        (code !== 0 && !parser.finalText.trim());
      finish({
        ok: !failed,
        finalText: parser.finalText,
        nothingToDo: parser.declaredNothingToDo,
        totalTokens: parser.totalTokens,
        costUsd: parser.costUsd,
        stopReason: parser.stopReason,
        errorMessage: aborted
          ? "aborted by harness shutdown"
          : quietKilled
            ? `killed as hung: no pi progress for over ${opts.config.quietTimeoutSeconds}s`
            : timedOut
              ? `timed out after ${opts.config.tickTimeoutSeconds}s`
              : (parser.errorMessage ?? (failed ? stderr.trim().slice(-500) || `pi exited ${code}` : undefined)),
        timedOut: timedOut || quietKilled,
        aborted,
        contextExceeded: parser.contextExceeded,
        transientServerTimeout: parser.transientServerTimeout,
      });
    });
  });
}
