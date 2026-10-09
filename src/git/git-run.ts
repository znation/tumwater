/** The git execution layer: spawning the binary, the error it reports, and the commit
 * identity the harness authors commits with. The query helpers built on top of it (heads,
 * refs, branches, diffs) live in git.ts and its siblings — this module knows git's argv,
 * not the repository's shape. */

import { spawn, type PromiseWithChild } from "node:child_process";
import { findOnPath } from "../files/files.js";
import { realGitFromXcrun } from "./xcrun-git.js";
import { EXEC_MAX_BUFFER, releaseChildHandles, signalTree } from "../process/process.js";
import { KILL_GRACE_MS, armGroupDeadline } from "../process/process-group.js";
import { errorMessage } from "../text/text.js";

/** The wall-clock bound on one git subprocess. Generous enough for a large rebase or diff on
 * a slow disk, but finite: a git wedged on a stuck filesystem or a dead helper otherwise
 * stalls its awaited landing/scheduling path with no bound at all. `runGit`'s optional
 * timeoutMs overrides it — tests drive the deadline down to exercise the timeout; production
 * callers need no override. The SIGTERM → SIGKILL escalation then runs for KILL_GRACE_MS, so
 * one call is bounded at timeoutMs + KILL_GRACE_MS whatever the child does. */
export const GIT_TIMEOUT_MS = 600_000;

/** Identity used for harness-authored commits so ticks work without global git config. */
export const COMMIT_IDENT = [
  "-c",
  "user.name=tumwater",
  "-c",
  "user.email=tumwater@localhost",
];

export class GitError extends Error {
  constructor(
    public args: string[],
    /** The failure's cause text: git's stderr when it printed any, otherwise the underlying
     * spawn error's message — a binary that cannot be started prints no stderr at all. */
    public stderr: string,
    /** git's exit code (a number) — or a spawn errno like "ENOENT" (a string) when the
     * binary itself could not be started, which is what execFile puts in `err.code` then. */
    public code: number | string | undefined,
  ) {
    super(
      `git ${args.join(" ")} failed${code !== undefined ? ` (${code})` : ""}${stderr ? `: ${stderr}` : ""}`,
    );
  }
}

/** The one error every entry point that shells out to git reports when the binary itself is
 * missing from PATH. Without a preflight check, `isGitRepo`'s failed probe reads as "not a
 * git repository (run `git init` first)" — pointing at the wrong fix for a machine with no
 * git installed. Shared by cli.ts and init.ts so their messages cannot drift. */
export const GIT_MISSING_MESSAGE =
  "git not found on PATH — install git first, or add its bin directory to your PATH";

let resolvedGit: string | null | undefined;

/** Wall-clock bound on the one-time macOS `xcrun --find git` probe. Unlike a git command, the
 * probe is a synchronous spawnSync, so a wedged xcrun (an Xcode license prompt, a corrupt
 * developer directory) blocks the whole event loop — no timer or watchdog can run until it
 * returns. A short bound keeps that from freezing the fleet: on timeout the probe reads as
 * "no answer" and the harness spawns `git` by name, exactly as a machine without the stub
 * does. */
const GIT_RESOLVE_TIMEOUT_MS = 10_000;

/** The git binary the harness spawns, resolved once per process. On macOS the first git on PATH is
 * routinely /usr/bin/git — the xcode-select stub, which re-resolves the developer directory on
 * every exec before running the real binary (the same cost test/test-runner.ts's suiteEnv already
 * keeps out of the suite). Resolving the real binary once and spawning it by absolute path cuts
 * that per-spawn tax from every harness git call without changing what any command does: the same
 * binary ends up executing the same argv. Any other first git — Linux, Homebrew — spawns by name
 * exactly as before, and a machine with no git at all keeps the "git" name so the spawn still fails
 * ENOENT and GIT_MISSING_MESSAGE still applies. Resolution caches the found absolute path (null =
 * spawn by name); it never re-walks. The deliberate exception is build/build-check.ts's toolchain
 * probe, which must keep spawning PATH's stub — its "broken" verdict exists to catch exactly the
 * stub's exit-69-on-invalid-license failure, which the real binary would never surface. `timeoutMs`
 * bounds the xcrun probe (see GIT_RESOLVE_TIMEOUT_MS); it is a parameter so the suite can drive it
 * down against a fake wedged xcrun, and production callers keep the default. The probe itself —
 * the SIGKILL-bounded spawnSync and the "different, existing absolute binary" rule — is
 * xcrun-git.ts's `realGitFromXcrun`, shared with the test runner's suite environment. */
export function resolvedGitBin(timeoutMs: number = GIT_RESOLVE_TIMEOUT_MS): string {
  if (resolvedGit !== undefined) return resolvedGit ?? "git";
  let bin: string | null = null;
  if (process.platform === "darwin" && findOnPath("git") === "/usr/bin/git") {
    bin = realGitFromXcrun(timeoutMs);
  }
  resolvedGit = bin;
  return bin ?? "git";
}

/** Run git in `cwd`, throwing GitError on a nonzero exit or when the binary cannot be
 * started at all (the error then names the spawn failure, since git prints no stderr). */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return runGit(cwd, args);
}

/** A git child our own deadline took down: the timeout timer killed the process group rather
 * than git exiting on its own. `runGit` turns it into a GitError naming the deadline;
 * `patchId` swallows it like any other failure ("no match"). */
class GitTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms`);
  }
}

/** A git that exited nonzero: carries the same `stderr`/`code` fields execFile's rejection did,
 * so runGit's error mapping is unchanged. A spawn failure (ENOENT) rejects with the child's
 * own 'error' event instead, which already names the spawn. */
class GitExecError extends Error {
  constructor(
    public stderr: string,
    public code: number | string | undefined,
    message?: string,
  ) {
    super(message ?? (code !== undefined ? String(code) : "git failed"));
  }
}

/** Spawn git in its own process group under our own wall-clock bound and return the promise
 * plus its child handle (a caller may pipe stdin before awaiting, as patch-id does). It uses
 * `spawn` with `detached: true` and captures stdout/stderr itself: the detached process group
 * is what makes the group-wide teardown below work, and `execFile` silently drops the
 * `detached` option, so its native `timeout` SIGTERMs only the direct child and, if that child
 * ignores the signal, leaves the promise pending for as long as the child lives — the
 * twelve-day grandchild leak of BUGS.md 2026-09-21. At `timeoutMs` the whole group gets
 * SIGTERM and the call settles as soon as nothing in the group is left (probed on the leader's
 * close and every GROUP_POLL_MS); whatever survives is SIGKILLed `killGraceMs` later and the
 * call settles then. Either way the returned promise rejects with GitTimeoutError by timeoutMs
 * + killGraceMs, whether or not the tree ever closed, so even a git stuck in an uninterruptible
 * sleep cannot stall the awaited path. The stdout/stderr handles are destroyed and the child
 * unref'd on that path so a descendant that escaped the group cannot keep the harness's handles
 * open. Output is capped at EXEC_MAX_BUFFER per stream (the same ceiling the execFile helper
 * applies): beyond it the child is killed and the call fails rather than silently truncating a
 * diff. */
export function execGitBounded(
  args: string[],
  opts: { cwd: string; extraEnv?: NodeJS.ProcessEnv; timeoutMs?: number; killGraceMs?: number },
): PromiseWithChild<{ stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  const child = spawn(resolvedGitBin(), args, {
    cwd: opts.cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    ...(opts.extraEnv ? { env: { ...process.env, ...opts.extraEnv } } : {}),
  });
  let stdout = "";
  let stderr = "";
  const promise = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let settled = false;
    let stdoutSize = 0;
    let stderrSize = 0;
    const deadline = armGroupDeadline(child, {
      timeoutMs,
      killGraceMs,
      onTimedOut: () => finish(new GitTimeoutError(timeoutMs)),
    });
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      deadline.dispose();
      if (err) {
        // The child is being killed or could not start; release its handles so a descendant
        // that escaped the group cannot keep the harness alive once the caller has its answer.
        releaseChildHandles(child);
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    };
    const onOverflow = (stream: string) => {
      signalTree(child, "SIGKILL");
      finish(
        new GitExecError(
          stderr,
          "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          `${stream} maxBuffer length exceeded`,
        ),
      );
    };
    // setEncoding gives the stream a StringDecoder, so a multibyte UTF-8 character split
    // across chunk boundaries is reassembled rather than corrupted — what execFile's utf8
    // decoding did before this rewrite.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutSize += Buffer.byteLength(chunk);
      if (stdoutSize > EXEC_MAX_BUFFER) onOverflow("stdout");
      else stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderrSize += Buffer.byteLength(chunk);
      if (stderrSize > EXEC_MAX_BUFFER) onOverflow("stderr");
      else stderr += chunk;
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      // Before the deadline this is the spawn failing (git missing from PATH); after it, it can
      // only be a teardown signal that could not be delivered — the run is a timeout either
      // way, settled by the group probe or the grace timer.
      if (!deadline.fired()) finish(err);
    });
    child.on("close", (code) => {
      // Before the deadline the exit code classifies the run. After it, a SIGTERM-trapping
      // grandchild may outlive the leader: settle only once the whole group is gone, or the
      // grace's SIGKILL does.
      if (deadline.fired()) deadline.settleIfGone();
      else if (code === 0) finish();
      else finish(new GitExecError(stderr, code ?? undefined));
    });
  });
  return Object.assign(promise, { child }) as PromiseWithChild<{ stdout: string; stderr: string }>;
}

/** Like git(), with extra environment variables (e.g. GIT_EDITOR for rebase --continue, which the
 * landing flow in landing-merge.ts needs so `rebase --continue` can never block on a commit-message
 * prompt; and the harness ident for rewritten committer identity). The subprocess is bounded by
 * GIT_TIMEOUT_MS plus the KILL_GRACE_MS escalation (an optional `timeoutMs`/`killGraceMs` override
 * both for tests), so a hung or signal-ignoring git fails loudly as a GitError instead of stalling
 * every awaited caller forever. */
export async function runGit(
  cwd: string,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv,
  timeoutMs: number = GIT_TIMEOUT_MS,
  killGraceMs: number = KILL_GRACE_MS,
): Promise<string> {
  try {
    const { stdout } = await execGitBounded(args, { cwd, extraEnv, timeoutMs, killGraceMs });
    return stdout.trimEnd();
  } catch (err) {
    if (err instanceof GitTimeoutError) throw new GitError(args, err.message, undefined);
    // execFile sets a numeric exit code on nonzero exits and a string errno ("ENOENT") when
    // the binary cannot be spawned at all — both reach here, so code is number | string.
    const e = err as { stderr?: string; code?: number | string };
    // git prints no stderr in two cases: a spawn failure (then the underlying message names
    // it — "spawn git ENOENT") and a silent nonzero exit (`git diff --quiet`), where the exit
    // code alone is the story. Fall back to the underlying message only for the first, so a
    // GitError always says why when there is a why to say instead of ending in ": " —
    // `e.stderr ?? …` would not help: on spawn failure stderr is an empty string, and
    // `"" ?? x` keeps the empty string.
    const detail = e.stderr?.trim() || (typeof e.code === "string" ? errorMessage(err) : "");
    throw new GitError(args, detail, e.code);
  }
}

/** Run git, returning null instead of throwing on failure. */
export async function gitTry(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}
