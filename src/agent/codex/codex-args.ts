/** The Codex run's reserved flags and config keys plus the effort mapping — the pure,
 * build-agnostic
 * half of the codex invocation (plans/codex-backend.md "Config and routing" §2 and
 * "The invocation"
 * §3). Part 4/9 owns these constants so config validation and the traits layer can screen a
 * `backends.codex.args` passthrough before the adapter lands; part 5/9 adds the `codexArgs` argv
 * builder beside them, and 6/9 the stream translator. Pure — imports no runtime registry,
 * config or
 * subprocess — so config-validation.ts can import it without dragging the adapter in.
 *
 * Everything here is proved against Codex 0.163.0: every flag exists on that build, and every
 * `-c` key passes the `--strict-config` device (design finding 20). */

/** Flags the harness invocation sets itself (§3): the output and model flags, the sandbox and
 * approval switches, the isolation switches, and the where-and-what-it-runs switches. A
 * passthrough arg equal to one of these is appended AFTER the harness's own copy and Codex's
 * parser is last-wins, so it would silently override the model, the isolation or the run
 * location the harness resolved. Each is rejected with the offending arg named. This is the
 * design's reserved set (§2 "Reserved passthrough flags"); config validation
 * (config-validation.ts) mirrors it for `backends.codex.args`, so a value that passes
 * validation is never accepted there and then thrown in the builder.
 *
 * Operators keep `-c`, `--enable` and `--disable` for their own settings — those keys are
 * screened separately (HARNESS_CODEX_CONFIG_KEYS). */
export const HARNESS_CODEX_FLAGS: ReadonlySet<string> = new Set([
  // Output and model: tumwater forces JSON output, the resolved model, and a normal color for
  // the transcript log.
  "--json",
  "-m",
  "--model",
  "-o",
  "--output-last-message",
  "--output-schema",
  "--color",
  // Sandbox and approvals: tumwater runs every job with bypass approval and no sandbox
  // (decision 2), so an operator cannot re-arm an approval prompt or a sandbox mid-run.
  "-s",
  "--sandbox",
  "--dangerously-bypass-approvals-and-sandbox",
  "--approve-for-me",
  "--dangerously-bypass-hook-trust",
  // Isolation: tumwater ignores the user's config, rules and persistent state so one team run
  // cannot read a personal hook, skill or trust entry.
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
  // Where and what it runs: tumwater pins the cwd and the worktree and refuses `--oss` /
  // `--local-provider` so a run can never target something other than the resolved backend.
  "-C",
  "--cd",
  "--worktree",
  "--add-dir",
  "--skip-git-repo-check",
  "-p",
  "--profile",
  "--oss",
  "--local-provider",
]);

/** The keys tumwater sets on every run via `-c <key>=…` (§3), so an operator's `-c` passthrough
 * whose key is one of these would silently override the model, the effort, the sandbox mode, or
 * the telemetry/state settings the harness already passed. A `-c` or `--config` passthrough whose
 * key names one of these is refused; any other key is the operator's own and passes. */
export const HARNESS_CODEX_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "model",
  "model_reasoning_effort",
  "sandbox_mode",
  "project_doc_fallback_filenames",
  "web_search",
  "agents.enabled",
  "check_for_update_on_startup",
  "analytics.enabled",
  "feedback.enabled",
  "history.persistence",
]);

/** Thinking → `model_reasoning_effort`. `off` and `minimal` clamp to `low` (Codex has no lower
 * setting; doctor notes the clamp), `low` through `max` map 1:1. `ultra` is not a value Codex
 * can receive — tumwater never sends it (it delegates to sub-agents). This is claude's
 * EFFORT_BY_THINKING rule moved to codex, where the level the model's catalog lists also gates
 * the result (part 5/9's `codexEffort`). */
export const EFFORT_BY_THINKING: Record<string, string> = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};
