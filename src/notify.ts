import { spawn } from "node:child_process";
import type { TumwaterConfig } from "./config/config-schema.js";
import { subscribeEvents, warnEvent, type HarnessEvent } from "./events.js";
import { formatEvent } from "./event-format.js";
import { errorMessage } from "./text.js";

/** The operator notify hook (PLANS.md "Operator notify hook"): one configured shell command
 * (tumwater.json's `notify`) that the orchestrator runs whenever a notable event fires — the
 * push channel beside the pull-based dashboards and `tumwater logs`.
 *
 * Scope, stated plainly: the notifier subscribes via subscribeEvents (src/events.ts), which
 * only sees events THIS process logs. All six allowlisted types are logged by the
 * orchestrator's own process (budget-gates.ts, gate-polls.ts → streak-gate.ts and
 * role-cap-gates.ts, landing-slot.ts, redeployer.ts), so nothing notable is missed; events appended by
 * operator CLI commands go straight to the file and are out of scope by design.
 *
 * One knob, an opinionated fixed allowlist, no per-event selection — a command that can post
 * anywhere (a desktop notification, a webhook, a phone push) composes it with the environment
 * the harness hands it: TUMWATER_EVENT_TYPE, TUMWATER_EVENT_LOOP, and TUMWATER_EVENT_MESSAGE
 * (the exact line `tumwater logs` renders, via formatEvent). */
export const NOTIFY_EVENT_TYPES = [
  "budget_warning", // daily spend crossed 80% of the cap, gate still open — time to raise it or fix the fallback before the page below
  "budget_paused", // spend cap hit with no usable free fallback — role loops are stopped
  "role_streak_paused", // the error-streak circuit breaker auto-paused a role
  "role_cap_paused", // the role's own daily cost cap is reached — it stops starting ticks
  "land_failed", // the landing slot finished without landing a change
  "restart_blocked", // the self-redeploy for main is blocked and latched — the fleet is stuck behind it
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

/** Subscribe to this process's event feed and spawn the configured command for allowlisted
 * events. Fire-and-forget: the spawn is never awaited from the poll loop — the command runs
 * detached with stdio ignored, so it outlives whatever the orchestrator does next, and a
 * nonzero exit is the command's problem, not the fleet's. `"warning"` is deliberately not on
 * the allowlist, so a failed spawn's warning can never recurse into another spawn. */
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
    try {
      const child = spawn(command, [], {
        shell: true,
        env: {
          ...process.env,
          TUMWATER_EVENT_TYPE: event.type,
          TUMWATER_EVENT_LOOP: event.loop,
          TUMWATER_EVENT_MESSAGE: formatEvent(event),
        },
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      // The shell itself could not start (spawn failed asynchronously — e.g. the command line
      // exceeds the OS arg limit): one warning names it and the listener keeps working. A
      // command that starts but exits nonzero is not a harness concern and is ignored.
      child.on("error", (err) => {
        warnEvent(root, "harness", `notify command could not start: ${err.message}`);
      });
    } catch (err) {
      warnEvent(root, "harness", `notify command could not start: ${errorMessage(err)}`);
    }
  });
  return {
    update(config) {
      command = config.notify;
    },
    dispose: unsubscribe,
  };
}
