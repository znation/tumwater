import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tmpdir(prefix = "tumwater-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function sh(cwd: string, cmd: string, ...args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trimEnd();
}

/** Create a git repo on branch `main` with one commit — in a fresh temp dir by default, or at
 * `dir` when the test needs a particular location (e.g. nested under an installed root). */
export function makeRepo(dir = tmpdir()): string {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, "git", "init", "-b", "main");
  sh(dir, "git", "config", "user.name", "test");
  sh(dir, "git", "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  sh(dir, "git", "add", "-A");
  sh(dir, "git", "commit", "-m", "seed");
  return dir;
}

/** Install a fake `pi` executable at the front of PATH for the duration of a test.
 * The script runs with the worktree as cwd. Returns a restore function. */
export function fakePi(script: string): () => void {
  const dir = tmpdir("fake-pi-");
  const bin = path.join(dir, "pi");
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(bin, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  return () => {
    process.env.PATH = oldPath;
  };
}

/** A pi JSON line for an assistant message_end. */
export function assistantLine(
  text: string,
  opts: { tokens?: number; output?: number; cost?: number; stopReason?: string } = {},
): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { totalTokens: opts.tokens ?? 0, output: opts.output ?? 0, cost: { total: opts.cost ?? 0 } },
      stopReason: opts.stopReason ?? "stop",
    },
  });
}

/** A pi JSON line for an assistant message_end whose content is thinking-only — the
 * signature of a generation cut off mid-stream (e.g. output clamped to the sliver left
 * under the declared context window); a compliant finish always ends with a text block. */
export function thinkingOnlyLine(
  thinking: string,
  opts: { tokens?: number; output?: number } = {},
): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking }],
      usage: { totalTokens: opts.tokens ?? 0, output: opts.output ?? 0, cost: { total: 0 } },
      stopReason: "stop",
    },
  });
}

/** A pi JSON line for an assistant message_end that ended in a server error. */
export function errorLine(errorMessage: string): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage },
  });
}

/** A fixed epoch-ms timestamp for transcript fixtures, so run separators render deterministically. */
export const FIXED_TS = 1787222691956;

/** A pi JSON line for an agent_start event — the only event that separates runs in a transcript (src/transcript.ts). */
export function agentStart(): string {
  return JSON.stringify({ type: "agent_start" });
}

/** A pi JSON line for a user message_end (the tick prompt). Its content is never rendered, but its timestamp drives the run separator. */
export function userLine(text: string, timestamp: number = FIXED_TS): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text }], timestamp },
  });
}

/** A pi JSON line for an assistant message_end with arbitrary content blocks (thinking/text/toolCall) and no usage — the richer fixture transcript rendering tests need, in contrast to assistantLine above. */
export function assistantBlocks(content: unknown[]): string {
  return JSON.stringify({ type: "message_end", message: { role: "assistant", content, stopReason: "stop" } });
}
