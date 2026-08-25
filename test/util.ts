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

/** Create a temp git repo on branch `main` with one commit. */
export function makeRepo(): string {
  const dir = tmpdir();
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

/** A pi JSON line for an assistant message_end that ended in a server error. */
export function errorLine(errorMessage: string): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage },
  });
}
