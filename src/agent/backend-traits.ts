// vocabulary: plain
/**
 * The per-backend capabilities that the config, prompt, watchdog, progress and doctor layers
 * read (plans/opencode-backend.md "Groundwork: the claude-only branches become backend
 * traits"). Pure — imports nothing from the runtime registry (agent-backend.ts) — so those
 * layers can read a backend's traits without pulling the registry in. That is the same reason
 * `AGENT_DEFAULT_MODELS` lives in src/config/model-selector.ts.
 *
 * An id with no entry reads as pi, because src/agent/run-agent.ts routes an unregistered id to
 * the pi backend.
 */

import { HARNESS_CLAUDE_FLAGS } from "./claude/claude-args.js";
import { HARNESS_OPENCODE_FLAGS } from "./opencode/opencode-args.js";
import { HARNESS_PI_FLAGS } from "../config/config-schema.js";

/** Whether the backend streams tool output. pi streams content-bearing tool updates, so its
 * calls are classified per command; claude and opencode send none, so silence carries no hang
 * signal and every call is judged by the buffered threshold (plans/agent-backends.md
 * "Watchdogs and progress"). Only claude and opencode are false; an unknown id reads as pi. */
export function streamsToolOutput(agent: string | undefined): boolean {
  // Only claude and opencode stream no tool output; every other id (including an unregistered
  // one) reads as pi, which does stream.
  return agent !== "claude" && agent !== "opencode";
}

/** Whether the backend's model jobs resolve through pi's models.json. True for pi only (and an
 * unknown id, which reads as pi); a claude or opencode job reads no pi pricing and needs no
 * definitions file. */
export function usesPiModels(agent: string | undefined): boolean {
  // Only claude and opencode read no pi models.json; every other id (including an unregistered
  // one) reads as pi, which does.
  return agent !== "claude" && agent !== "opencode";
}

/** The reason string config validation prints for a reserved `backends.<id>.args` flag, or
 * undefined when the flag is not reserved for that backend. Wraps claude's HARNESS_CLAUDE_FLAGS
 * and pi's HARNESS_PI_FLAGS, keeping each backend's reason wording. The flag is the bare name —
 * checkReservedArgs splits `--mode=x` on `=` before calling. */
export function reservedPassthroughFlag(agent: string, flag: string): string | undefined {
  switch (agent) {
    case "pi":
      return HARNESS_PI_FLAGS.get(flag);
    case "claude":
      return HARNESS_CLAUDE_FLAGS.has(flag) ? "it is managed by tumwater" : undefined;
    case "opencode":
      return HARNESS_OPENCODE_FLAGS.has(flag) ? "it is managed by tumwater" : undefined;
    default:
      // An unknown backend has no known harness argv to clash with, so nothing is reserved.
      return undefined;
  }
}

/** A seam's model as one readable token: `<provider>/<model>` for a pi seam (and any unknown
 * id, which reads as pi), the bare model for claude — or "claude backend" when there is none —
 * and `opencode/<model>` for opencode, whose ids all read under the opencode namespace. The
 * one home of the label, shared by the doctor report and the image-input surface strings so
 * they cannot drift. */
export function modelLabel(
  agent: string | undefined,
  provider: string | undefined,
  model: string | undefined,
): string {
  if (agent === "claude") return model ?? "claude backend";
  if (agent === "opencode") return `opencode/${model ?? "?"}`;
  return `${provider ?? "?"}/${model ?? "?"}`;
}
