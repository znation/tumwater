/** Appending a backend's configured passthrough args to an already-built argv. Shared by the
 * claude, opencode and codex argv builders (claude-args.ts, opencode-args.ts and codex-args.ts),
 * whose passthrough handling is otherwise identical, so the three backends reject a reserved
 * flag by the same rule and the same message shape. A passthrough arg equal to a flag the
 * harness itself sets is appended AFTER the harness's own copy, and all three backends' parsers
 * are last-wins, so it would silently override the model, the session choice, or the isolation
 * flags — each such arg is rejected here with the offending arg named. `moduleName` names the
 * blocking backend in the error (e.g. `claudeArgs`, `opencodeArgs` or `codexArgs`); `reserved`
 * is that backend's HARNESS_*_FLAGS set. */
export function appendPassthroughArgs(
  args: string[],
  passthrough: readonly string[] | undefined,
  reserved: ReadonlySet<string>,
  moduleName: string,
): void {
  for (const arg of passthrough ?? []) {
    // Match the flag itself even when it carries its value as `--flag=value`.
    const flag = arg.split("=", 1)[0] as string;
    if (reserved.has(flag)) {
      // Name the reserved flag (the arg may carry it as `--flag=value`, so `flag` here is the
      // normalized token) and the fix, so the operator knows exactly which passthrough to drop
      // rather than which of several harness-set flags the arg collided with.
      throw new Error(
        `${moduleName}: passthrough arg ${JSON.stringify(arg)} repeats a flag tumwater sets (` +
          `${flag} is reserved) — drop it from your passthrough args`,
      );
    }
    args.push(arg);
  }
}

/** pi's thinking levels mapped to the effort word the claude and codex argv builders send
 * (`--effort`, `model_reasoning_effort`): `off` and `minimal` clamp to `low`, the two backends'
 * lowest setting, and `low` through `max` map 1:1. Both backends clamp the same way, so the map
 * lives here, beside `appendPassthroughArgs`, where neither builder owns it; doctor notes the
 * clamp (plans/agent-backends.md "Config") and the codex catalog gates the result
 * (`codexEffort` in codex-args.ts). Its readers are `claudeArgs` (claude-args.ts), which rejects
 * an unlisted level, `codexEffort` (codex-args.ts), which returns undefined for one, and the
 * doctor's codex catalog row (doctor-codex-checks.ts), which asks only whether a configured
 * level maps at all.
 * `ultra` is deliberately absent — tumwater never sends it. */
export const EFFORT_BY_THINKING: Record<string, string> = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};
