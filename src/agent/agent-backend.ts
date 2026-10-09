/** The backend seam (plans/agent-backends.md "The seam"): what one non-interactive agent
 * run needs from its backend — how to build the command, how to translate its native stdout
 * into tumwater's canonical event stream, and how to classify its exit. src/agent/run-agent.ts
 * owns everything backend-neutral (spawn, marker, watchdogs, abort, group kill and marker
 * sweep, stderr capture); a backend registered here supplies the rest. Only `pi` is registered
 * in part 1/7 — this module is the plug point the later parts hang claude off.
 *
 * The registry is keyed by id and fed by explicit registration (src/agent/run-agent.ts
 * registers the pi adapter at load), so a test can register a fake backend without importing a
 * real one. */

import type { ResolvedModelConfig } from "../config/config-views.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { ResolvedAgentBin } from "../pi/pi-bin.js";

/** The backend id used when a config names none — the harness's historical, only agent. */
export const DEFAULT_AGENT = "pi";

/** Backend-neutral description of one run, handed to `invocation`. The runner has already
 * resolved the binary and minted the run's TUMWATER_RUN mark, so the backend only shapes the
 * command and environment. */
export interface AgentRunSpec {
  cwd: string;
  prompt: string;
  config: ResolvedModelConfig;
  sessionDir: string;
  sessionName: string;
  continueSession?: boolean;
  /** The resolved agent binary (see AgentBackend.resolveBin). */
  agentBin: string;
  /** This run's cross-group attribution marker, already appended to any inherited one. */
  runMarker: string;
  /** The role notebook to export as TUMWATER_NOTES_PATH, when this run carries one. */
  notesPath?: string;
}

/** One run's command line: argv, optional stdin whose bytes the runner writes and closes, and
 * the process environment. A backend that carries its prompt as the last argv element returns
 * no stdin (today's pi); one that feeds the prompt on stdin returns it here. */
export interface AgentInvocation {
  args: string[];
  stdin?: string;
  env: NodeJS.ProcessEnv;
}

/** One run's native-stdout-to-canonical translator (plans/agent-backends.md "Canonical event
 * stream"): `translate` takes one complete native line (no trailing newline) and returns the
 * canonical line(s) it becomes. pi's vocabulary IS the canonical stream, so its translator is
 * the identity. Stateful per run (the claude translator batches streaming assistant events). */
export interface StreamTranslator {
  translate(line: string): string[];
}

/** What the runner knows at exit that a backend's `classifyExit` may need. `killed` is true
 * when the harness itself ended the run (abort, timeout, quiet-kill); such a run has its own
 * cause and no backend classifier may override it. */
export interface AgentExitInfo {
  code: number | null;
  stderr: string;
  killed: boolean;
}

/** What a backend adds to the run's result at exit, given the exit code and the captured
 * stderr. `transientPiCrash` is the backend's transient-crash verdict; `transientBackend` and
 * `backendKind` name a provider-wide stderr failure; `configError` is the stderr half of a
 * permanent config error (the parser's own configError is merged by the runner). */
export interface AgentExitClassification {
  transientPiCrash?: boolean;
  transientBackend?: boolean;
  backendKind?: PiRunResult["backendKind"];
  configError?: boolean;
}

export interface AgentBackend {
  /** The registry key; also the `agent` config value and selector namespace. */
  id: string;
  /** Human-facing name for doctor/status/error text. */
  label: string;
  /** The binary name when nothing configures one. */
  defaultBin: string;
  /** The environment variable that overrides the binary. */
  binEnv: string;
  /** Resolve which binary this backend spawns and where the value came from. */
  resolveBin(config: Pick<ResolvedModelConfig, "agentBin">): ResolvedAgentBin;
  /** Build the argv, stdin and environment for one run. */
  invocation(run: AgentRunSpec): AgentInvocation;
  /** A fresh, per-run native-to-canonical line translator. */
  translator(): StreamTranslator;
  /** Observe one stderr chunk (with the runner's carried tail for a match that straddles two
   * chunks) for a backend-specific warning worth surfacing; the matched text, or undefined. */
  matchStderrWarning?(chunk: string, carriedTail: string): string | undefined;
  /** Classify the exit's stderr into the run result's transient/config fields. */
  classifyExit(info: AgentExitInfo): AgentExitClassification;
}

const registry = new Map<string, AgentBackend>();

/** Register one backend under its id, replacing any previous entry with the same id. */
export function registerAgentBackend(backend: AgentBackend): void {
  registry.set(backend.id, backend);
}

/** The backend registered under `id`, or undefined when none is — the caller decides whether
 * an unknown id is a hard error. */
export function agentBackend(id: string): AgentBackend | undefined {
  return registry.get(id);
}
