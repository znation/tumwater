// vocabulary: plain
/** Flags the OpenCode harness invocation will set (plans/opencode-backend.md "The
 * invocation"). Part 2/7 only reserves them — there is no adapter yet, so this module holds
 * the reserved set and nothing else; part 3/7 adds the argv builder beside it. A passthrough
 * arg equal to one of these would be appended AFTER the harness's own copy and OpenCode's
 * parser is last-wins, so it would silently override the resolved model, the session choice,
 * or the isolation flags. Each is rejected by config validation (config-validation.ts) for
 * `backends.opencode.args` with the offending arg named. This is the reserved set from
 * plans/opencode-backend.md "Config and routing". */

export const HARNESS_OPENCODE_FLAGS: ReadonlySet<string> = new Set([
  "--format",
  "--model",
  "-m",
  "--session",
  "-s",
  "--continue",
  "-c",
  "--fork",
  "--standalone",
  "--server",
  "--attach",
  "--auto",
  "--yolo",
  "--dangerously-skip-permissions",
  "--agent",
  "--thinking",
  "--dir",
]);
