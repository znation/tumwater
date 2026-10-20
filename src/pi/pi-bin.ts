import fs from "node:fs";
import path from "node:path";
import { resolvedAgentConfig } from "../config/config-views.js";
import { envPath, findOnPath } from "../files/files.js";

/** Which agent binary the harness spawns and where that value came from — the per-agent
 * resolution `TUMWATER_<ID>_BIN` → `backends.<id>.bin` (pi's legacy `agentBin` alias) → the
 * backends' defaults (plans/agent-backends.md "Config"; plans/portability.md §5/7), the
 * executability rule the preflight askers share, and the missing-binary wording they quote.
 * The spawn (src/agent/run-agent.ts) resolves through each backend's resolveBin; the startup
 * gate (gates/startup-gate.ts) walks every enabled seam's agent through the same resolution and
 * executability rule, and doctor (doctor/doctor-checks.ts) asks them for every agent in use
 * (agentsInUse, the startup gate's rule). Each surface quotes this module's wording, so the
 * executability verdict and the pi text cannot drift between them. Split out of
 * gates/readiness.ts, which keeps the repo preconditions' shared wording: the agent binary is
 * the backends' own concern, so its resolution lives beside the spawn instead of in the gate
 * layer. */

const PI_MISSING_MESSAGE =
  "pi not found on PATH — install it (https://github.com/badlogic/pi-mono) or add its bin directory to your PATH";

/** Where a resolved agent binary's value came from (plans/portability.md §5/7): the env
 * override, the config field, or the built-in default. Shared by resolveAgentBin below
 * and every message that names the resolution, so the wording cannot drift between the
 * surfaces that report it. */
type AgentBinSource = "env" | "config" | "default";

/** An agent binary chosen for a run: the resolved path plus the source that named it
 * (agentBinSourceLabel renders the source for operators). */
export interface ResolvedAgentBin {
  bin: string;
  source: AgentBinSource;
}

/** The operator-facing name of each source, as it appears in failure text and doctor's
 * report. Exported so src/agent/run-agent.ts's spawn errors and doctor's checks quote the same
 * string. `binEnv` is the environment variable a backend reads (pi's TUMWATER_PI_BIN by
 * default; claude's adapter passes TUMWATER_CLAUDE_BIN), and `configKey` is the tumwater.json
 * key the "config" source names (pi's legacy `agentBin`, or `backends.<id>.bin`), so a claude
 * failure names its own var and key rather than pi's. */
