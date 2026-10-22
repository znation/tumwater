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

import { appendPassthroughArgs } from "../agent-args.js";

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

/** The effort values tumwater will ever send as `model_reasoning_effort`: the set
 * EFFORT_BY_THINKING can produce. `ultra` (which some models add for sub-agent delegation) is
 * deliberately not here —
 * tumwater never sends it, so `codexArgs` rejects it rather than let a whole agent hierarchy
 * spawn on a model that lists it. */
const KNOWN_EFFORTS: ReadonlySet<string> = new Set(Object.values(EFFORT_BY_THINKING));

/** Map a thinking level to the Codex `model_reasoning_effort` it means, gated by the model's own
 * catalog. `levels` is the model's `supported_reasoning_levels` (design finding 14), which a
 * stream-minted catalog (part 8/9) supplies; until then the caller passes `undefined`, and the
 * result is returned unclamped. An unknown thinking level returns `undefined` (no effort flag) —
 * the level simply has no Codex effort, unlike a thinking level that maps but the model does not
 * support, which is also `undefined`. */
export function codexEffort(thinking: string, levels?: readonly string[]): string | undefined {
  if (!Object.hasOwn(EFFORT_BY_THINKING, thinking)) return undefined;
  const result = EFFORT_BY_THINKING[thinking] as string;
  if (levels !== undefined && !levels.includes(result)) return undefined;
  return result;
}

/** One Codex run's argv and stdin (plans/codex-backend.md "The invocation" §3). Fresh (`exec`)
 * and resumed (`exec resume <id>`) runs share every isolation, prompt-slash and model flag (design
 * finding 6: a resume without `-m` silently switches to Codex's default model); the prompt is
 * always the trailing `-` on stdin, never an argv element. Passthrough args are appended through
 * appendPassthroughArgs so one that repeats a harness flag is refused (the design's reserved set,
 * §2). Throws on an unknown effort, as claudeArgs does — every `-c` key here was proved against
 * `--strict-config` on Codex 0.163.0 (finding 20). */
export interface CodexArgOptions {
  /** The resolved concrete model id, e.g. `gpt-6.1-sol`. */
  model: string;
  /** The resolved `model_reasoning_effort` (see `codexEffort`); omitted leaves Codex's default. */
  effort?: string;
  /** A resumed run's session id; absent means a fresh run. */
  resumeId?: string;
  /** The configured `backends.codex.args` passthrough, appended before the final `-`. */
  args?: string[];
  /** The run prompt, returned as stdin rather than as an argv element. */
  prompt: string;
}

/** Build one run's codex argv and stdin. The prompt is never an argv element (codex reads `-`
 * input from stdin). Throws on an unknown effort, or a passthrough arg that repeats a harness
 * flag, since each would otherwise silently change what the harness asked for. */
export function codexArgs(opts: CodexArgOptions): { args: string[]; stdin: string } {
  if (opts.effort !== undefined && !KNOWN_EFFORTS.has(opts.effort)) {
    throw new Error(
      `codexArgs: unknown effort ${JSON.stringify(opts.effort)} (known: ${[...KNOWN_EFFORTS].join(", ")})`,
    );
  }
  // Isolation flags, then the `--disable` list (design finding 7), then the `-c` keys (finding
  // 20), then the model and effort, then the operator's passthrough, then the closing `-`.
  const head = [
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--ignore-user-config",
    "--ignore-rules",
    "--disable",
    "plugins",
    "--disable",
    "apps",
    "--disable",
    "goals",
    "--disable",
    "image_generation",
    "--disable",
    "browser_use",
    "--disable",
    "computer_use",
    "--disable",
    "tool_suggest",
    "--disable",
    "skill_search",
    "-c",
    "agents.enabled=false",
    "-c",
    'web_search="disabled"',
    "-c",
    "check_for_update_on_startup=false",
    "-c",
    "analytics.enabled=false",
    "-c",
    "feedback.enabled=false",
    "-c",
    'history.persistence="none"',
    "-c",
    'project_doc_fallback_filenames=["CLAUDE.md"]',
    "-m",
    opts.model,
  ];
  if (opts.effort !== undefined) head.push("-c", `model_reasoning_effort=${opts.effort}`);
  const args =
    opts.resumeId === undefined
      ? ["exec", ...head]
      : ["exec", "resume", opts.resumeId, ...head];
  appendPassthroughArgs(args, opts.args, HARNESS_CODEX_FLAGS, "codexArgs");
  args.push("-");
  return { args, stdin: opts.prompt };
}
