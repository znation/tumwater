import { spawn } from "node:child_process";
import { fail, say } from "./cli-output.js";
import { loadConfig } from "../config/config.js";
import { TUMWATER_SOURCE } from "../events/events.js";
import { notifyCommandEnv, notifyExitGloss } from "../events/notify.js";

/** The one representative allowlisted event `tumwater notify --test` fires: a failed landing
 * with source `tumwater`. Fixed and opinionated — the goal is to prove the hook runs, not to
 * replay a specific page, so there are no per-type or per-message flags. */
const NOTIFY_TEST_TYPE = "merge_failed";
const NOTIFY_TEST_SOURCE = TUMWATER_SOURCE;
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
 * fire-and-forget spawn (src/events/notify.ts), this waits with inherited stdio by
 * default (the dashboard passes "ignore"), so the
 * operator sees the hook's own output and its exit. A shell that cannot start resolves 127 —
 * the conventional "command not found" code. A hook that does not finish within `timeoutMs`
 * is SIGKILLed and reported as `{ timedOut: true }` rather than awaited forever; the timer is
 * cleared on every outcome so a fast hook never keeps the CLI alive. `timeoutMs` is a test
 * seam; production callers leave it at NOTIFY_TEST_TIMEOUT_MS. */
export function runNotifyHook(
  command: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number = NOTIFY_TEST_TIMEOUT_MS,
  stdio: "inherit" | "ignore" = "inherit",
): Promise<NotifyHookResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [], { shell: true, stdio, env });
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

/** What one notify test run came to: no hook configured, or the hook ran and `message` is the
 * outcome line the CLI prints (`passed` only on exit 0). */
type NotifyTestOutcome = { status: "not_configured" } | { status: "ran"; passed: boolean; message: string };

/** Run the saved notify hook once with the synthetic test event, under the NOTIFY_TEST_TIMEOUT_MS
 * bound. Shared by `tumwater notify --test` (inherited stdio) and the dashboard's "Send test"
 * (`"ignore"`, so the hook's output never lands in the server's terminal). */
export async function testNotifyHook(root: string, stdio: "inherit" | "ignore" = "inherit"): Promise<NotifyTestOutcome> {
  const command = loadConfig(root).notify;
  if (typeof command !== "string" || command === "") return { status: "not_configured" };
  const result = await runNotifyHook(
    command,
    notifyCommandEnv(NOTIFY_TEST_TYPE, NOTIFY_TEST_SOURCE, NOTIFY_TEST_MESSAGE),
    NOTIFY_TEST_TIMEOUT_MS,
    stdio,
  );
  if ("timedOut" in result)
    return { status: "ran", passed: false, message: `notify hook did not finish within ${NOTIFY_TEST_TIMEOUT_MS / 1000}s and was killed` };
  if (result.code === 0) return { status: "ran", passed: true, message: "notify hook exited 0" };
  // The sh launch-failure gloss (same wording the real notifier warns with) names the fix
  // for a hook that could not start: a typo'd `notify` command reads as a bare `code 127`
  // without it.
  return { status: "ran", passed: false, message: `notify hook exited with code ${result.code}${notifyExitGloss(result.code)}` };
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
  const outcome = await testNotifyHook(root);
  if (outcome.status === "not_configured") fail("notify is not configured (set `notify` in tumwater.json)");
  else {
    say(outcome.message);
    if (!outcome.passed) process.exitCode = 1;
  }
}
