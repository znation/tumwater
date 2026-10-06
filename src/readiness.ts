import fs from "node:fs";
import path from "node:path";
import type { TumwaterConfig } from "./config/config-schema.js";
import { findOnPath } from "./files/files.js";

/** The pre-flight messages behind the readiness gate. startup-gate.ts answers with the first
 * unmet precondition (cmdRun and requireReadyRepo fail on it, the self-redeploy refuses a swap
 * on it) and doctor.ts reports each one individually, but every surface describes the same
 * problems — so the wording lives here once and cannot drift.
 * `GIT_MISSING_MESSAGE` (git/git-run.ts) is the sibling for a machine with no git binary. */
export const NOT_A_REPO_MESSAGE = "not a git repository (run `git init` first)";
export const NO_COMMITS_MESSAGE =
  "the repo has no commits yet; `tumwater init` creates the first one";
export const DETACHED_HEAD_MESSAGE =
  "the repo's primary checkout is detached; check out your main branch first";
export const NOT_INITIALIZED_MESSAGE =
  "not initialized (run `tumwater init <prompt>` first — or a bare `tumwater init` when the project brief (TUMWATER.md or README.md) already carries the prompt)";
const PI_MISSING_MESSAGE =
  "pi not found on PATH — install it (https://github.com/badlogic/pi-mono) or add its bin directory to your PATH";

/** Where a resolved agent binary's value came from (plans/portability.md §5/7): the env
 * override, the config field, or the built-in default. Shared by resolveAgentBin below
 * and every message that names the resolution, so the wording cannot drift between the
 * surfaces that report it. */
type AgentBinSource = "env" | "config" | "default";

export interface ResolvedAgentBin {
  bin: string;
  source: AgentBinSource;
}

/** The operator-facing name of each source, as it appears in failure text and doctor's
 * report. Exported so pi.ts's spawn errors and doctor's checks quote the same string. */
export function agentBinSourceLabel(source: AgentBinSource): string {
  switch (source) {
    case "env":
      return "TUMWATER_PI_BIN";
    case "config":
      return "agentBin in tumwater.json";
    case "default":
      return "the PATH default";
  }
}

/** The missing-binary message for a resolved agent binary. The default source keeps
 * PI_MISSING_MESSAGE byte-identical (pinned by test/cli.test.ts and test/doctor.test.ts);
 * a configured source gains the resolved value and where it came from, so a wrong
 * `agentBin` never reads as "pi is not installed" — and keeps the install hint, since a
 * wrong path and a missing install share the remedy of putting a working pi in reach. */
export function piMissingMessage(resolved: ResolvedAgentBin): string {
  if (resolved.source === "default") return PI_MISSING_MESSAGE;
  const from = agentBinSourceLabel(resolved.source);
  return `pi not found — resolved "${resolved.bin}" from ${from} is not an executable — install it (https://github.com/badlogic/pi-mono) or point ${from} at a working pi binary`;
}

/** Is the resolved agent binary executable right now? Returns the usable path, or null when
 * the startup gate should refuse to boot and doctor should fail its check. This is the whole
 * executability rule in one place so the two askers cannot drift: a path-shaped value (already
 * normalized against the process cwd by resolveAgentBin) is tested directly with
 * accessSync(X_OK); a bare name resolves through PATH. `pathEnv` is injectable so tests need
 * no PATH mutation — the gate and doctor both default it to the process PATH. */
export function findAgentBinary(
  resolved: ResolvedAgentBin,
  pathEnv: string = process.env.PATH ?? "",
): string | null {
  if (resolved.bin.includes("/")) {
    try {
      fs.accessSync(resolved.bin, fs.constants.X_OK);
      return resolved.bin;
    } catch {
      return null;
    }
  }
  return findOnPath(resolved.bin, pathEnv);
}

/** Normalize a path-shaped agent binary against the harness process's cwd NOW, at
 * resolution time: the spawn runs with each tick's worktree as cwd, so a relative value
 * left as given would name a different file there than the run preflight and doctor (which
 * evaluate against the process cwd) had already accepted. An absolute path comes back
 * normalized; a bare name — no separator — is left for PATH resolution exactly as before.
 * No filesystem calls: the two preflight sites test resolvability, so resolution itself
 * stays trivially unit-testable. */
function absBin(value: string): string {
  return value.includes("/") ? path.resolve(value) : value;
}

/** Resolve which agent binary the harness spawns: TUMWATER_PI_BIN → config.agentBin →
 * "pi" (plans/portability.md §5/7). An empty or whitespace value falls through to the
 * next source, so `TUMWATER_PI_BIN= tumwater run` cannot wedge the fleet on a typo'd
 * export. This is precedence only — resolvability is checked at the preflight sites
 * (cmdRun and doctor), never here. */
export function resolveAgentBin(config: Pick<TumwaterConfig, "agentBin">): ResolvedAgentBin {
  const env = process.env.TUMWATER_PI_BIN?.trim();
  if (env) return { bin: absBin(env), source: "env" };
  const configured = config.agentBin?.trim();
  if (configured) return { bin: absBin(configured), source: "config" };
  return { bin: "pi", source: "default" };
}
