import fs from "node:fs";
import path from "node:path";
import { resolvedBackendConfig } from "../config/config-views.js";
import { envPath, findOnPath } from "../files/files.js";

/** Which backend binary the harness spawns and where that value came from — the per-backend
 * resolution `TUMWATER_<ID>_BIN` → `backends.<id>.bin` (pi's legacy `agentBin` alias) → the
 * backends' defaults (plans/agent-backends.md "Config"; plans/portability.md §5/7), the
 * executability rule the preflight askers share, and the missing-binary wording they quote.
 * The spawn (src/agent/run-agent.ts) resolves through each backend's resolveBin; the startup
 * gate (gates/startup-gate.ts) walks every enabled seam's backend through the same resolution and
 * executability rule, and doctor (doctor/doctor-checks.ts) asks them for every backend in use
 * (backendsInUse, the startup gate's rule). Each surface quotes this module's wording, so the
 * executability verdict and the pi text cannot drift between them. Split out of
 * gates/readiness.ts, which keeps the repo preconditions' shared wording: the backend binary is
 * the backends' own concern, so its resolution lives beside the spawn instead of in the gate
 * layer. */

const PI_MISSING_MESSAGE =
  "pi not found on PATH — install it (https://github.com/badlogic/pi-mono) or add its bin directory to your PATH";

/** Where a resolved backend binary's value came from (plans/portability.md §5/7): the env
 * override, the config field, or the built-in default. Shared by resolveBackendBin below
 * and every message that names the resolution, so the wording cannot drift between the
 * surfaces that report it. */
type BackendBinSource = "env" | "config" | "default";

/** A backend binary chosen for a run: the resolved path plus the source that named it
 * (backendBinSourceLabel renders the source for operators). */
export interface ResolvedBackendBin {
  bin: string;
  source: BackendBinSource;
}

/** The operator-facing name of each source, as it appears in failure text and doctor's
 * report. Exported so src/agent/run-agent.ts's spawn errors and doctor's checks quote the same
 * string. `binEnv` is the environment variable a backend reads (pi's TUMWATER_PI_BIN by
 * default; claude's adapter passes TUMWATER_CLAUDE_BIN), and `configKey` is the tumwater.json
 * key the "config" source names (pi's legacy `agentBin`, or `backends.<id>.bin`), so a claude
 * failure names its own var and key rather than pi's. */
