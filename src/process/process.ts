import { execFile, type ChildProcess, type ExecFileOptions, type PromiseWithChild } from "node:child_process";
import { promisify } from "node:util";

/** Child-process plumbing: the harness's one execFile helper (execFileAsync), the pid-liveness
 * probe every place that decides whether a recorded pid still belongs to a live process shares
 * (the merge lock's stale-holder check in lock.ts, the orchestrator-alive status in
 * team/team-orchestrator-info.ts), the group-signal helpers behind every teardown, the
 * register/abort race helper the spawns and merge's shutdown wiring share, and the child
 * environment that keeps the harness's Node processes out of LaunchServices on macOS. Reading the
 * host's process table and the per-run TUMWATER_RUN marks and sweep built on it live in
 * process-table.ts, on top of the exec helper here. */

const execFileRaw = promisify(execFile);

/** The output ceiling every execFile the harness runs shares (git, tsc, the build check, the
 * ps/lsof probes): a busy macOS host's full-width process table is already ~250 KB — a quarter
 * of execFile's 1 MB default — and a long argv or two grows it fast. */
export const EXEC_MAX_BUFFER = 32 * 1024 * 1024;

/** The harness's one execFile helper: promisify(execFile) with the shared output ceiling baked
 * in as the default. Every execFile the harness runs goes through this: build/host-sleep.ts,
 * build/build-stage.ts, build/build-check.ts, process/run-marker.ts and process/process-table.ts.
 * The ceiling and the returned child handle therefore behave the same everywhere. */
export function execFileAsync(
  file: string,
  args: readonly string[],
  options: Omit<ExecFileOptions, "encoding"> = {},
): PromiseWithChild<{ stdout: string; stderr: string }> {
  return execFileRaw(file, args, { maxBuffer: EXEC_MAX_BUFFER, ...options });
}

/** Run `fn` once when `signal` aborts, or at once when it has already aborted — a listener
 * added after the abort event never fires, so `addEventListener` alone would leave the caller
 * waiting on a shutdown that has come and gone. A missing signal (no shutdown wiring)
 * registers nothing. Shared by spawnSupervised (supervisor.ts), runPi's child spawn
 * (src/agent/run-spawn.ts), sleepInterruptible (run-timing.ts), and abortOnShutdown
 * (merge-pipeline.ts).
 *
 * Returns a disposer that detaches `fn`. A `{ once: true }` listener detaches itself when the
 * signal fires, so a caller whose work outlives the abort need not dispose; a caller that
 * settles while the signal is still live MUST run the disposer, or a long-lived signal — the
 * team shutdown, wired once per merge — accumulates one listener and its closure per task
 * that ever settled. */
export function runOnAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    fn();
    return () => {};
  }
  signal.addEventListener("abort", fn, { once: true });
  return () => signal.removeEventListener("abort", fn);
}

/** True when a process with this pid exists — a signal-0 send, which cannot affect the
 * target. Any error reads as "not alive": no such process (ESRCH), or permission denied
 * (EPERM, e.g. the pid was recycled by another user's process) — the harness only probes
 * pids of its own team, so a live foreign holder must not be mistaken for one of ours.
 *
 * Anything that is not a positive integer reads as not alive without probing: signal 0
 * treats pid 0 as the caller's own process GROUP and a negative pid as another group
 * (kill(-1, 0) checks every process the user may signal), so both would report "alive" for
 * an id no process owns. A torn or foreign state/lock file (a pid field of 0, a negative or
 * fractional value) must not latch a dead holder as live — that would keep the merge lock
 * unbreakable for its full stale window, and make `tumwater run` refuse to start because a
 * phantom orchestrator looks alive. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A per-process-instance identity: the pid plus the OS's record of when that process
 * started. A bare pid is ambiguous once the process dies and the kernel reissues the number
 * to an unrelated process (`pidAlive` would then report the reused process alive); the start
 * distinguishes the instance a handle names from any other that later holds the same pid. The
 * concurrency tier's reap checks read one with `pidIdentity` and re-check it with
 * `identityAlive`, so a recycled pid can never read as the original child still alive. */
export interface ProcessIdentity {
  /** The pid the identity belongs to. */
  pid: number;
  /** The OS's start time of the process, as `ps -o lstart=` prints it (supported on macOS and
   * Linux alike). Compared across reads; not stable to parse, and only meaningful beside a
   * pid. */
  start: string;
}

