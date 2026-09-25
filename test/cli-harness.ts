/** CLI binary scaffolding: the CLI is tested as a child process, and this is the one home for
 * running it. Split out of util.ts — which keeps the repo/fake-pi/wait fixture builders — so
 * the spawn-and-capture machinery (run-to-completion, streaming spawn, exit waits) sits beside
 * itself instead of at the bottom of the shared grab-bag. */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SUPERVISED_ENV } from "../src/supervisor.js";

// The CLI runs main() on import and reports failures via process.exit, so it is
// tested as a child process: the built dist/src/cli.js with cwd set to a temp repo.
export const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI with an explicit env override (merged over process.env). The timeout
 * bounds tests that would otherwise hang if a command regresses to not exiting. */
export function cliWithEnv(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<CliResult> {
  const merged = { ...process.env, ...env };
  // Hermeticity: the supervised marker leaks from any tumwater orchestrator into pi's (and
  // this test process') environment; without stripping it, `run` skips its supervisor half.
  delete merged[SUPERVISED_ENV];
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: merged, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

export function cli(cwd: string, ...args: string[]): Promise<CliResult> {
  return cliWithEnv(cwd, {}, args);
}

interface SpawnedCli {
  out: () => string;
  /** Resolves once `pred` matches the captured stdout; fails the test with the output on timeout. */
  waitFor(pred: (out: string) => boolean, what: string, ms?: number): Promise<void>;
  kill(): void;
}

export function spawnCli(cwd: string, args: string[]): { child: ChildProcess } & SpawnedCli {
  const env = { ...process.env };
  delete env[SUPERVISED_ENV]; // same hermeticity as cliWithEnv: `run` must take the supervisor path
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
  let buffer = "";
  child.stdout?.on("data", (d) => (buffer += d));
  return {
    child,
    out: () => buffer,
    waitFor(pred, what, ms = 10_000) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (pred(buffer)) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - started > ms) {
            clearInterval(timer);
            reject(new Error(`timed out waiting for ${what}; output so far:\n${buffer}`));
          }
        }, 100);
      });
    },
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    },
  };
}

/** Wait for the child's exit code; null on timeout so a hung command fails the test instead of hanging it. */
export function exitCode(child: ChildProcess, ms = 15_000): Promise<number | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    child.once("close", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}
