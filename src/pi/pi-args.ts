/** Building the pi command line for one run — pure argv construction with no subprocess or
 * file I/O. Split out of pi.ts; the child-process integration (runPi) now lives in
 * src/agent/agent-run.ts and the run's result types in src/pi/pi-run-result.ts, while
 * test/pi-args.test.ts pins how config and session choices shape the command line. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedModelConfig } from "../config/config-views.js";

/** Paths to the bundled pi extensions, in load order, resolved from this module's own
 * location so staged builds (.tumwater/build/<sha>) load their own copies: bounded-output caps
 * oversized tool results, context-shake then reclaims old bulky results at 70% of the window,
 * context-budget appends its context-usage note to the (already bounded) result that crosses a
 * threshold, strip-thinking drops the model's replayed thinking from each request on a
 * small-window chat-completions model, trim-system-prompt drops pi's docs section from the
 * system prompt, and write-guard refuses an edit or write outside the run's worktree. Notes ride
 * the `tumwater-notes` command on
 * every backend from part 2/4 on, so the role-notes extension is no longer bundled. */
export function bundledExtensionPaths(): string[] {
  return [
    "bounded-output.js",
    "context-shake.js",
    "context-budget.js",
    "strip-thinking.js",
    "trim-system-prompt.js",
    "write-guard.js",
  ].map((file) => fileURLToPath(new URL(`../pi-extension/${file}`, import.meta.url)));
}

/** pi 1.2.0's built-in extensions other than `mcp`, read from pi's own `dist/extensions/index.js`.
 * Team runs skip pi's auto-discovery with `--no-extensions`, then re-enable exactly these with an
 * explicit `-e builtin:` — so an installed pi package, a `~/.pi/agent/extensions` file, a target
 * repo's own `.pi/extensions`, and pi's built-in MCP extension (which reads `~/.pi/agent/mcp.json`)
 * can never smuggle an operator MCP server (e.g. funes) into a team run, while behavior is
 * otherwise unchanged. A pi bump that renames or adds a built-in is a visible diff here; doctor
 * prints the same names so a package meant for the team does not vanish silently. */
export const PI_KEPT_BUILTINS = ["llama.cpp", "codemode", "tool-search"] as const;

/** The fields of PiRunOptions (src/agent/agent-run.ts) that piArgs reads, plus the resolved
 * agent binary. Declared standalone rather than as a Pick of PiRunOptions so this module stays
 * cycle-free from pi-backend.ts, which imports piArgs back for the command line. */
interface PiArgOptions {
  /** The role/reviewer/fallback-resolved config view (configForRole, reviewRunConfig,
   * applyFallbackModel): its `model` is the concrete selector id — a tier map must be
   * resolved to the seam's tier before a run, and this type refuses to carry one. */
  config: ResolvedModelConfig;
  sessionDir: string;
  sessionName: string;
  continueSession?: boolean;
  /** The resolved agent binary (from resolveBackendBin); defaults to "pi". A non-pi
   * agent gets no `-e` flags — the bundled extensions are pi-specific. */
  agentBin?: string;
}

/** Build the pi argv for one run: the harness's own flags, the bundled extensions, then the
 * user's config.piArgs (so a user flag still wins). */
export function piArgs(opts: PiArgOptions): string[] {
  const { config } = opts;
  const args = ["--print", "--mode", "json", "--session-dir", opts.sessionDir];
  // Each role has its own session dir, so --continue resumes that role's session.
  if (opts.continueSession) args.push("--continue");
  else args.push("-n", opts.sessionName);
  if (config.provider) args.push("--provider", config.provider);
  if (config.model) args.push("--model", config.model);
  if (config.thinking) args.push("--thinking", config.thinking);
  // Bound oversized tool results in-session (PLANS.md "Bound tool output head+tail with a
  // tumwater pi extension") and tell the model how full its window is at fixed thresholds.
  // Loaded before config.piArgs so a user flag still wins.
  if (path.basename(opts.agentBin ?? "pi") === "pi") {
    // Disable pi's discovered extensions (packages, ~/.pi/agent/extensions, a repo's own
    // .pi/extensions, and the built-in MCP reader for ~/.pi/agent/mcp.json), then re-enable only
    // the named built-ins so operator MCP servers stay out of team runs. Kept before tumwater's
    // own `-e` extensions; config.piArgs still wins (appended last).
    args.push("--no-extensions");
    for (const builtin of PI_KEPT_BUILTINS) args.push("-e", `builtin:${builtin}`);
    for (const ext of bundledExtensionPaths()) args.push("-e", ext);
  }
  args.push(...config.piArgs);
  return args;
}
