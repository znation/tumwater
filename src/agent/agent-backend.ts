/** The backend seam (plans/agent-backends.md "The seam"): what one non-interactive agent
 * run needs from its backend — how to build the command, how to translate its native stdout
 * into tumwater's canonical event stream, and how to classify its exit. src/agent/run-agent.ts
 * owns everything backend-neutral (spawn, marker, watchdogs, abort, group kill and marker
 * sweep, stderr capture); a backend registered here supplies the rest. src/agent/run-agent.ts
 * registers the pi and claude adapters here.
 *
 * The registry is keyed by id and fed by explicit registration (src/agent/run-agent.ts
 * registers both adapters at load), so a test can register a fake backend without importing a
 * real one. */

import type { AgentConfig } from "../config/config-schema.js";
import type { ResolvedModelConfig } from "../config/config-views.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { PiRunKind } from "../pi/pi-event-line.js";
import type { ResolvedAgentBin } from "../pi/pi-bin.js";
import { hasResumableSession } from "./session-ledger.js";

/** The backend id used when a config names none: pi, the harness's default backend. */
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
  /** Which kind of run this is (authoring or gate). The claude adapter uses it to pick the
   * session ledger record it may resume, and its translator warning carries it. */
  kind: PiRunKind;
  /** The resolved agent binary (see AgentBackend.resolveBin). */
  agentBin: string;
  /** This run's cross-group attribution marker, already appended to any inherited one. */
  runMarker: string;
  /** The role notebook to export as TUMWATER_NOTES_PATH, when this run carries one. */
  notesPath?: string;
  /** The notes shim directory (notesShimDir under the team root) to prepend to this run's
   * PATH, when run-agent could install it — how a run on any backend finds the
   * `tumwater-notes` command (plans/notes-command.md "Reaching it from a run"). Undefined
   * when the install failed or this run is not a harness run. */
  binDir?: string;
  /** The remaining daily budget this run may spend, in USD, when the caller can cap it. The
   * claude adapter forwards it as `--max-budget-usd` (plans/agent-backends.md §7); backends
   * with no such flag ignore it. Undefined means no per-run cap. */
  maxBudgetUsd?: number;
}

/** One run's command line: argv, optional stdin whose bytes the runner writes and closes, and
 * the process environment. A backend that carries its prompt as the last argv element returns
 * no stdin (today's pi); one that feeds the prompt on stdin returns it here. */
export interface AgentInvocation {
  args: string[];
  stdin?: string;
  env: NodeJS.ProcessEnv;
  /** The backend session id this run used: minted for a fresh claude run, the resumed
   * record's id for a continue. Absent for pi, which mints no id ahead of the run and
   * resumes by session dir. The runner records it in the session ledger. */
  sessionId?: string;
}

/** The config fields a backend's resolveBin reads (plans/agent-backends.md "Config"): the
 * per-agent entries plus pi's legacy aliases. Every field is optional, so a bare `{}` or
 * pi-bin.ts's resolvedAgentConfig view both type-check. */
export interface AgentBinConfig {
  backends?: Record<string, AgentConfig>;
  agentBin?: string;
  piArgs?: string[];
}

/** One run's native-stdout-to-canonical translator (plans/agent-backends.md "Canonical event
 * stream"): `translate` takes one complete native line (no trailing newline) and returns the
 * canonical line(s) it becomes. pi's vocabulary IS the canonical stream, so its translator is
 * the identity. Stateful per run (the claude translator batches streaming assistant events). */