export function agentBinSourceLabel(
  source: AgentBinSource,
  binEnv = "TUMWATER_PI_BIN",
  configKey = "agentBin",
): string {
  switch (source) {
    case "env":
      return binEnv;
    case "config":
      return `${configKey} in tumwater.json`;
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

/** The missing-binary message for any agent's resolved binary, used by the startup gate's walk
 * over every enabled seam's agent. pi delegates to piMissingMessage so its pinned wording is
 * untouched; any other agent names itself, the resolved value, and where it came from, so a
 * wrong `backends.<id>.bin` or `TUMWATER_<ID>_BIN` never reads as a missing pi. */
export function agentMissingMessage(resolved: ResolvedAgentBin, agent: string): string {
  if (agent === "pi") return piMissingMessage(resolved);
  if (resolved.source === "default") {
    return `${agent} not found on PATH — install it or add its bin directory to your PATH`;
  }
  const from = agentBinSourceLabelFor(agent, resolved.source);
  return `${agent} not found — resolved "${resolved.bin}" from ${from} is not an executable — install it or point ${from} at a working ${agent} binary`;
}

/** The environment variable that overrides one agent's binary: `TUMWATER_<ID>_BIN` with the id
 * uppercased — the convention resolveAgentBin and agentMissingMessage share. */
function agentBinEnv(agent: string): string {
  return `TUMWATER_${agent.toUpperCase()}_BIN`;
}

/** The tumwater.json key that names one agent's binary: pi's legacy `agentBin`, or the
 * per-agent `backends.<id>.bin`. Shared by the missing-binary and spawn-error wording so a
 * non-pi failure never names pi's key. */
export function agentBinConfigKey(agent: string): string {
  return agent === "pi" ? "agentBin" : `backends.${agent}.bin`;
}

/** The source label for one agent's resolved binary, deriving the env var and config key from
 * the agent id when the caller has no backend defaults in hand. pi keeps its pinned legacy
 * wording; any other agent names its own `TUMWATER_<ID>_BIN` and `backends.<id>.bin`. One home
 * for the convention agentMissingMessage and doctor's ok detail both read. */
export function agentBinSourceLabelFor(agent: string, source: AgentBinSource): string {
  return agent === "pi"
    ? agentBinSourceLabel(source)
    : agentBinSourceLabel(source, agentBinEnv(agent), agentBinConfigKey(agent));
}

/** Is the resolved agent binary executable right now? Returns the usable path, or null when
 * the startup gate should refuse to boot and doctor should fail its check. This is the whole
 * executability rule in one place so the two askers cannot drift: a path-shaped value (already
 * normalized against the process cwd by resolveAgentBin) is tested directly with
 * accessSync(X_OK) and required to be a regular file — a directory passes X_OK, but can never
 * be spawned, so it is rejected here with exactly the file requirement findOnPath's bare-name
 * branch applies (a bin pointed at a directory would otherwise pass the preflight and die
 * mid-run at the spawn instead of failing the gate with the "not an executable" message). A
 * bare name resolves through PATH. `pathEnv` is injectable so tests need no PATH mutation —
 * the gate and doctor both default it to the process PATH. */
export function findAgentBinary(
  resolved: ResolvedAgentBin,
  pathEnv: string = envPath(),
): string | null {
  if (resolved.bin.includes("/")) {
    try {
      fs.accessSync(resolved.bin, fs.constants.X_OK); // Directories pass X_OK; require a file.
      if (fs.statSync(resolved.bin).isFile()) return resolved.bin;
      return null;
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

/** The precedence every backend shares, parameterized by its own env override and default
 * binary name: `<binEnv>` env → the configured entry's bin → `defaultBin`. An empty or
 * whitespace value falls through to the next source, so `TUMWATER_PI_BIN= tumwater start` cannot
 * wedge the team on a typo'd export. This is precedence only — resolvability is checked at the
 * preflight sites (cmdStart and doctor), never here. Private: the backends and the gate resolve
 * through resolveAgentBin, its one caller. */
function resolveBinFrom(
  binEnv: string,
  defaultBin: string,
  configured?: string,
): ResolvedAgentBin {
  const env = process.env[binEnv]?.trim();
  if (env) return { bin: absBin(env), source: "env" };
  const cfg = configured?.trim();
  if (cfg) return { bin: absBin(cfg), source: "config" };
  return { bin: defaultBin, source: "default" };
}

/** Resolve which binary one agent spawns: `TUMWATER_<ID>_BIN` → the effective
 * `backends.<id>.bin` (config-views.ts resolvedAgentConfig, so pi's legacy `agentBin` still
 * names pi) → the agent's default. `agent` defaults to pi, the historical backend; the
 * backends pass their own id, binEnv and defaultBin, while the startup gate derives the
 * reserved agents' conventional env name and default binary when it walks every enabled seam. */
export function resolveAgentBin(
  config: Parameters<typeof resolvedAgentConfig>[0],
  agent = "pi",
  defaults: { binEnv?: string; defaultBin?: string } = {},
): ResolvedAgentBin {
  const binEnv = defaults.binEnv ?? agentBinEnv(agent);
  const defaultBin = defaults.defaultBin ?? agent;
  return resolveBinFrom(binEnv, defaultBin, resolvedAgentConfig(config, agent).bin);
}

/** The shared body of a backend's `resolveBin` adapter: resolve this backend's binary through
 * resolveAgentBin above using the backend's own id, binEnv and defaultBin — never pi's, so a
 * claude failure names TUMWATER_CLAUDE_BIN/the claude default. The two registered backends
 * (pi-backend.ts, claude-backend.ts) each expose a one-line `resolveBin` delegating here, so
 * the call convention lives in one place and cannot drift between them. */
export function resolveBackendBin(
  config: Parameters<typeof resolvedAgentConfig>[0],
  backend: { id: string; binEnv: string; defaultBin: string },
): ResolvedAgentBin {
  return resolveAgentBin(config, backend.id, { binEnv: backend.binEnv, defaultBin: backend.defaultBin });
}
