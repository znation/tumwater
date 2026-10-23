/** The codex adapter for the agent seam (plans/codex-backend.md §4, §5, §6): it shapes one
 * run's argv/stdin/env, translates codex's `exec --json` stream, reads the authoritative
 * rollout after the process exits, and classifies the exit's stderr — everything
 * backend-specific. src/agent/run-agent.ts owns the spawn and records this run in the session
 * ledger; codex mints its own session id (a thread id, or the resumed record's id) in the
 * stream's `thread.started`, which the runner's stream-mint pass appends to the ledger and
 * `invocation` returns so a later `exec resume` can reach it.
 *
 * Sessions resume by id, out of the team's `CODEX_HOME`. A continue takes the ledger's newest
 * record of this run's kind and resumes only when it is codex's, has this cwd, carries a UUID
 * id, and `findRollout` finds its rollout under the run's home — anything else mints a fresh
 * thread and the existing `handoff` path takes over (design §4). Together with the `resumable`
 * hook, that is every resume point's one rule.
 *
 * Registration lives in src/agent/run-agent.ts beside the pi, claude and opencode adapters; a
 * test selects codex by setting `config.agent = "codex"` on a run. A run carrying a note gets
 * the notes path in its environment (the `tumwater-notes` command on PATH reads it), as the
 * pi and claude adapters do. */

import fs from "node:fs";
import { loadConfigSafe } from "../../config/config.js";
import { resolvedBackendConfig } from "../../config/config-views.js";
import { backendBaseEnv, withNotesPath } from "../../process/run-marker.js";
import { resolveBinForBackend, type ResolvedBackendBin } from "../../pi/pi-bin.js";
import { teamRootOf, nearestTumwaterRoot } from "../../paths.js";
import { warnEventBestEffort, TUMWATER_SOURCE } from "../../events/events.js";
import { errorMessage } from "../../text/text.js";
import { codexHome, readCodexCatalog, type CodexCatalogEntry } from "./codex-catalog.js";
import type {
  AgentBackend,
  BackendBinConfig,
  AgentExitClassification,
  AgentExitInfo,
  AgentInvocation,
  AgentRunSpec,
} from "../agent-backend.js";
import { resumableSession } from "../session-ledger.js";
import { codexArgs, codexEffort } from "./codex-args.js";
import { codexEnv } from "./codex-env.js";
import { codexHookTrust } from "./codex-hook-trust.js";
import { codexWriteGuardDefinition } from "./codex-write-guard.js";
import { findRollout, rolloutLines } from "./codex-rollout.js";
import { codexTranslator, type CodexStreamTranslator } from "./codex-stream.js";

/** A codex thread id (a UUID format, e.g. `01a15c9d-6762-7931-814e-a3e6e64c1b51`). The
 * stream mints it in `thread.started`; the pre-spawn ledger record carries the session name
 * instead, so this regex is what tells a resume that a record holds a real, stream-minted id
 * worth resuming (design §4). */
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The oldest codex CLI the team targets, the sibling of `OPENCODE_MIN_VERSION`
 * (src/agent/opencode/opencode-backend.ts) and `CLAUDE_MIN_VERSION`
 * (src/agent/claude/claude-backend.ts): doctor's `codex version` row fails an installed CLI
 * below this floor (plans/codex-backend.md "Hand steps", H1). */
export const CODEX_MIN_VERSION = "0.163.0";

/** The wall-clock bound `prepare` gives each trust lookup, mirroring lookupCodexHookTrust's
 * own 15 s default (plans/codex-write-guard.md "Trust (parts 4–5)"). Settable so a test can
 * shorten the bound (to 500 ms) without waiting out the real 15 s; a hand run keeps the
 * default. */
let codexTrustLookupTimeoutMs = 15_000;

/** The test seam for the trust lookup bound: a test sets it to 500 ms and returns it to the
 * 15 s default in a finally, so a hanging app-server case stays fast without a config knob. */
export function setCodexTrustLookupTimeoutMs(ms: number): void {
  codexTrustLookupTimeoutMs = ms;
}

/** One resolved write-guard trust for a (home, definition) key, held for `invocation` to read
 * synchronously (part 6/9 installs the trusted hook; nothing reads it yet — part 5/9 only
 * warms it). `off` records a lookup failure and its reason, `trust` a resolved key and hash. */
type CodexWriteGuardTrust = { kind: "trust"; trust: { key: string; hash: string } } | { kind: "off"; reason: string };

/** The write-guard trust `prepare` has resolved, keyed by home and hook definition, so one
 * process looks each up at most once and a run's invocation never spawns `app-server` again. */
const writeGuardTrust = new Map<string, CodexWriteGuardTrust>();
/** One in-flight resolution per (home, definition) key, so concurrent runs share a single
 * `app-server` instead of starting one each (plans/codex-write-guard.md "Trust (parts 4–5)"). */
