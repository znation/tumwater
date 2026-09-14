import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, loadConfig } from "../src/config.js";
import { runOrchestrator } from "../src/orchestrator.js";
import type { TumwaterConfig } from "../src/types.js";

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

/** Wrap fs.openSync so the first open of `file` unlinks it instead — simulating a log
 * rotation rename landing between a reader's stat and its open (the race tail readers must
 * survive as "no data", not an ENOENT throw). Returns an undo function. */
export function vanishOnOpen(file: string): () => void {
  const orig = fs.openSync.bind(fs);
  let hit = false;
  (fs as Record<string, unknown>).openSync = (p: unknown, flags: string) => {
    if (!hit && p === file) {
      hit = true;
      fs.unlinkSync(file);
    }
    return (orig as (x: unknown, f: string) => number)(p, flags);
  };
  return () => {
    (fs as Record<string, unknown>).openSync = orig;
  };
}

/** The rotation twin of vanishOnOpen where the path comes back before open: on the first
 * open of `file`, rename the old file away and recreate it with `content` (smaller than the
 * original in every use so far), then open — simulating a rotation rename plus a fresh append
 * landing between a reader's stat and its open. Returns an undo function. */
export function recreateSmallerOnOpen(file: string, content: string): () => void {
  const orig = fs.openSync.bind(fs);
  let hit = false;
  (fs as Record<string, unknown>).openSync = (p: unknown, flags: string) => {
    if (!hit && p === file) {
      hit = true;
      fs.renameSync(file, file + ".1");
      fs.writeFileSync(file, content);
    }
    return (orig as (x: unknown, f: string) => number)(p, flags);
  };
  return () => {
    (fs as Record<string, unknown>).openSync = orig;
  };
}

/** The readFileSync twin of vanishOnOpen — for readers that stat and then read a small file
 * whole. Returns an undo function. */
export function vanishOnReadFile(file: string): () => void {
  const orig = fs.readFileSync.bind(fs);
  let hit = false;
  (fs as Record<string, unknown>).readFileSync = (p: unknown, ...rest: unknown[]) => {
    if (!hit && p === file) {
      hit = true;
      fs.unlinkSync(file);
    }
    return (orig as (x: unknown, ...r: unknown[]) => Buffer)(p, ...rest);
  };
  return () => {
    (fs as Record<string, unknown>).readFileSync = orig;
  };
}

/** A pi JSON line for an assistant message_end. */
export function assistantLine(
  text: string,
  opts: { tokens?: number; output?: number; cost?: number; stopReason?: string } = {},
): string {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { totalTokens: opts.tokens ?? 0, output: opts.output ?? 0, cost: { total: opts.cost ?? 0 } },
    stopReason: opts.stopReason ?? "stop",
  };
  return JSON.stringify({ type: "message_end", message });
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

// --- Live-orchestrator test helpers (shared by orchestrator.test.ts and orchestrator-2.test.ts) ---

/** Poll until fn() is true, failing after ms (default 20s). */
export async function waitFor(fn: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A fake pi that records each run's --provider/--model flags to argsFile and declares
 * nothing-to-do (so no commit happens). */
export function recordingFakePi(argsFile: string): () => void {
  return fakePi(
    [
      `m=""; p=""`,
      `while [ $# -gt 0 ]; do case "$1" in --model) m="$2";; --provider) p="$2";; esac; shift; done`,
      `echo "run: model=$m provider=$p" >> "${argsFile}"`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
}

/** A config where only the given roles tick quickly (no min gap, 1s backoff) so several
 * ticks land within a few poll cycles. */
export function fastConfig(roles: string[], model?: string): TumwaterConfig {
  const c = defaultConfig();
  if (model) c.model = model;
  c.minTickIntervalSeconds = 0;
  c.idleBackoff = { initialSeconds: 1, factor: 1, maxSeconds: 1 };
  for (const id of Object.keys(c.roles)) c.roles[id]!.enabled = roles.includes(id);
  return c;
}

/** Start a live orchestrator on `repo` with the config currently on disk, for tests that
 * drive it while running. Returns its exit promise plus `stop`, which aborts the run and
 * awaits its exit — swallowing shutdown noise so the test's own failure (if any) stays
 * visible; call `stop` from finally after other cleanup (e.g. restoring a fake pi). */
export function startLiveOrchestrator(
  repo: string,
  pollMs?: number,
): { done: Promise<unknown>; stop: () => Promise<void> } {
  const controller = new AbortController();
  const done = runOrchestrator({
    root: repo,
    config: loadConfig(repo),
    mainBranch: "main",
    signal: controller.signal,
    pollMs,
  });
  return {
    done,
    async stop() {
      controller.abort();
      try {
        await done;
      } catch {
        // The test's own failure (if any) takes precedence over shutdown noise.
      }
    },
  };
}

/** Land a commit on main that counts as "work" for need-based prioritization, so deferrable
 * maintenance roles wake and re-tick. Tests that pin scheduling-adjacent behavior (config
 * reloads, resets, gates) use it to keep their maintenance roles ticking — the deferral rule
 * itself is pinned in its own test in orchestrator.test.ts. */
export function landWork(repo: string): void {
  fs.writeFileSync(
    path.join(repo, `work-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`),
    "work\n",
  );
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "tumwater(feature): test work landing");
}