export interface StreamTranslator {
  translate(line: string): string[];
  /** Native shapes this run could not map — plus any per-run degradation like a result-less
   * run's `cost_unknown` — each once and in first-seen order. The runner forwards each as an
   * `agent_unknown_event` warning after the run. Optional: a translator whose native stream IS
   * canonical (pi's identity) reports none, and a fully-mapped run reports an empty list. */
  warnings?(): string[];
  /** Flush any canonical line(s) the translator still holds when the native stream ends,
   * called once at process close after the last native line. A batching translator (claude)
   * folds split-block assistant events into one `message_end` emitted only when the next
   * message / user event / result arrives, so a run the harness kills before that closing
   * event would otherwise drop its last assistant message from the canonical stream and raw
   * log. The identity translator holds nothing and omits this. */
  finalize?(): string[];
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

/** One registered backend's contract — the seam's per-backend half: its identity and binary,
 * and the command builder, stdout translator, resume check, and exit classifier run-agent.ts
 * reads at run time. */
export interface AgentBackend {
  /** The registry key; also the `agent` config value and selector namespace. */
  id: string;
  /** Human-facing name for doctor/status/error text. */
  label: string;
  /** The binary name when nothing configures one. */
  defaultBin: string;
  /** The environment variable that overrides the binary. */
  binEnv: string;
  /** The minimum CLI version `model` needs (plans/agent-backends.md "Every seam, checked"):
   * claude gates which models work and how they are priced, so doctor fails an installed CLI
   * below a configured model's floor. Optional — a backend with no version gate omits it. */
  minVersion?(model: string): string | undefined;
  /** Resolve which binary this backend spawns and where the value came from, reading its own
   * `backends.<id>.bin` entry through pi/pi-bin.ts's resolveBackendBin. */
  resolveBin(config: AgentBinConfig): ResolvedAgentBin;
  /** Build the argv, stdin and environment for one run. */
  invocation(run: AgentRunSpec): AgentInvocation;
  /** A fresh, per-run native-to-canonical line translator. */
  translator(): StreamTranslator;
  /** Observe one stderr chunk (with the runner's carried tail for a match that straddles two
   * chunks) for a backend-specific warning worth surfacing; the matched text, or undefined. */
  matchStderrWarning?(chunk: string, carriedTail: string): string | undefined;
  /** Reconciliation the backend runs after the process exits and before the run folds its
   * result — e.g. opencode's authoritative session export (plans/opencode-backend.md §6).
   * Called exactly once in the child close handler, only when the run was not already settled
   * (a spawn `error` settles before `close` fires, so a binary that never started spends no
   * export on a session never created) and was not killed by the harness. It returns canonical
   * lines that the runner writes and parses like streamed ones (the translator is passed so a
   * hook whose export is incomplete can add a warning like `opencode_usage_partial`, which the
   * runner's finish() drains afterwards). Optional — most backends omit it. */
  afterRun?(run: AgentRunSpec, invocation: AgentInvocation, translator: StreamTranslator): string[];
  /** Whether this backend can resume a session in `dir` for a run of `opts.kind`: the
   * backend-aware resume guard (plans/agent-backends.md "Sessions"). pi continues the newest
   * session file in the dir, claude resumes a ledger id from its recorded cwd. Optional — a
   * backend with no hook falls back to the session-file check. */
  /** Whether a session of `opts.kind` is resumable in `dir` for this backend. `configDir` is
   * the team's configured claude config dir (threaded so a claude resume guard and the run's
   * own env can never drift); the pi and opencode hooks ignore it. */
  resumable?(dir: string, opts: { kind: string; agent: string; cwd?: string }, configDir?: string): boolean;
  /** Whether a model this backend runs reads images (plans/image-input.md "Capability"). The
   * claude adapter answers true (every Claude model reads images, and Claude Code's Read tool
   * returns them as image blocks); a backend without the hook leaves the answer to its own
   * model catalog — pi's rules live in src/agent/image-input.ts / pi-models.ts's
   * `piModelImageInput`. */
  imageInput?(model: string | undefined): boolean;
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

/** Whether the backend for `opts.agent` can resume a session in `dir` for a run of
 * `opts.kind`: the one resume guard every resume point uses (plans/agent-backends.md
 * "Sessions"), so a claude author or gate run resumes through its ledger id instead of being
 * read as having no session. Falls back to the backend-neutral session-file check when the
 * backend is unregistered or supplies no `resumable` hook. */
export function agentSessionResumable(
  dir: string,
  opts: { kind: string; agent: string; cwd?: string },
  configDir?: string,
): boolean {
  const backend = agentBackend(opts.agent);
  if (backend?.resumable) return backend.resumable(dir, opts, configDir);
  return hasResumableSession(dir);
}
