import { spawn } from "node:child_process";
import type { TumwaterConfig } from "../config/config-schema.js";
import { loadConfigSafe } from "../config/config.js";
import { subscribeEvents, TUMWATER_SOURCE, warnEventBestEffort, type HarnessEvent } from "./events.js";
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
 * role-cap-gates.ts and disk-gate.ts, src/baseline/main-red.ts, src/team/team-polls.ts,
 * merge-slot.ts, merge-questions.ts,
 * src/redeploy/redeployer.ts). `supervisor_exit` is logged by the supervisor after the
 * orchestrator is gone, so src/cli/cli-start.ts pages it directly with notifyTeamDown; events
 * appended by
 * operator CLI commands go straight to the file and are out of scope by design.
 *
 * One knob, an opinionated fixed allowlist, no per-event selection — a command that can post
 * anywhere (a desktop notification, a webhook, a phone push) composes it with the environment
 * the harness hands it: TUMWATER_EVENT_TYPE, TUMWATER_EVENT_SOURCE, and TUMWATER_EVENT_MESSAGE
 * (the exact line `tumwater logs` renders, via formatEvent). */
export const NOTIFY_EVENT_TYPES = [
  "budget_warning", // daily spend crossed 80% of the cap, gate still open — time to raise it or fix the fallback before the page below
  "role_cap_warning", // one role's own daily spend crossed 80% of its cap, still running — time to raise it before the page below
  "budget_paused", // spend cap hit with no usable free fallback — roles are stopped
  "subscription_window_warning", // the subscription window first reported allowed_warning — subscription seams still run; the heads-up before the hold below
  "subscription_window_limited", // a rejected subscription window holds every subscription seam until it resets — the subscription team's binding stop
  "role_streak_paused", // the error-streak circuit breaker auto-paused a role
  "role_cap_paused", // the role's own daily cost cap is reached — it stops starting runs
  "disk_low", // free space on the worktrees volume dropped below diskHoldGB — new work is held
  "main_red_hold", // main's own check is red — roles keep authoring; the merge-side main_red pin queues a kept change until main moves past it, and the ci healer is handed the failing tests
  "merge_failed", // the merge slot finished without merging a change
  "restart_blocked", // the self-redeploy for main is blocked and latched — the team is stuck behind it
  "question_posted", // a merge posted a new QUESTIONS.md ## Open entry — only a human can answer it
  "entry_refused", // a refusal note merged — the entry is held until a human or the director releases it
  "supervisor_exit", // the supervisor gave up — the team is down; paged from the supervisor process by notifyTeamDown, since no orchestrator is left to hear it
] as const;

type NotifyEventType = (typeof NOTIFY_EVENT_TYPES)[number];

/** Same-type events within this gap spawn the command at most once per gap: a burst of
 * `merge_failed` events pages once at once and once more when the gap ends, carrying the newest
 * held event and how many were held. Keyed per type, so one type's page never suppresses
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
export function notifyCommandEnv(type: string, source: string, message: string): NodeJS.ProcessEnv {
  return childEnv({
    TUMWATER_EVENT_TYPE: type,
    TUMWATER_EVENT_SOURCE: source,
    TUMWATER_EVENT_MESSAGE: message,
  });
}

/** What every notify-hook failure warning starts with. The writers below build their messages
 * from it and `isNotifyFailure` recognizes them by it, so the doctor reader and the writer
 * share one definition. */
const NOTIFY_FAILURE_PREFIX = "notify command ";

/** True for a warning that spawnNotifyCommand logged for a failed page. */
export function isNotifyFailure(ev: HarnessEvent): boolean {
  return ev.type === "warning" && ev.source === TUMWATER_SOURCE && typeof ev.message === "string" && ev.message.startsWith(NOTIFY_FAILURE_PREFIX);
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
  if (code === null) return `${NOTIFY_FAILURE_PREFIX}was killed by ${signal} paging ${type} — ${hint}`;
  return `${NOTIFY_FAILURE_PREFIX}exited with code ${code}${notifyExitGloss(code)} paging ${type} — ${hint}`;
}

/** The sh launch-failure gloss for a notify hook that could not start: 127 is sh's "command
 * not found", 126 its "found but not executable" — most often the configured `notify` command
 * is a typo or an uninstalled/non-executable binary, so a bare "code 127" hides the fix the
 * gloss names. Shared by the notifier's warning (notifyExitWarning above) and `tumwater
 * notify --test`'s diagnostic (src/cli/notify-command.ts) so both surfaces name the same fix
 * for a hook that cannot launch. Any other code gets no gloss. */
export function notifyExitGloss(code: number): string {
  return code === 127 ? " (command not found)" : code === 126 ? " (found but not executable)" : "";
}

