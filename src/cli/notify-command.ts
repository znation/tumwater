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

/** Run one notify hook to completion, returning its exit code. Unlike the notifier's detached
 * fire-and-forget spawn (src/events/notify.ts), this waits with inherited stdio, so the
 * operator sees the hook's own output and its exit. A shell that cannot start resolves 127 —
 * the conventional "command not found" code. */
function runNotifyHook(command: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, [], { shell: true, stdio: "inherit", env });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
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
  const code = await runNotifyHook(
    command,
    notifyCommandEnv(NOTIFY_TEST_TYPE, NOTIFY_TEST_LOOP, NOTIFY_TEST_MESSAGE),
  );
  if (code === 0) {
    say("notify hook exited 0");
  } else {
    say(`notify hook exited with code ${code}`);
    process.exitCode = 1;
  }
}