export function backendBinSourceLabel(
  source: BackendBinSource,
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

/** The missing-binary message for a resolved backend binary. The default source keeps
 * PI_MISSING_MESSAGE byte-identical (pinned by test/cli.test.ts and test/doctor.test.ts);
 * a configured source gains the resolved value and where it came from, so a wrong
 * `agentBin` never reads as "pi is not installed" — and keeps the install hint, since a
 * wrong path and a missing install share the remedy of putting a working pi in reach. */
export function piMissingMessage(resolved: ResolvedBackendBin): string {
  if (resolved.source === "default") return PI_MISSING_MESSAGE;
  const from = backendBinSourceLabel(resolved.source);
  return `pi not found — resolved "${resolved.bin}" from ${from} is not an executable — install it (https://github.com/badlogic/pi-mono) or point ${from} at a working pi binary`;
}

/** The missing-binary message for any backend's resolved binary, used by the startup gate's walk
 * over every enabled seam's backend. pi delegates to piMissingMessage so its pinned wording is
 * untouched; any other backend names itself, the resolved value, and where it came from, so a
 * wrong `backends.<id>.bin` or `TUMWATER_<ID>_BIN` never reads as a missing pi. */
export function backendMissingMessage(resolved: ResolvedBackendBin, backend: string): string {
  if (backend === "pi") return piMissingMessage(resolved);
  if (resolved.source === "default") {
    return `${backend} not found on PATH — install it or add its bin directory to your PATH`;
  }
  const from = backendBinSourceLabelFor(backend, resolved.source);
  return `${backend} not found — resolved "${resolved.bin}" from ${from} is not an executable — install it or point ${from} at a working ${backend} binary`;
}

/** The environment variable that overrides one backend's binary: `TUMWATER_<ID>_BIN` with the id
 * uppercased — the convention resolveBackendBin and backendMissingMessage share. */
function backendBinEnv(backend: string): string {
  return `TUMWATER_${backend.toUpperCase()}_BIN`;
}

/** The tumwater.json key that names one backend's binary: pi's legacy `agentBin`, or the
 * per-backend `backends.<id>.bin`. Shared by the missing-binary and spawn-error wording so a
 * non-pi failure never names pi's key. */
export function backendBinConfigKey(backend: string): string {
  return backend === "pi" ? "agentBin" : `backends.${backend}.bin`;
}

/** The source label for one backend's resolved binary, deriving the env var and config key from
 * the backend id when the caller has no backend defaults in hand. pi keeps its pinned legacy
 * wording; any other backend names its own `TUMWATER_<ID>_BIN` and `backends.<id>.bin`. One home
 * for the convention backendMissingMessage and doctor's ok detail both read. */
export function backendBinSourceLabelFor(backend: string, source: BackendBinSource): string {
  return backend === "pi"
    ? backendBinSourceLabel(source)
    : backendBinSourceLabel(source, backendBinEnv(backend), backendBinConfigKey(backend));
}

/** Is the resolved backend binary executable right now? Returns the usable path, or null when
 * the startup gate should refuse to boot and doctor should fail its check. This is the whole
 * executability rule in one place so the two askers cannot drift: a path-shaped value (already
 * normalized against the process cwd by resolveBackendBin) is tested directly with
 * accessSync(X_OK) and required to be a regular file — a directory passes X_OK, but can never
 * be spawned, so it is rejected here with exactly the file requirement findOnPath's bare-name
 * branch applies (a bin pointed at a directory would otherwise pass the preflight and die
 * mid-run at the spawn instead of failing the gate with the "not an executable" message). A
 * bare name resolves through PATH. `pathEnv` is injectable so tests need no PATH mutation —
 * the gate and doctor both default it to the process PATH. */
export function findBackendBinary(
  resolved: ResolvedBackendBin,
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

/** Normalize a path-shaped backend binary against the harness process's cwd NOW, at
 * resolution time: the spawn runs with each run's worktree as cwd, so a relative value
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
 * through resolveBackendBin, its one caller. */
function resolveBinFrom(
  binEnv: string,
  defaultBin: string,
  configured?: string,
): ResolvedBackendBin {
  const env = process.env[binEnv]?.trim();
  if (env) return { bin: absBin(env), source: "env" };
  const cfg = configured?.trim();
  if (cfg) return { bin: absBin(cfg), source: "config" };
  return { bin: defaultBin, source: "default" };
}

/** Resolve which binary one backend spawns: `TUMWATER_<ID>_BIN` → the effective
 * `backends.<id>.bin` (config-views.ts resolvedBackendConfig, so pi's legacy `agentBin` still
 * names pi) → the backend's default. `backend` defaults to pi, the historical backend; the
 * backends pass their own id, binEnv and defaultBin, while the startup gate derives the
 * reserved backends' conventional env name and default binary when it walks every enabled seam. */
export function resolveBackendBin(
  config: Parameters<typeof resolvedBackendConfig>[0],
  backend = "pi",
  defaults: { binEnv?: string; defaultBin?: string } = {},
): ResolvedBackendBin {
  const binEnv = defaults.binEnv ?? backendBinEnv(backend);
  const defaultBin = defaults.defaultBin ?? backend;
  return resolveBinFrom(binEnv, defaultBin, resolvedBackendConfig(config, backend).bin);
}

/** The shared body of a backend's `resolveBin` adapter: resolve this backend's binary through
 * resolveBackendBin above using the backend's own id, binEnv and defaultBin — never pi's, so a
 * claude failure names TUMWATER_CLAUDE_BIN/the claude default. The two registered backends
 * (pi-backend.ts, claude-backend.ts) each expose a one-line `resolveBin` delegating here, so
 * the call convention lives in one place and cannot drift between them. */
export function resolveBinForBackend(
  config: Parameters<typeof resolvedBackendConfig>[0],
  backend: { id: string; binEnv: string; defaultBin: string },
): ResolvedBackendBin {
  return resolveBackendBin(config, backend.id, { binEnv: backend.binEnv, defaultBin: backend.defaultBin });
}
