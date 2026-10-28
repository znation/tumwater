/**
 * Bundled pi extension: refuse a `bash` call that kills processes by pattern, next to the write
 * guard (src/pi-extension/write-guard.ts). Loaded on every pi run via `-e <this file>` from
 * src/pi/pi-args.ts.
 *
 * The run prompt already forbids pattern kills (KILL_BY_PID_RULE, src/prompt/prompt.ts): "Never
 * kill processes by name or pattern; stop only a process you started, by its PID (`kill $!`)".
 * But that rule is words, and BUGS.md 2026-10-28 records one agent answering a timed-out test run
 * with `ps aux | grep test-runner | xargs kill` and a `for p in $(ps …) kill` loop, which reached
 * every process-table row the pattern matched — the team's own in-flight checks included — and
 * took them down mid-run. The process table is shared, so none of those kills is provably the
 * runner's own; `kill $!` and the run's exit sweep are the sanctioned way to stop what it started.
 *
 * This is a tool-layer net beside the prompt rule, not a replacement for it. The same `tool_call`
 * event pi fires for `edit`/`write` fires for `bash`; blocking a call when a handler returns
 * `{ block: true, reason }` shows the model the reason as the tool's error. The detection is a
 * heuristic for the common by-pattern shapes — `pkill`/`killall` as a command word, and `ps` or
 * `pgrep` output fed into `kill` via `xargs` or a `$(ps|pgrep)` substitution — and fails open like
 * the write guard does: a missed shape under load still leaves the prompt rule and the run's sweep,
 * and an unexpected failure here lets the call through rather than stopping every bash command of
 * the run (a broken guard cannot block the team's own checks).
 */

/** The refusal shown as the tool's error, naming the safe ways to stop a run's own process. */
export const PATTERN_KILL_REFUSAL =
  "kill by pattern is refused: `pkill`/`killall` and `ps`/`pgrep` output fed into `kill` reach every " +
  "process on the host the pattern matches, the team's own checks included. Stop only a process you " +
  "started, by its PID: `kill $!` right after backgrounding it — the run's own processes are reaped " +
  "when the run ends.";

/** A `pkill` or `killall` spelled as a command word, skipping a line that only mentions them
 * (built after `echo`/`grep`/`man` etc.). Preceded by a command boundary so `echo pkill x` and a
 * quoted mention pass while `; pkill x` and `| killall x` are caught. */
const DIRECT_PATTERN_KILL = /(?:^|[;&|(\n])\s*(?:pkill|killall)(?:\s|$)/;

/** `ps` or `pgrep` that reads the process table. */
const READ_PROCESS_TABLE = /\b(?:ps|pgrep)\b/;
/** That table piped into `kill` through `xargs` (the incident's `ps … | … | xargs -r kill`). */
const XARGS_KILL = /\bxargs\b[^\n;]*\bkill\b/;
/** A `$(ps …)` / `$(pgrep …)` substitution that feeds ids to a `kill` (`kill -9 $(pgrep -f npm)`,
 * a `for p in $(ps …)` loop whose body kills). */
const TABLE_SUBSTITUTION = /\$\(\s*(?:ps|pgrep)\b/;

/** The refusal for one `bash` command, or null to let it run. Exported for tests. */
export function patternKillRefusal(command: unknown): string | null {
  if (typeof command !== "string" || command.trim() === "") return null;
  if (DIRECT_PATTERN_KILL.test(command)) return PATTERN_KILL_REFUSAL;
  const feedsTable = READ_PROCESS_TABLE.test(command);
  const feedsKill =
    XARGS_KILL.test(command) || (TABLE_SUBSTITUTION.test(command) && /\bkill\b/.test(command));
  if (feedsTable && feedsKill) return PATTERN_KILL_REFUSAL;
  return null;
}

/** Minimal structural types for pi's extension API: pi itself loads this file, so the real types
 * stay out of the dependency tree. */
interface ToolCallLikeEvent {
  toolName?: unknown;
  input?: unknown;
}

interface PiExtensionApi {
  on(
    event: "tool_call",
    handler: (event: ToolCallLikeEvent) => { block: true; reason: string } | undefined,
  ): void;
}

/** The refusal for one `tool_call` event, or undefined to let it run. Exported for tests. */
export function guardKillToolCall(event: ToolCallLikeEvent): { block: true; reason: string } | undefined {
  if (event.toolName !== "bash") return undefined;
  const input = event.input;
  if (typeof input !== "object" || input === null) return undefined;
  try {
    const reason = patternKillRefusal((input as { command?: unknown }).command);
    return reason === null ? undefined : { block: true, reason };
  } catch {
    return undefined;
  }
}

/** The pi extension entry point. */
export default function killGuard(pi: PiExtensionApi): void {
  pi.on("tool_call", guardKillToolCall);
}
