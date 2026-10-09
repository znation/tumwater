/** CLI binary scaffolding: the CLI is tested as a child process, and this is the one home for
 * running it. Split out of the old util.ts grab-bag (now dissolved into repo-fixtures.ts,
 * fake-pi.ts, wait.ts and friends) so the spawn-and-capture machinery (run-to-completion,
 * streaming spawn, exit waits) sits beside itself instead of in a shared grab-bag. */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SUPERVISED_ENV } from "../../src/process/supervisor.js";
import { childEnv } from "../../src/process/process.js";
import { exitWithOwnerEnv } from "../fixtures/victim-fixture.js";

// The CLI runs main() on import and reports failures via process.exit, so it is
// tested as a child process: the built dist/src/cli.js with cwd set to a temp repo.
export const CLI = fileURLToPath(new URL("../../src/cli.js", import.meta.url));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI with an explicit env override (merged over process.env). The timeout
 * bounds tests that would otherwise hang if a command regresses to not exiting. */
export function cliWithEnv(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<CliResult> {
  const merged = childEnv(env);
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

/** Run the CLI and bridge CliResult to the { code, out } shape the report/backlog-style
 * assertions match against: combined stdout+stderr, since those commands' failures may
 * surface on either stream. Lives here so every test bridges the same way. */
export function runCli(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return cli(cwd, ...args).then((r) => ({ code: r.code, out: r.stdout + r.stderr }));
}

interface SpawnedCli {
  out: () => string;
  /** Resolves once `pred` matches the captured stdout; fails the test with the output on timeout.
   * `ms` is a deadline, not a sleep (wait.ts's waitFor): 60 s by default, because a cold CLI
   * start under fleet load ran past the old 10 s default (cli-gui's banner wait at 10.1 s,
   * BUGS.md 2026-09-30). The deadline is measured on performance.now(), not Date.now(), for the
   * same reason wait.ts's waitFor is: a wall-clock jump (a host sleep) must not spend a readiness
   * budget a printed-nothing child has not used (BUGS.md 2026-10-07). */
  waitFor(pred: (out: string) => boolean, what: string, ms?: number): Promise<void>;
  kill(): void;
}

/** How long kill() lets the graceful stop run before the group SIGKILL: long enough for the
 * supervisor to forward SIGTERM and the fleet's stop path to finish against the fake shims —
 * under full-suite load too, where the same stop that takes ~1 s alone ran past a 3 s grace
 * and the early SIGKILL killed the supervisor mid-shutdown, turning its clean exit 0 into a
 * signal death the teardown test reads as exit code null (BUGS.md 2026-09-30) — and short
 * enough that a wedged stop cannot hang a test file. Matches the SIGTERM → SIGKILL escalation
 * grace the product itself uses (KILL_GRACE_MS in src/process/process-group.ts). */
const KILL_GRACE_MS = 10_000;

export function spawnCli(cwd: string, args: string[]): { child: ChildProcess } & SpawnedCli {
  const env = { ...process.env };
  delete env[SUPERVISED_ENV]; // same hermeticity as cliWithEnv: `run` must take the supervisor path
  // detached so the child leads its own process group: kill()'s fallback can then signal the
  // whole tree, including the stdio-inherited orchestrator generation a `run` starts below the
  // supervisor (BUGS.md 2026-09-30).
  // Owned (exitWithOwnerEnv): gui, logs -f and run idle until kill() reaps them, so a test
  // process killed before its finally would otherwise leave the whole tree at PPID 1.
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env: exitWithOwnerEnv(env), detached: true });
  let buffer = "";
  child.stdout?.on("data", (d) => (buffer += d));
  return {
    child,
    out: () => buffer,
    waitFor(pred, what, ms = 60_000) {
      return new Promise((resolve, reject) => {
        const started = performance.now();
        const timer = setInterval(() => {
          if (pred(buffer)) {
            clearInterval(timer);
            resolve();
          } else if (performance.now() - started > ms) {
            clearInterval(timer);
            reject(new Error(`timed out waiting for ${what}; output so far:\n${buffer}`));
          }
        }, 100);
      });
    },
    kill: () => {
      const groupKill = (): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group is already gone.
        }
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        groupKill(); // already exited; sweep the group in case something outlived it
        return;
      }
      // SIGTERM first: the supervisor forwards it and the fleet takes the graceful stop path,
      // and a command with no grandchild (gui, logs -f) dies on the default disposition. Only
      // SIGKILLing the supervisor alone left that generation running on the test's own pipes,
      // so the file never exited (BUGS.md 2026-09-30).
      try {
        child.kill("SIGTERM");
      } catch {
        groupKill();
        return;
      }
      const t = setTimeout(() => {
        // A close that raced this callback means the graceful stop finished: sweeping then
        // would only convert the supervisor's clean exit into a signal death.
        if (child.exitCode !== null || child.signalCode !== null) return;
        groupKill();
      }, KILL_GRACE_MS);
      child.once("close", () => clearTimeout(t));
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
