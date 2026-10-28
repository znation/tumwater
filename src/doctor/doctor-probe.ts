import { spawn } from "node:child_process";
import { captureCappedOutput, releaseChildHandles, signalTree } from "../process/process.js";

/** How long a backend credential/version probe may take before it counts as unknown — a doctor
 * run is a pre-flight, not a place to wait out a hung backend. Shared by the pi, claude, opencode
 * and codex credential probes (doctor-pi-checks.ts, doctor-claude-checks.ts,
 * doctor-opencode-checks.ts, doctor-codex-checks.ts). */
export const AUTH_CHECK_TIMEOUT_MS = 15_000;

/** Cap on a credential probe's captured stdout. The auth reply is a tiny JSON object; a binary
 * whose output is a runaway log (or a pipe held open with no EOF) must not grow `out` without
 * bound. Sibling probes share EXEC_MAX_BUFFER, but 1 MiB is already orders of magnitude past any
 * real reply, so it is the tighter bound here. Over it the probe kills the child and reads as
 * unknown. */
export const AUTH_CHECK_MAX_OUTPUT_BYTES = 1024 * 1024;

/** One bounded probe of a resolved binary: `null` when the spawn threw, the child errored,
 * the deadline passed, or stdout overran `maxOutputBytes` — every case the caller must read as
 * "could not check", never as a verdict. The child runs detached and at the deadline (or on
 * overrun) its whole process group is SIGKILLed and the promise settles, because `'close'`
 * waits for the stdio pipes and a grandchild holding them open would otherwise leave the
 * promise pending past the deadline and hang the caller (the same trap git-run.ts's bounded
 * spawn closes for git). stderr is ignored rather than piped, since nothing reads it and a
 * full stderr pipe would block the child. `timeoutMs` and `maxOutputBytes` are test seams;
 * production callers pass their own named constants. One home of the shape, shared by the
 * model checks' credential/version probes, and the tier-model probes —
 * before the split each doctor module carried its own byte-for-byte copy. The credential probes'
 * named budgets (AUTH_CHECK_TIMEOUT_MS, AUTH_CHECK_MAX_OUTPUT_BYTES) live beside it here, so the
 * backend check modules share them without importing them from one another. */
export function boundedProbe(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{ code: number | null; stdout: string } | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // Detached so the deadline's signalTree reaches a grandchild too; stderr is ignored
      // rather than piped, since nothing reads it and a full stderr pipe would block the
      // child until the deadline.
      child = spawn(bin, args, {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
        env,
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: { code: number | null; stdout: string } | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // Destroy the captured stdout and unref the process handle (releaseChildHandles): a
      // grandchild that escaped the group and holds the pipe's write end would otherwise keep
      // the process's event loop alive though the probe already has its answer.
      releaseChildHandles(child);
      resolve(result);
    };
    // Deadline or runaway output: kill the whole group, tear down the handles, and settle —
    // do not wait for a `'close'` the group may never deliver. Overrun shares the path: it
    // passes `abort` as captureCappedOutput's onOverflow.
    const abort = (): void => {
      signalTree(child, "SIGKILL");
      settle(null);
    };
    timer = setTimeout(abort, timeoutMs);
    // Captured stdout is capped at maxOutputBytes (reads past it abort); stderr was piped to
    // ignore at spawn, so captureCappedOutput attaches nothing to it.
    const captured = captureCappedOutput(child, maxOutputBytes, abort);
    child.on("error", () => settle(null));
    child.on("close", (code) => settle({ code, stdout: captured.stdout }));
  });
}