/** The identity of the live process on `pid`, or null when no process of ours answers for it —
 * a non-positive or non-integer pid, a reaped pid, or a pid the probe cannot read (a foreign
 * process `ps` will not disclose, or a host whose ps lacks `lstart`). Null reads as "not
 * alive" to `identityAlive`, so the reap checks' bounded poll reports only a genuine hang. */
export async function pidIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const start = stdout.trim();
    return start.length > 0 ? { pid, start } : null;
  } catch {
    return null;
  }
}

/** True when the process instance `id` names is still alive: the pid answers and the OS still
 * reports the same start time. A reaped pid (no answer), a pid reused by a different process
 * (a different start), or null reads as not alive. */
export async function identityAlive(id: ProcessIdentity): Promise<boolean> {
  const now = await pidIdentity(id.pid);
  return now !== null && now.start === id.start;
}

/** Terminate a detached child and everything it started: SIGTERM to the process group now,
 * escalating to SIGKILL after 10 s if any of it is still alive. The child is spawned detached
 * (its own process group leader — runPi does this for pi), so a negative PID reaches every
 * tool-call grandchild — which a single-PID kill leaves orphaned to launchd — while the
 * harness's own group is never in the blast radius. Shared by the run-timeout,
 * quiet-watchdog, and harness-shutdown kills, and by the sweep every run gets once pi exits
 * (runPi's 'exit' handler), when the group holds only what pi's tool calls backgrounded.
 *
 * The escalation is armed only when the SIGTERM reached a live process: a group that died with
 * its leader — every clean run — gets no second signal, so nothing is sent 10 s later to a pgid
 * no process holds any more (the one state in which a recycled pid could make it another
 * group; the kernel never reissues the number while a member lives). The timer is unref'd and
 * never awaited: the run resolves as soon as pi's output is in, and only a SIGTERM-trapping
 * straggler waits on the escalation — holding every run up to 10 s for it would slow the team
 * to cover what the SIGTERM already covers, and a finished harness process is not kept alive
 * by it. */
export function terminateChild(child: ChildProcess): void {
  if (signalTree(child, "SIGTERM")) setTimeout(() => signalTree(child, "SIGKILL"), 10_000).unref();
}

/** Signal the child's whole process group, falling back to the child alone when the group is
 * already gone or the platform has no negative-PID kill (Windows). Returns whether the signal
 * reached a live process: false when nothing was left to receive it — ESRCH from a group that
 * died with its leader, the normal case once the child has exited. Never throws: a process
 * that died between the caller's decision and this call is the normal case. Shared by runPi's
 * teardown (src/agent/run-agent.ts) and the detached process-group runner (runScriptGroup,
 * process-group.ts) — the same "signal the tree, not just the direct child" guarantee in one
 * home, this module. */
export function signalTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.pid == null) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false; // Already gone.
    }
  }
}

/** Release the harness's handles on a child whose pipes will never be read again: destroy the
 * captured stdout/stderr streams and unref the process handle. A descendant that escaped the
 * child's process group and inherited the pipe's write end keeps the stream — and through it
 * the harness's event loop — alive even though the caller already has its answer, the normal
 * case once a child fails to spawn or is killed at its deadline while a setsid'd grandchild
 * lives on. Shared by runGit's failure finisher (git/git-run.ts) and runScriptGroup's timeout
 * finisher (process-group.ts). */
export function releaseChildHandles(child: ChildProcess): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

/** The text a detached child's stdout/stderr streams yielded, and whether each passed the byte
 * ceiling. Text captured before a stream's overflow is retained; nothing after it is. */
interface CappedCapture {
  stdout: string;
  stderr: string;
  /** True once stdout exceeded `maxBuffer` bytes; no further stdout text is captured. */
  stdoutOverflow: boolean;
  /** True once stderr exceeded `maxBuffer` bytes; no further stderr text is captured. */
  stderrOverflow: boolean;
}

/** Collect a detached child's stdout/stderr, keeping each stream while it stays within
 * `maxBuffer` BYTES and reporting the stream that passes the ceiling via `onOverflow` (called at
 * most once per stream, on the first overflowing chunk). The shared acquisition the three
 * bounded detached-child probes (execGitBounded, runScriptGroup, boundedProbe) all hand-declared
 * before: git fails loudly and kills the child on overflow, the script runner keeps a truncated
 * tail for classification, the doctor probe aborts and reads "could not check" — the policy stays
 * in the caller, the byte counting here. The chunk arrives as
 * a Buffer from a raw stdio pipe, or as a String once the caller setEncoding'd the stream; both
 * are counted by BYTE length (Buffer.byteLength / Buffer.length), exactly what execFile's
 * maxBuffer ceiling limits. Call BEFORE the child can emit: receivers are attached here. */
