import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AutomatonConfig, PiRunResult } from "./types.js";
import { rotateIfLarge } from "./events.js";

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
  totalTokens = 0;
  costUsd = 0;
  stopReason: string | undefined;
  errorMessage: string | undefined;
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
    let event: { type?: string; message?: PiMessage };
    try {
      event = JSON.parse(line);
    } catch {
      return; // Non-JSON noise on stdout; ignore.
    }
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    const msg = event.message;
    const text = messageText(msg);
    if (text.trim()) this.finalText = text;
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
  config: AutomatonConfig;
  sessionDir: string;
  sessionName: string;
  /** Raw pi JSON event lines are appended here for observability. */
  rawLogFile: string;
  signal?: AbortSignal;
}

/** Build the pi argv for one tick. Exported for tests. */
export function piArgs(opts: Pick<PiRunOptions, "config" | "sessionDir" | "sessionName">): string[] {
  const { config } = opts;
  const args = ["--print", "--mode", "json", "--session-dir", opts.sessionDir, "-n", opts.sessionName];
  if (config.provider) args.push("--provider", config.provider);
  if (config.model) args.push("--model", config.model);
  if (config.thinking) args.push("--thinking", config.thinking);
  args.push(...config.piArgs);
  return args;
}

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
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, opts.config.tickTimeoutSeconds * 1000);

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => {
      parser.feed(chunk.toString("utf8"), (line) => rawLog.write(line + "\n"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });

    const finish = (result: PiRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
      rawLog.end();
      resolve(result);
    };

    child.on("error", (err) => {
      finish({
        ok: false,
        finalText: "",
        totalTokens: 0,
        costUsd: 0,
        errorMessage: `failed to spawn pi: ${err.message}`,
        timedOut: false,
        aborted,
      });
    });

    child.on("close", (code) => {
      const failed =
        aborted || timedOut || parser.stopReason === "error" || (code !== 0 && !parser.finalText.trim());
      finish({
        ok: !failed,
        finalText: parser.finalText,
        totalTokens: parser.totalTokens,
        costUsd: parser.costUsd,
        stopReason: parser.stopReason,
        errorMessage: aborted
          ? "aborted by harness shutdown"
          : timedOut
            ? `timed out after ${opts.config.tickTimeoutSeconds}s`
            : (parser.errorMessage ?? (failed ? stderr.trim().slice(-500) || `pi exited ${code}` : undefined)),
        timedOut,
        aborted,
      });
    });
  });
}
