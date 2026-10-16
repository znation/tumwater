import { spawn } from "node:child_process";
import { releaseChildHandles, signalTree } from "../process/process.js";

/** One bounded probe of a resolved binary: `null` when the spawn threw, the child errored,
 * the deadline passed, or stdout overran `maxOutputBytes` — every case the caller must read as
 * "could not check", never as a verdict. The child runs detached and at the deadline (or on
 * overrun) its whole process group is SIGKILLed and the promise settles, because `'close'`
 * waits for the stdio pipes and a grandchild holding them open would otherwise leave the
 * promise pending past the deadline and hang the caller (the same trap git-run.ts's bounded
 * spawn closes for git). stderr is ignored rather than piped, since nothing reads it and a
 * full stderr pipe would block the child. `timeoutMs` and `maxOutputBytes` are test seams;
 * production callers pass their own named constants. One home of the shape, shared by the
 * model checks' credential/version probes, the tier-model probes, and the image-input probe —
 * before the split each doctor module carried its own byte-for-byte copy. */
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
    let out = "";
    let bytes = 0;
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
    // do not wait for a `'close'` the group may never deliver.
    const abort = (): void => {
      signalTree(child, "SIGKILL");
      settle(null);
    };
    timer = setTimeout(abort, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      bytes += chunk.length;
      if (bytes > maxOutputBytes) abort();
    });
    child.on("error", () => settle(null));
    child.on("close", (code) => settle({ code, stdout: out }));
  });
}