export function captureCappedOutput(
  child: ChildProcess,
  maxBuffer: number,
  onOverflow?: (stream: "stdout" | "stderr") => void,
): CappedCapture {
  const captured: CappedCapture = { stdout: "", stderr: "", stdoutOverflow: false, stderrOverflow: false };
  const capture = (stream: "stdout" | "stderr") => {
    let bytes = 0;
    child[stream]?.on("data", (chunk: Buffer | string) => {
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (bytes <= maxBuffer) {
        captured[stream] += chunk;
        return;
      }
      // Past the ceiling: drop this and every later chunk, and call onOverflow once per stream
      // (further overflowing chunks are ignored).
      if (stream === "stdout") {
        if (captured.stdoutOverflow) return;
        captured.stdoutOverflow = true;
      } else {
        if (captured.stderrOverflow) return;
        captured.stderrOverflow = true;
      }
      onOverflow?.(stream);
    });
  };
  capture("stdout");
  capture("stderr");
  return captured;
}

// ── Child environments ───────────────────────────────────────────────────────────────────

/** The child-environment policy every spawn that hands a child the harness's environment shares:
 * start from `process.env` and apply `overrides` on top. The explicit spawn sites
 * (supervisor.ts, self-reload.ts, notify.ts, git-run.ts, doctor-model-checks.ts) all want exactly
 * this, so the spread lives here once instead of in each spawn's options. */
export function childEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

// ── LaunchServices check-ins (macOS) ──────────────────────────────────────────────────────

/** The NODE_OPTIONS entry that keeps a Node process from checking in with LaunchServices. On macOS,
 * assigning `process.title` runs libuv's uv_set_process_title, which registers the process as an
 * application (`_LSApplicationCheckIn`) so Activity Monitor and Force Quit can show the title.
 * launchservicesd keeps a Mach port for every process that ever checked in and never releases it
 * when the process exits (one port per process, measured on macOS 27.0 and seen in 26.6.2's logs),
 * and the kernel kills the daemon near 268K ports — which wedged the GUI session of the Mac
 * running the team on 2026-09-25 (BUGS.md 2026-09-28). npm sets its title on every run and pi at
 * startup; one `npm test` leaked ~140 ports through the npm processes of its build-check tests
 * alone.
 *
 * The preload swaps the property for a plain getter/setter before any program code runs, so an
 * assignment only stores the string: nothing registers, and ps shows the real argv instead of the
 * title. It has to be an ACCESSOR — `process.title` is a V8 native data property, and redefining
 * it with a `value` descriptor goes through the native setter, checking the process in by itself.
 * It is inline (a data: URL with no spaces or double quotes, which NODE_OPTIONS would split on or
 * strip) rather than a file, so no rebuild or swap of dist/ can leave the flag naming a missing
 * module — that would fail every Node process started under it. Node accepts `--import` in
 * NODE_OPTIONS from 18.18; tumwater itself needs 20.3. */
export const NO_LAUNCH_SERVICES_CHECK_IN =
  "--import=data:text/javascript,(t=>Object.defineProperty(process,'title',{get:()=>t,set:v=>{t=String(v)},enumerable:true,configurable:true}))(process.title)";

/** `base` for a child whose Node processes must not check in with LaunchServices (see
 * NO_LAUNCH_SERVICES_CHECK_IN): on macOS, the preload appended to NODE_OPTIONS after whatever
 * the caller set there — once, since a check started from inside a pi run inherits it already;
 * anywhere else `base` itself, since a title registers nothing there. The harness applies it to
 * the process trees that start Node in bulk: every pi run (so every tool call) and every build
 * check. */
export function withoutLaunchServicesCheckIn(
  base: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "darwin") return base;
  const current = base.NODE_OPTIONS ?? "";
  if (current.includes(NO_LAUNCH_SERVICES_CHECK_IN)) return base;
  const nodeOptions = current.trim() === "" ? NO_LAUNCH_SERVICES_CHECK_IN : `${current} ${NO_LAUNCH_SERVICES_CHECK_IN}`;
  return { ...base, NODE_OPTIONS: nodeOptions };
}
