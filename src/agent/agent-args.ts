// vocabulary: plain
/** Appending a backend's configured passthrough args to an already-built argv. Shared by the
 * claude and opencode argv builders (claude-args.ts and opencode-args.ts), whose passthrough
 * handling is otherwise identical, so the two backends reject a reserved flag by the same
 * rule and the same message shape. A passthrough arg equal to a flag the harness itself sets
 * is appended AFTER the harness's own copy, and both backends' parsers are last-wins, so it
 * would silently override the model, the session choice, or the isolation flags — each such
 * arg is rejected here with the offending arg named. `moduleName` names the blocking backend
 * in the error (e.g. `claudeArgs` or `opencodeArgs`); `reserved` is that backend's
 * HARNESS_*_FLAGS set. */
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
