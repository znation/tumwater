/** The pi adapter for the agent seam (plans/agent-backends.md "The seam"). Every piece here
 * is today's pi-specific behavior moved behind the `AgentBackend` interface — argv via
 * pi-args, the identity translator (pi's event vocabulary IS the canonical stream), the
 * stderr exit rules, and the model-fallback-clone warning — so src/agent/run-agent.ts stays
 * backend-neutral. Only pi is registered in part 1/7. */

import { piArgs } from "./pi-args.js";
import { resolveAgentBin, type ResolvedAgentBin } from "./pi-bin.js";
import { withoutLaunchServicesCheckIn } from "../process/process.js";
import { runMarkerEnv } from "../process/run-marker.js";
import { isPermanentConfigError, matchBackendFailure } from "./pi-stream.js";
import type { ResolvedModelConfig } from "../config/config-views.js";
import {
  type AgentBackend,
  type AgentExitClassification,
  type AgentExitInfo,
  type AgentInvocation,
  type AgentRunSpec,
  type StreamTranslator,
} from "../agent/agent-backend.js";

/** pi crashing on malformed JSON, as Node's JSON.parse phrases it on pi's stderr — five ticks in
 * the first 18 days died this way (one of them 2 h 39 m of director work on a fresh steering
 * prompt), each traced to a torn chunk from the model server rather than to the session. Matched
 * against the child's stderr at exit; exported for tests. */
export const TRANSIENT_PI_CRASH =
  /Unexpected end of JSON input|is not valid JSON|(Unterminated string|Unexpected non-whitespace|Expected ('|")|Bad (control|escaped) character)[^\n]* in JSON/;

/** pi's stderr warning when a requested model id has no exact definition and pi falls back to
 * the provider's default model, inheriting that default's price and context window — the silent
 * mispricing of BUGS.md 2026-10-06. Matched against the child's stderr at exit; exported for
 * tests. */
export const MODEL_FALLBACK_CLONE = /not found for provider[^\n]*Using custom model id/i;

/** `base` plus TUMWATER_NOTES_PATH when this run carries a notebook. Kept out of runMarkerEnv so
 * the two environment concerns — cross-group attribution and the notebook — stay separate. */
function withNotesPath(base: NodeJS.ProcessEnv, notesPath?: string): NodeJS.ProcessEnv {
  if (!notesPath) return base;
  return { ...base, TUMWATER_NOTES_PATH: notesPath };
}

/** pi's identity translator: every native line is already a canonical line. */
const identityTranslator: StreamTranslator = {
  translate: (line) => [line],
};

/** The agent-backend seam's pi adapter. */
export const piBackend: AgentBackend = {
  id: "pi",
  label: "pi",
  defaultBin: "pi",
  binEnv: "TUMWATER_PI_BIN",

  resolveBin(config: Pick<ResolvedModelConfig, "agentBin">): ResolvedAgentBin {
    return resolveAgentBin(config);
  },

  invocation(run: AgentRunSpec): AgentInvocation {
    // The prompt rides as the last argv element (pi's own reading of a bare trailing arg), so
    // pi delivers no stdin — the runner leaves stdio[0] "ignore" exactly as before.
    const args = [
      ...piArgs({
        config: run.config,
        sessionDir: run.sessionDir,
        sessionName: run.sessionName,
        continueSession: run.continueSession,
        agentBin: run.agentBin,
      }),
      run.prompt,
    ];
    const env = withNotesPath(
      runMarkerEnv(withoutLaunchServicesCheckIn(process.env), run.runMarker),
      run.notesPath,
    );
    return { args, env };
  },

  translator(): StreamTranslator {
    return identityTranslator;
  },

  matchStderrWarning(chunk: string, carriedTail: string): string | undefined {
    return MODEL_FALLBACK_CLONE.exec(carriedTail + chunk)?.[0]?.trim();
  },

  classifyExit(info: AgentExitInfo): AgentExitClassification {
    // A run the harness itself killed has its own cause; no stderr rule claims it.
    if (info.killed) return {};
    // A nonzero exit whose stderr ends in a JSON.parse failure is pi dying on a torn server
    // chunk: transient, retryable with --continue (the loop decides).
    if (info.code !== 0 && TRANSIENT_PI_CRASH.test(info.stderr)) return { transientPiCrash: true };
    // A provider-wide backend failure printed on pi's stderr (a severed stream, the provider's
    // own request timeout, a connection failure, a 5xx, or a model-load failure) classifies
    // through the same rule the event path uses. Never when another exit cause already claimed
    // it — one exit has one cause (BUGS.md 2026-09-30, 2026-10-07).
    const stderrBackend = matchBackendFailure(info.stderr.trim());
    return {
      transientBackend: stderrBackend !== undefined,
      backendKind: stderrBackend,
      // A permanent 4xx config error pi printed on stderr, same one rule as an event
      // errorMessage. The runner merges the parser's own configError in.
      configError: stderrBackend === undefined && isPermanentConfigError(info.stderr.trim()),
    };
  },
};