const writeGuardInFlight = new Map<string, Promise<void>>();
/** The (home, definition) keys whose `off` warning has already been logged, so a failed lookup
 * warns once per process instead of once per run. */
const writeGuardWarned = new Set<string>();

/** Warn once per process per (home, definition) that the write guard is off. The warning rides
 * the best-effort event feed on the run's root, skipped when there is no root (a hand run's
 * prepared look-up must not mint a `.tumwater`). A `trust` result logs nothing. */
function warnGuardOffOnce(key: string, root: string | undefined, state: CodexWriteGuardTrust): void {
  if (state.kind !== "off") return;
  if (writeGuardWarned.has(key)) return;
  writeGuardWarned.add(key);
  if (root !== undefined) {
    warnEventBestEffort(root, TUMWATER_SOURCE, `codex write guard off: ${state.reason}`);
  }
}

/** The (home, definition) cache key shared by the single-flight and the resolved-trust map. */
function writeGuardKey(home: string | undefined, definition: { matcher: string; command: string; timeout: number }): string {
  return `${home ?? ""}|${JSON.stringify(definition)}`;
}
/** The session this run uses: for a continue, the ledger's newest record of this kind when it
 * is codex's, has this cwd, carries a UUID thread id, and `findRollout` finds its rollout
 * under the run's home; otherwise the run is fresh (no pre-minted id — the stream names it).
 * Returns the id and whether this is a resume, so `invocation` can name it and build `exec
 * resume`. */
function resolveCodexSession(
  run: AgentRunSpec,
  home: string | undefined,
): { sessionId?: string; resumed: boolean } {
  if (run.continueSession && home !== undefined) {
    const record = resumableSession(run.sessionDir, {
      kind: run.kind,
      agent: "codex",
      cwd: run.cwd,
    });
    if (record !== null && THREAD_ID_RE.test(record.id) && findRollout(home, record.id) !== null) {
      return { sessionId: record.id, resumed: true };
    }
  }
  return { resumed: false };
}

/** Classify codex's stderr: the seam's stderr half for a CLI that died before emitting a
 * `turn.failed` (the stream's own failures are classified by the translator). A run the
 * harness killed has its own cause and is never classified here (design finding 12). The
 * codex CLI surfaces login/model/usage failures as stream JSON, so a bare nonzero exit with
 * no stream carries no signal this part has a verdict for — it stays unclassified and the
 * parser's own event-derived flags stand. */
function classifyCodexExit(info: AgentExitInfo): AgentExitClassification {
  if (info.killed) return {};
  return {};
}