/** Spawn the notify command for one event: detached with stdio ignored, so it outlives the
 * caller, and never awaited. A failed spawn or a nonzero exit is one warning, never a throw. */
function spawnNotifyCommand(root: string, command: string, event: HarnessEvent, suffix = ""): void {
  try {
    const child = spawn(command, [], {
      shell: true,
      env: notifyCommandEnv(event.type, event.source, stripTerminalControls(formatEvent(event)) + suffix),
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    // The shell itself could not start (spawn failed asynchronously — e.g. the command line
    // exceeds the OS arg limit): one warning names it and the listener keeps working. A
    // command that starts but exits nonzero is reported by the exit listener below.
    child.on("error", (err) => {
      warnEventBestEffort(root, TUMWATER_SOURCE, `${NOTIFY_FAILURE_PREFIX}could not start: ${err.message}`);
    });
    // After unref() this listener does not keep the process alive: a hook that outlives the
    // caller logs nothing.
    child.on("exit", (code, signal) => {
      const message = notifyExitWarning(event.type, code, signal);
      if (message) warnEventBestEffort(root, TUMWATER_SOURCE, message);
    });
  } catch (err) {
    warnEventBestEffort(root, TUMWATER_SOURCE, `${NOTIFY_FAILURE_PREFIX}could not start: ${errorMessage(err)}`);
  }
}

/** Page the configured notify command for the team going down. The supervisor process calls
 * this directly, because the orchestrator generation that runs newNotifier is already gone.
 * Reads the command fresh from tumwater.json; a missing or invalid file or an absent `notify`
 * returns silently (the team-down cause may be that very file), and there is no throttle —
 * the supervisor exits right after this one event. */
export function notifyTeamDown(root: string, event: HarnessEvent): void {
  const { config } = loadConfigSafe(root);
  const command = config?.notify;
  if (typeof command !== "string" || command === "") return;
  spawnNotifyCommand(root, command, event);
}

/** Subscribe to this process's event feed and spawn the configured command for allowlisted
 * events. Fire-and-forget: the spawn is never awaited from the poll loop — the command runs
 * detached with stdio ignored, so it outlives whatever the orchestrator does next. A nonzero
 * exit or kill is logged as one warning and the page is not retried. `"warning"` is
 * deliberately not on the allowlist, so a failure warning can never recurse into another
 * spawn. A same-type event inside the gap is held, not dropped: the newest one is paged when
 * the gap ends (or at `dispose`), with a count of the others held with it. */
export function newNotifier(
  root: string,
  minGapMs: number = NOTIFY_MIN_GAP_MS,
  /** The throttle's clock — a test seam; production reads the wall clock. */
  now: () => number = Date.now,
  /** Runs `fn` after `delayMs` and returns a cancel function — a test seam; production uses an
   * unref'd timer so a held page never keeps the process alive. */
  schedule: (fn: () => void, delayMs: number) => () => void = (fn, delayMs) => {
    const timer = setTimeout(fn, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
): Notifier {
  let command: string | undefined;
  const lastSpawnAt = new Map<NotifyEventType, number>();
  const pending = new Map<NotifyEventType, { event: HarnessEvent; held: number; cancel: () => void }>();
  const flush = (type: NotifyEventType): void => {
    const entry = pending.get(type);
    if (!entry) return;
    pending.delete(type);
    if (typeof command !== "string" || command === "") return;
    lastSpawnAt.set(type, now());
    const suffix = entry.held > 1 ? ` (and ${entry.held - 1} more ${type} event(s) in the same minute; \`tumwater logs\` lists them)` : "";
    spawnNotifyCommand(root, command, entry.event, suffix);
  };
  const unsubscribe = subscribeEvents((event: HarnessEvent) => {
    if (typeof command !== "string" || command === "") return;
    if (!NOTIFY_EVENT_TYPES.includes(event.type as NotifyEventType)) return;
    const type = event.type as NotifyEventType;
    const at = now();
    const last = lastSpawnAt.get(type);
    if (last !== undefined && at - last < minGapMs) {
      const held = pending.get(type);
      if (held) {
        held.event = event;
        held.held += 1;
      } else {
        pending.set(type, { event, held: 1, cancel: schedule(() => flush(type), last + minGapMs - at) });
      }
      return;
    }
    // Past the gap: this event pages now and supersedes anything still held for the type.
    pending.get(type)?.cancel();
    pending.delete(type);
    lastSpawnAt.set(type, at);
    spawnNotifyCommand(root, command, event);
  });
  return {
    update(config) {
      command = config.notify;
    },
    dispose() {
      unsubscribe();
      for (const [type, entry] of [...pending]) {
        entry.cancel();
        flush(type);
      }
    },
  };
}
