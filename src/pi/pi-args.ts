/** Building the pi command line for one tick — pure argv construction with no subprocess or
 * file I/O. Split out of pi.ts, which keeps the child-process integration (runPi) and the
 * run's result types; test/pi-args.test.ts pins how config and session choices shape the
 * command line. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TumwaterConfig } from "../config-schema.js";

/** Paths to the bundled pi extensions, in load order, resolved from this module's own
 * location so staged builds (.tumwater/build/<sha>) load their own copies: bounded-output caps
 * oversized tool results, and context-budget then appends its context-usage note to the
 * (already bounded) result that crosses a threshold. */
export function bundledExtensionPaths(): string[] {
  return ["bounded-output.js", "context-budget.js"].map((file) =>
    fileURLToPath(new URL(`../pi-extension/${file}`, import.meta.url)),
  );
}

/** The fields of PiRunOptions (src/pi/pi.ts) that piArgs reads, plus the resolved agent
 * binary. Declared standalone rather than as a Pick of PiRunOptions so this module stays
 * cycle-free from pi.ts, which imports piArgs back for the spawn. */
interface PiArgOptions {
  config: TumwaterConfig;
  sessionDir: string;
  sessionName: string;
  continueSession?: boolean;
  /** The resolved agent binary (from resolveAgentBin); defaults to "pi". A non-pi
   * agent gets no `-e` flags — the bundled extensions are pi-specific. */
  agentBin?: string;
}

/** Build the pi argv for one tick: the harness's own flags, the bundled extensions, then the
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
    for (const ext of bundledExtensionPaths()) args.push("-e", ext);
  }
  args.push(...config.piArgs);
  return args;
}
