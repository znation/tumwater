import { spawn } from "node:child_process";
import { fail, say } from "./cli-output.js";
import { loadConfig } from "../config/config.js";
import { notifyCommandEnv } from "../events/notify.js";

/** The one representative allowlisted event `tumwater notify --test` fires: a failed landing
 * with loop `harness`. Fixed and opinionated — the goal is to prove the hook runs, not to
 * replay a specific page, so there are no per-type or per-message flags. */
const NOTIFY_TEST_TYPE = "land_failed";
const NOTIFY_TEST_LOOP = "harness";
const NOTIFY_TEST_MESSAGE = "tumwater notify --test";

/** How long `tumwater notify --test` waits for the hook before giving up. A hook still running
 * after this long cannot usefully page anyone — the notify channel is meant to be a quick
 * side effect — so the command stops waiting and reports the hang instead of sitting at the
 * terminal forever (e.g. a webhook `curl` to an unreachable host that never connects).
 * Generous enough not to misclassify a hook that is merely slow. */
export const NOTIFY_TEST_TIMEOUT_MS = 10_000;

/** One `notify --test` hook run's outcome: the hook's exit code, or the timeout that killed it. */
type NotifyHookResult = { code: number } | { timedOut: true };

/** Run one notify hook to completion, returning its exit code. Unlike the notifier's detached
 * fire-and-forget spawn (src/events/notify.ts), this waits with inherited stdio, so the
 * operator sees the hook's own output and its exit. A shell that cannot start resolves 127 —
 * the conventional "command not found" code. A hook that does not finish within `timeoutMs`
 * is SIGKILLed and reported as `{ timedOut: true }` rather than awaited forever; the timer is
 * cleared on every outcome so a fast hook never keeps the CLI alive. `timeoutMs` is a test
 * seam; production callers leave it at NOTIFY_TEST_TIMEOUT_MS. */
export function runNotifyHook(
  command: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number = NOTIFY_TEST_TIMEOUT_MS,
): Promise<NotifyHookResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [], { shell: true, stdio: "inherit", env });
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: NotifyHookResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      // The shell shares this process's group (the spawn is not detached), so only the child is
      // signalled — a group kill would take the CLI down with it.
      child.kill("SIGKILL");
      finish({ timedOut: true });
    }, timeoutMs);
    child.on("close", (code) => finish({ code: code ?? 1 }));
    child.on("error", () => finish({ code: 127 }));
  });
}

/** `tumwater notify --test`: run the configured notify hook once with a synthetic event so an
 * operator can check the push channel before a real page. Read-only toward harness state — no
 * event is logged — and the exit code reflects the hook's own (0 passes, anything else fails). */
export async function cmdNotify(root: string, args: string[]): Promise<void> {
  if (!args.includes("--test")) fail("usage: tumwater notify --test");
  const command = loadConfig(root).notify;
  if (typeof command !== "string" || command === "")
    fail("notify is not configured (set `notify` in tumwater.json)");
  say(`running the notify hook (TUMWATER_EVENT_TYPE=${NOTIFY_TEST_TYPE}) …`);
  const result = await runNotifyHook(
    command,
    notifyCommandEnv(NOTIFY_TEST_TYPE, NOTIFY_TEST_LOOP, NOTIFY_TEST_MESSAGE),
  );
  if ("timedOut" in result) {
    say(`notify hook did not finish within ${NOTIFY_TEST_TIMEOUT_MS / 1000}s and was killed`);
    process.exitCode = 1;
  } else if (result.code === 0) {
    say("notify hook exited 0");
  } else {
    say(`notify hook exited with code ${result.code}`);
    process.exitCode = 1;
  }
}
