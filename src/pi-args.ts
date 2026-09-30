/** Building the pi command line for one tick — pure argv construction with no subprocess or
 * file I/O. Split out of pi.ts, which keeps the child-process integration (runPi) and the
 * run's result types; test/pi-args.test.ts pins how config and session choices shape the
 * command line. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TumwaterConfig } from "./config-schema.js";

/** Path to the bundled bounded-output pi extension, resolved from this module's own
 * location so staged builds (.tumwater/build/<sha>) load their own copy. */
function boundedOutputExtensionPath(): string {
  return fileURLToPath(new URL("./pi-extension/bounded-output.js", import.meta.url));
}

/** The fields of PiRunOptions (src/pi.ts) that piArgs reads, plus the resolved agent
 * binary. Declared standalone rather than as a Pick of PiRunOptions so this module stays
 * cycle-free from pi.ts, which imports piArgs back for the spawn. */
interface PiArgOptions {
  config: TumwaterConfig;
  sessionDir: string;
  sessionName: string;
  continueSession?: boolean;
  /** The resolved agent binary (from resolveAgentBin); defaults to "pi". A non-pi
   * agent gets no `-e` flag — the bundled extension is pi-specific. */
  agentBin?: string;
}

/** Build the pi argv for one tick: the harness's own flags, the bundled bounded-output
 * extension, then the user's config.piArgs (so a user flag still wins). */
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
  // tumwater pi extension"). Loaded before config.piArgs so a user flag still wins.
  if (path.basename(opts.agentBin ?? "pi") === "pi") {
    args.push("-e", boundedOutputExtensionPath());
  }
  args.push(...config.piArgs);
  return args;
}