/** The agent-backend seam's codex adapter. */
export const codexBackend: AgentBackend = {
  id: "codex",
  label: "Codex",
  defaultBin: "codex",
  binEnv: "TUMWATER_CODEX_BIN",

  resolveBin(config: BackendBinConfig): ResolvedBackendBin {
    return resolveBinForBackend(config, this);
  },

  invocation(run: AgentRunSpec): AgentInvocation {
    // The notes path rides beside the run marker, as the pi and claude adapters' envs do
    // (withNotesPath); from part 2/4 the run saves its note through the `tumwater-notes`
    // command on PATH, so codex configures no MCP server for notes.
    const base = withNotesPath(backendBaseEnv(run.runMarker, undefined, run.binDir), run.notesPath);
    // A team home of its own (`CODEX_HOME`) keeps team sessions and trust entries out of the
    // operator's `~/.codex` (design §4, finding 10); unset leaves the operator's home.
    const home = codexHome(resolvedBackendConfig(run.config, "codex"));
    const env = codexEnv(base, { home });
    const { sessionId, resumed } = resolveCodexSession(run, home);
    const thinking = run.config.thinking;
    // The effort (parts 5/9 and 8/9): ride the thinking level through the decoder, then gate
    // it on the model's cataloged effort levels — a level the model does not list is never
    // sent (codexEffort's `levels` half). No home (no catalog) leaves the value unclamped, as
    // before part 8/9.
    const catalog: Map<string, CodexCatalogEntry> =
      home === undefined ? new Map<string, CodexCatalogEntry>() : readCodexCatalog(home);
    const effort =
      thinking === undefined ? undefined : codexEffort(thinking, catalog.get(run.config.model ?? "")?.levels);
    const { args, stdin } = codexArgs({
      model: run.config.model ?? "",
      ...(effort !== undefined ? { effort } : {}),
      ...(resumed && sessionId !== undefined ? { resumeId: sessionId } : {}),
      args: resolvedBackendConfig(run.config, "codex").args,
      prompt: run.prompt,
    });
    // A resumed run returns its id so the runner's pre-spawn ledger record carries it; a fresh
    // run has none until the stream names it (the runner's stream-mint pass appends it).
    return { args, stdin, env, ...(resumed && sessionId !== undefined ? { sessionId } : {}) };
  },

  async prepare(run: AgentRunSpec): Promise<void> {
    // Resolve the write guard's trust under the same env and home invocation will use (the
    // run's CODEX_HOME, plans/codex-write-guard.md "Trust (parts 4–5)"), so the trust an
    // invocation later reads was looked up under the run's own config. It never throws a run
    // away: a failed lookup records `off` (and warns once) and the run continues without the
    // guard's trust.
    const base = withNotesPath(backendBaseEnv(run.runMarker, undefined, run.binDir), run.notesPath);
    const home = codexHome(resolvedBackendConfig(run.config, "codex"));
    const env = codexEnv(base, { home });
    const root = nearestTumwaterRoot(run.sessionDir);
    const definition = codexWriteGuardDefinition();
    const key = writeGuardKey(home, definition);
    // Single-flight per (home, definition): a run whose key is being resolved (or already
    // resolved) shares the one in-flight lookup, so concurrent runs start one `app-server`.
    const settled = writeGuardTrust.get(key);
    if (settled !== undefined) {
      warnGuardOffOnce(key, root, settled);
      return;
    }
    const inFlight = writeGuardInFlight.get(key);
    if (inFlight !== undefined) {
      await inFlight;
      const after = writeGuardTrust.get(key);
      if (after !== undefined) warnGuardOffOnce(key, root, after);
      return;
    }
    const promise = (async (): Promise<void> => {
      try {
        const trust = await codexHookTrust(root, {
          bin: run.agentBin,
          env,
          cwd: run.cwd,
          definition,
          timeoutMs: codexTrustLookupTimeoutMs,
        });
        writeGuardTrust.set(key, { kind: "trust", trust });
      } catch (error) {
        writeGuardTrust.set(key, { kind: "off", reason: errorMessage(error) });
      }
    })();
    writeGuardInFlight.set(key, promise);
    await promise;
    writeGuardInFlight.delete(key);
    const state = writeGuardTrust.get(key);
    if (state !== undefined) warnGuardOffOnce(key, root, state);
  },

  translator() {
    return codexTranslator();
  },

  imageInput(model: string | undefined): boolean {
    // Answer from the model catalog (part 8/9): a model reads images when its catalog entry's
    // `input_modalities` say so; a model missing from the catalog — or a run with no home to
    // read — answers false, the safe direction, so a blind image read is never silently
    // assumed readable. The home is the team's `backends.codex.configDir`, found by walking
    // up from the process's working directory to its `.tumwater` root and loading the config
    // there, the same root the runs' home and account live under (like opencode's cache).
    if (model === undefined) return false;
    const root = teamRootOf(process.cwd());
    const { config } = loadConfigSafe(root);
    const home = codexHome(resolvedBackendConfig(config ?? {}, "codex"));
    if (home === undefined) return false;
    return readCodexCatalog(home).get(model)?.images === true;
  },

  resumable(dir: string, opts: { kind: string; agent: string; cwd?: string }): boolean {
    const record = resumableSession(dir, { kind: opts.kind, agent: "codex", cwd: opts.cwd });
    if (record === null || !THREAD_ID_RE.test(record.id)) return false;
    const root = teamRootOf(dir);
    const { config } = loadConfigSafe(root);
    const home = codexHome(resolvedBackendConfig(config ?? {}, "codex"));
    if (home === undefined) return false;
    return findRollout(home, record.id) !== null;
  },

  afterRun(run: AgentRunSpec, invocation: AgentInvocation, translator: CodexStreamTranslator): string[] {
    const ct = translator;
    const home = codexHome(resolvedBackendConfig(run.config, "codex"));
    const id = invocation.sessionId ?? ct.sessionId?.();
    const fresh = invocation.sessionId === undefined;
    // The rollout is authoritative, so its loss is worth one warning: a fresh run keeps the
    // stream's own usage as a fallback, a resumed run records none (design §5, finding 4).
    const fallback = (): string[] => {
      ct.flagUsagePartial();
      if (!fresh) return [];
      const usage = ct.turnCompletedUsage();
      return usage !== undefined ? [JSON.stringify({ type: "run_usage", ...usage })] : [];
    };
    if (home === undefined || id === undefined) return fallback();
    const rollout = findRollout(home, id);
    if (rollout === null) return fallback();
    let text: string;
    try {
      text = fs.readFileSync(rollout, "utf8");
    } catch {
      return fallback();
    }
    // The stream never exposes the turn id — only the thread id that names the rollout file
    // (real captures' `task_started.turn_id` is a different UUID), so the reader selects the
    // last block, this run's, from the file the thread id located.
    const { lines, switchedTo } = rolloutLines(text, {
      requestedModel: run.config.model ?? "",
    });
    if (lines.length === 0) return fallback();
    // Codex can switch models on a usage limit by itself (finding 24): warn once and record
    // the model that actually ran in the rollout's reading.
    if (switchedTo !== undefined) ct.flagModelSwitched(run.config.model ?? "", switchedTo);
    return lines;
  },

  classifyExit: classifyCodexExit,
};
