import { spawn } from "node:child_process";
import type { TumwaterConfig } from "../config/config-schema.js";
import { loadConfigSafe } from "../config/config.js";
import { subscribeEvents, warnEventBestEffort, type HarnessEvent } from "./events.js";
import { formatEvent } from "./event-format.js";
import { errorMessage, stripTerminalControls } from "../text/text.js";
import { childEnv } from "../process/process.js";

/** The operator notify hook: one configured shell command
 * (tumwater.json's `notify`) that the orchestrator runs whenever a notable event fires — the
 * push channel beside the pull-based dashboards and `tumwater logs`.
 *
 * Scope, stated plainly: the notifier subscribes via subscribeEvents (src/events/events.ts), which
 * only sees events THIS process logs. Every allowlisted type but `supervisor_exit` is logged by
 * the orchestrator's own process (budget-gates.ts, gate-polls.ts → streak-gate.ts,
 * role-cap-gates.ts and disk-gate.ts, src/fleet/fleet-polls.ts, landing-slot.ts, landing-questions.ts,
 * src/redeploy/redeployer.ts). `supervisor_exit` is logged by the supervisor after the
 * orchestrator is gone, so src/cli/cli-run.ts pages it directly with notifyFleetDown; events appended by
 * operator CLI commands go straight to the file and are out of scope by design.
 *
 * One knob, an opinionated fixed allowlist, no per-event selection — a command that can post
 * anywhere (a desktop notification, a webhook, a phone push) composes it with the environment
 * the harness hands it: TUMWATER_EVENT_TYPE, TUMWATER_EVENT_LOOP, and TUMWATER_EVENT_MESSAGE
 * (the exact line `tumwater logs` renders, via formatEvent). */
export const NOTIFY_EVENT_TYPES = [
  "budget_warning", // daily spend crossed 80% of the cap, gate still open — time to raise it or fix the fallback before the page below
  "role_cap_warning", // one role's own daily spend crossed 80% of its cap, still ticking — time to raise it before the page below
  "budget_paused", // spend cap hit with no usable free fallback — role loops are stopped
  "claude_window_warning", // the claude.ai subscription window first reported allowed_warning — subscription claude seams still tick; the heads-up before the hold below
  "claude_window_limited", // a rejected subscription window holds every subscription claude seam until it resets — the subscription fleet's binding stop
  "role_streak_paused", // the error-streak circuit breaker auto-paused a role
  "role_cap_paused", // the role's own daily cost cap is reached — it stops starting ticks
  "disk_low", // free space on the worktrees volume dropped below diskHoldGB — new work is held
  "land_failed", // the landing slot finished without landing a change
  "restart_blocked", // the self-redeploy for main is blocked and latched — the fleet is stuck behind it
  "question_posted", // a landing posted a new QUESTIONS.md ## Open entry — only a human can answer it
  "supervisor_exit", // the supervisor gave up — the fleet is down; paged from the supervisor process by notifyFleetDown, since no orchestrator is left to hear it
] as const;

type NotifyEventType = (typeof NOTIFY_EVENT_TYPES)[number];

/** Same-type events within this gap spawn the command once, not once per event: a burst of
 * `land_failed` events pages once. Keyed per type, so one type's page never suppresses
 * another's. */
export const NOTIFY_MIN_GAP_MS = 60_000;

/** The notifier's handle: `update(liveConfig)` applies a freshly polled config (a live
 * `config set notify` edit takes effect on the next poll, no restart), `dispose` unsubscribes
 * from the event feed (the orchestrator's finally block). */
interface Notifier {
  update(config: Pick<TumwaterConfig, "notify">): void;
  dispose(): void;
}

/** The child environment the notify hook runs with: the three TUMWATER_EVENT_* variables over
 * the harness's own environment. One home for the variable names, shared by the notifier's
 * spawn and the `tumwater notify --test` diagnostic (src/cli/notify-command.ts), so the two
 * cannot drift on what a hook sees. */
