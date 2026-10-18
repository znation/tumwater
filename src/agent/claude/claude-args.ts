// vocabulary: plain
/** Building the claude command line for one tick (plans/agent-backends.md "The claude
 * invocation") — pure argv construction plus the prompt-on-stdin pairing, with no subprocess,
 * backend registration, or session ledger. Part 3c supplies the session decision (which
 * `--session-id` or `--resume` to pass); this module turns those inputs into the invocation's
 * argv.
 *
 * The environment is built separately (claude-env.ts) so each concern has one module.
 *
 * `NODE_OPTIONS` preload decision (2026-10-09): claude 2.1.295 on macOS is a single-file
 * Mach-O native executable (`file` reports `Mach-O 64-bit executable arm64`) and ignores
 * `NODE_OPTIONS` — it exits 0 and prints its version both with tumwater's `--import=data:`
 * preload and with a deliberately broken `--require` path. So the preload stays on claude's
 * environment: claude itself is unaffected, while the Bash tool's `npm` grandchildren inherit
 * it and skip their LaunchServices check-in (src/process/process.ts). The `--settings` Bash-env
 * fallback the design holds in reserve is not needed. */

import fs from "node:fs";
import path from "node:path";
import { appendPassthroughArgs } from "../agent-args.js";

/** Flags the harness passes itself. A passthrough arg equal to one of these is appended AFTER
 * the harness's own copy, and claude's argument parser is last-wins — so it would silently
 * override the isolation flags, the session choice, or the model the harness resolved. Each is
 * rejected by claudeArgs with the offending arg named. This is exactly the design's reserved
 * set (plans/agent-backends.md "Config"); config validation (config-validation.ts) mirrors this
 * set for `backends.claude.args`, so a value that passes validation is never accepted by
 * validation and then thrown here. */
export const HARNESS_CLAUDE_FLAGS: ReadonlySet<string> = new Set([
  "-p",
  "--print",
  "--output-format",
  "--verbose",
  "--model",
  "--effort",
  "--session-id",
  "--resume",
  "-r",
  "--continue",
  "-c",
  "--permission-mode",
  "--tools",
  "--setting-sources",
  "--strict-mcp-config",
  "--mcp-config",
  "--disable-slash-commands",
  "--exclude-dynamic-system-prompt-sections",
  "--append-system-prompt-file",
  "--max-budget-usd",
]);

/** claude's effort levels are pi's thinking levels with `off`/`minimal` clamped to `low`:
 * claude has no lower setting, and doctor notes the clamp (plans/agent-backends.md "Config").
 * `off` and `minimal` are the only remapped entries; the rest are 1:1. */
const EFFORT_BY_THINKING: Record<string, string> = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** The claude argv builder's inputs. `model` is the concrete resolved id (a tier map is
 * resolved before the seam, exactly as piArgs's config view is). Exactly one of `sessionId`
 * (fresh) and `resumeSessionId` (continue) is required; part 3c's ledger decides which. */
export interface ClaudeArgOptions {
  /** The worktree the run starts in; read only to decide `--append-system-prompt-file`. */
  cwd: string;
  /** The resolved concrete model id, e.g. `claude-sonnet-5-5`. */
  model: string;
  /** pi's thinking level; omitted means claude's own default effort. */
  thinking?: string;
  /** A fresh run's `--session-id`, minted by the caller's ledger. */
  sessionId?: string;
  /** A resumed run's `--resume <id>`, chosen by the caller's ledger. */
  resumeSessionId?: string;
  /** API-billing runs pass the remaining daily budget; subscription runs pass none. */
  maxBudgetUsd?: number;
  /** The configured `backends.claude.args` passthrough, appended last. */
  args?: string[];
  /** The tick prompt, returned as stdin rather than as an argv element. */
  prompt: string;
}

/** True when the worktree has an `AGENTS.md` and no `CLAUDE.md`: claude does not read
 * `AGENTS.md` on its own, so the adapter appends it — but only when the repo has no
 * `CLAUDE.md`, which `--setting-sources project` already loads (finding 1). */
function shouldAppendAgents(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, "AGENTS.md")) && !fs.existsSync(path.join(cwd, "CLAUDE.md"));
}

/** Build one run's claude argv and stdin. The prompt is never an argv element (claude reads
 * `-p` input from stdin). Throws on an unusable invocation — no session choice, both session
 * choices, an unknown thinking level, or a passthrough arg that repeats a harness flag — since
 * each would otherwise silently change what the harness asked for. */
export function claudeArgs(opts: ClaudeArgOptions): { args: string[]; stdin: string } {
  if ((opts.sessionId === undefined) === (opts.resumeSessionId === undefined)) {
    throw new Error("claudeArgs: pass exactly one of sessionId or resumeSessionId");
  }
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", opts.model];
  if (opts.thinking !== undefined) {
    // Own-property test, not a bare index: a level like `constructor` or `toString` would
    // otherwise inherit a function from Object.prototype and bypass the rejection below.
    if (!Object.hasOwn(EFFORT_BY_THINKING, opts.thinking)) {
      throw new Error(`claudeArgs: unknown thinking level ${JSON.stringify(opts.thinking)} (known: ${Object.keys(EFFORT_BY_THINKING).join(", ")})`);
    }
    args.push("--effort", EFFORT_BY_THINKING[opts.thinking] as string);
  }
  if (opts.sessionId !== undefined) args.push("--session-id", opts.sessionId);
  else args.push("--resume", opts.resumeSessionId as string);
  args.push(
    "--permission-mode",
    "bypassPermissions",
    "--tools",
    "Bash,Read,Edit,Write,Glob,Grep",
    "--setting-sources",
    "project",
    "--strict-mcp-config",
  );
  args.push("--disable-slash-commands", "--exclude-dynamic-system-prompt-sections");
  if (shouldAppendAgents(opts.cwd)) args.push("--append-system-prompt-file", "AGENTS.md");
  if (opts.maxBudgetUsd !== undefined && opts.maxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  }
  appendPassthroughArgs(args, opts.args, HARNESS_CLAUDE_FLAGS, "claudeArgs");
  return { args, stdin: opts.prompt };
}
