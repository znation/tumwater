/** In-process capture of a CLI command's fail() path: intercept process.exit, stdout, and
 * stderr around a call so a `fail()` branch (exit 1 + a stderr message) and a success return
 * are both assertable without killing the test process or polluting the runner's output. The
 * single home of that stub — it lived as four per-file copies (cli-args, log-commands-views,
 * operator-commands, self-reload) whose shapes drifted independently. Every stub restores the
 * real globals in finally, and each saves the write function it replaces, so nests
 * (captureStdout around an attempt, or vice versa) unwind in LIFO order.
 *
 * SCOPE LIMIT — subprocess-spawning commands must not be captured here. The stub replaces
 * process.stdout.write, the same stream `node --test`'s child mode reports results to the
 * parent over; a capture held across an await that spawns a child process (git, node) lets
 * the runner's report traffic flush inside the stub window and discards it, so
 * `node --test file.js` counts fewer tests than ran (observed 2026-09-29: 15 ran, 1 counted)
 * while failures still surface — silently corrupting the suite's accounting, which the
 * harness's build gate trusts. A finally-guarded restore does not help: the loss happens
 * mid-window, not at teardown. Verified safe: pure in-process awaits (the log-view commands,
 * which only read files). Verified broken: cmdInit (spawns git). Test the spawning commands
 * through the CLI child process instead — runCli/spawnCli from test/cli-harness.ts, as
 * test/cli.test.ts does — where capture is the child's own pipe and costs nothing. */
import assert from "node:assert/strict";

/** Sentinel thrown by the process.exit stub so the exit is catchable in-process. */
export class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/** What one captured call produced: either the fail() path (exit code + captured streams) or
 * the call's return value — both carrying whatever the call wrote to stdout/stderr. */
export type Outcome<T> =
  | { exited: true; code: number; stdout: string; stderr: string }
  | { exited: false; value: T; stdout: string; stderr: string };

/** Install the exit + stream stubs and return the captured-so-far streams plus the restore
 * step; the two attempt variants below share it. */
function stubIo(): {
  read: () => { stdout: string; stderr: string };
  restore: () => void;
} {
  const realExit = process.exit;
  const stdout = process.stdout as unknown as { write: (s: string) => boolean };
  const stderr = process.stderr as unknown as { write: (s: string) => boolean };
  const realOutWrite = stdout.write;
  const realErrWrite = stderr.write;
  let out = "";
  let err = "";
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as typeof process.exit;
  stdout.write = (s: string) => ((out += s), true);
  stderr.write = (s: string) => ((err += s), true);
  return {
    read: () => ({ stdout: out, stderr: err }),
    restore: () => {
      process.exit = realExit;
      stdout.write = realOutWrite;
      stderr.write = realErrWrite;
    },
  };
}

/** Run a synchronous fn under the stubs. */
export function attempt<T>(fn: () => T): Outcome<T> {
  const io = stubIo();
  try {
    return { exited: false, value: fn(), ...io.read() };
  } catch (err) {
    if (err instanceof ExitError) return { exited: true, code: err.code, ...io.read() };
    throw err;
  } finally {
    io.restore();
  }
}

/** Run an async fn under the stubs — the stubs are installed before the call and held across
 * every await, so output written after an await is captured too. */
export async function attemptAsync<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  const io = stubIo();
  try {
    return { exited: false, value: await fn(), ...io.read() };
  } catch (err) {
    if (err instanceof ExitError) return { exited: true, code: err.code, ...io.read() };
    throw err;
  } finally {
    io.restore();
  }
}

/** Assert fn fails via fail(): exit code 1 and the captured stderr message. */
export function expectFail(fn: () => unknown): { code: number; stderr: string } {
  const out = attempt(fn);
  if (!out.exited) assert.fail(`expected process.exit, but the call returned ${JSON.stringify(out.value)}`);
  return { code: out.code, stderr: out.stderr };
}

/** Assert fn succeeds (no fail): its return value. */
export function expectOk<T>(fn: () => T): T {
  const out = attempt(fn);
  if (out.exited) assert.fail(`expected success, but process.exit(${out.code}) with:\n${out.stderr}`);
  return out.value;
}

/** The attemptAsync twin of expectFail: asserts the exit code is 1 and returns the stderr. */
export async function expectFailAsync(fn: () => Promise<unknown>): Promise<string> {
  const out = await attemptAsync(fn);
  if (!out.exited) assert.fail(`expected process.exit, but the call returned normally`);
  assert.equal(out.code, 1);
  return out.stderr;
}

/** The attemptAsync twin of expectOk: asserts the call returned (no fail() fired) and returns
 * the captured streams alongside the value. The one home of the run-once capture dance —
 * install the stubs, await the command, restore — so a success-path test needs no hand-rolled
 * captureStdout try/finally block, and an unexpected fail() reports its stderr instead of
 * masquerading as an empty-output assertion failure. */
export async function expectOkAsync<T>(fn: () => Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
  const out = await attemptAsync(fn);
  if (out.exited) assert.fail(`expected success, but process.exit(${out.code}) with:\n${out.stderr}`);
  return out;
}

/** Intercept process.stdout.write for the duration of a test; restore() must run in finally.
 * For tests that read the output MID-flight or hold a capture across several awaited steps
 * (log-commands.test.ts drives a never-resolving follow this way) — a run-once
 * call-then-assert belongs to expectOkAsync/attemptAsync above, which own the restore. */
export function captureStdout(): { out: () => string; restore: () => void } {
  const stdout = process.stdout as unknown as { write: (s: string) => boolean };
  const real = stdout.write;
  let out = "";
  stdout.write = (s: string) => ((out += s), true);
  return { out: () => out, restore: () => (stdout.write = real) };
}