export function notifyCommandEnv(type: string, loop: string, message: string): NodeJS.ProcessEnv {
  return childEnv({
    TUMWATER_EVENT_TYPE: type,
    TUMWATER_EVENT_LOOP: loop,
    TUMWATER_EVENT_MESSAGE: message,
  });
}

/** The warning for a notify hook that did not exit cleanly, or undefined for exit code 0.
 * Pure, so the wording is testable without a spawn. */
export function notifyExitWarning(
  type: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): string | undefined {
  if (code === 0) return undefined;
  const hint = "check it with `tumwater notify --test`";
  if (code === null) return `notify command was killed by ${signal} paging ${type} — ${hint}`;
  const gloss = code === 127 ? " (command not found)" : "";
  return `notify command exited with code ${code}${gloss} paging ${type} — ${hint}`;
}

/** Spawn the notify command for one event: detached with stdio ignored, so it outlives the
 * caller, and never awaited. A failed spawn or a nonzero exit is one warning, never a throw. */
function spawnNotifyCommand(root: string, command: string, event: HarnessEvent): void {
  try {
    const child = spawn(command, [], {
      shell: true,
      env: notifyCommandEnv(event.type, event.loop, stripTerminalControls(formatEvent(event))),
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    // The shell itself could not start (spawn failed asynchronously — e.g. the command line
    // exceeds the OS arg limit): one warning names it and the listener keeps working. A
    // command that starts but exits nonzero is reported by the exit listener below.
    child.on("error", (err) => {
      warnEventBestEffort(root, "harness", `notify command could not start: ${err.message}`);
    });
    // After unref() this listener does not keep the process alive: a hook that outlives the
    // caller logs nothing.
    child.on("exit", (code, signal) => {
      const message = notifyExitWarning(event.type, code, signal);
      if (message) warnEventBestEffort(root, "harness", message);
    });
  } catch (err) {
    warnEventBestEffort(root, "harness", `notify command could not start: ${errorMessage(err)}`);
  }
}

/** Page the configured notify command for the fleet going down. The supervisor process calls
 * this directly, because the orchestrator generation that runs newNotifier is already gone.
 * Reads the command fresh from tumwater.json; a missing or invalid file or an absent `notify`
 * returns silently (the fleet-down cause may be that very file), and there is no throttle —
 * the supervisor exits right after this one event. */
export function notifyFleetDown(root: string, event: HarnessEvent): void {
  const { config } = loadConfigSafe(root);
  const command = config?.notify;
  if (typeof command !== "string" || command === "") return;
  spawnNotifyCommand(root, command, event);
}

/** Subscribe to this process's event feed and spawn the configured command for allowlisted
 * events. Fire-and-forget: the spawn is never awaited from the poll loop — the command runs
 * detached with stdio ignored, so it outlives whatever the orchestrator does next. A nonzero
 * exit or kill is logged as one warning and the page is not retried. `"warning"` is deliberately not on
 * the allowlist, so a failure warning can never recurse into another spawn. */
export function newNotifier(
  root: string,
  minGapMs: number = NOTIFY_MIN_GAP_MS,
  /** The throttle's clock — a test seam; production reads the wall clock. */
  now: () => number = Date.now,
): Notifier {
  let command: string | undefined;
  const lastSpawnAt = new Map<NotifyEventType, number>();
  const unsubscribe = subscribeEvents((event: HarnessEvent) => {
    if (typeof command !== "string" || command === "") return;
    if (!NOTIFY_EVENT_TYPES.includes(event.type as NotifyEventType)) return;
    const type = event.type as NotifyEventType;
    const at = now();
    const last = lastSpawnAt.get(type);
    if (last !== undefined && at - last < minGapMs) return;
    lastSpawnAt.set(type, at);
    spawnNotifyCommand(root, command, event);
  });
  return {
    update(config) {
      command = config.notify;
    },
    dispose: unsubscribe,
  };
}
