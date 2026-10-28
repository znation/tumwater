/**
 * The per-backend capabilities that the config, prompt, watchdog, progress and doctor layers
 * read (plans/opencode-backend.md "Groundwork: the claude-only branches become backend
 * traits"). Pure — imports nothing from the runtime registry (agent-backend.ts) — so those
 * layers can read a backend's traits without pulling the registry in. That is the same reason
 * `BACKEND_DEFAULT_MODELS` lives in src/config/config-model-selector.ts.
 *
 * An id with no entry reads as pi, because src/agent/agent-run.ts routes an unregistered id to
 * the pi backend.
 */

import { HARNESS_CLAUDE_FLAGS } from "./claude/claude-args.js";
import { HARNESS_OPENCODE_FLAGS } from "./opencode/opencode-args.js";
import { HARNESS_CODEX_FLAGS } from "./codex/codex-args.js";
import { HARNESS_PI_FLAGS } from "../config/config-schema.js";

/** Whether the backend streams tool output. pi streams content-bearing tool updates, so its
 * calls are classified per command; claude, opencode and codex send none, so silence carries no
 * hang signal and every call is judged by the buffered threshold (plans/agent-backends.md
 * "Watchdogs and progress"). Only claude, opencode and codex are false; an unknown id reads as
 * pi. */
export function streamsToolOutput(backend: string | undefined): boolean {
  // Only claude, opencode and codex stream no tool output; every other id (including an
  // unregistered one) reads as pi, which does stream.
  return backend !== "claude" && backend !== "opencode" && backend !== "codex";
}

/** Whether the backend's model jobs resolve through pi's models.json. True for pi only (and an
 * unknown id, which reads as pi); a claude, opencode or codex job reads no pi pricing and needs
 * no definitions file. */
export function usesPiModels(backend: string | undefined): boolean {
  // Only claude, opencode and codex read no pi models.json; every other id (including an
  // unregistered one) reads as pi, which does.
  return backend !== "claude" && backend !== "opencode" && backend !== "codex";
}

/** The reason string config validation prints for a reserved `backends.<id>.args` flag, or
 * undefined when the flag is not reserved for that backend. Wraps the HARNESS_*_FLAGS sets for
 * claude (HARNESS_CLAUDE_FLAGS), opencode (HARNESS_OPENCODE_FLAGS), codex (HARNESS_CODEX_FLAGS)
 * and pi (HARNESS_PI_FLAGS), keeping each backend's reason wording. The flag is the bare name —
 * checkReservedArgs splits `--mode=x` on `=` before calling. */
export function reservedPassthroughFlag(backend: string, flag: string): string | undefined {
  switch (backend) {
    case "pi":
      return HARNESS_PI_FLAGS.get(flag);
    case "claude":
      return HARNESS_CLAUDE_FLAGS.has(flag) ? "it is managed by tumwater" : undefined;
    case "opencode":
      return HARNESS_OPENCODE_FLAGS.has(flag) ? "it is managed by tumwater" : undefined;
    case "codex":
      // The standalone-flag screen; the `-c <key>=…` / `--config <key>=…` config-key screen is
      // arity-aware (a `-c` token and its key are different argv elements), so config-validation
      // owns it against HARNESS_CODEX_CONFIG_KEYS (codex-args.ts) rather than here.
      return HARNESS_CODEX_FLAGS.has(flag) ? "it is managed by tumwater" : undefined;
    default:
      // An unknown backend has no known harness argv to clash with, so nothing is reserved.
      return undefined;
  }
}

/** A seam's model as one readable token: `<provider>/<model>` for a pi seam (and any unknown
 * id, which reads as pi), the bare model for claude — or "claude backend" when there is none —
 * `opencode/<model>` for opencode, whose ids all read under the opencode namespace, and the
 * bare model for codex — or "codex default" when there is none. The one home of the label,
 * shared by the doctor report and the image-input surface strings so they cannot drift. */
export function modelLabel(
  backend: string | undefined,
  provider: string | undefined,
  model: string | undefined,
): string {
  if (backend === "claude") return model ?? "claude backend";
  if (backend === "opencode") return `opencode/${model ?? "?"}`;
  if (backend === "codex") return model ?? "codex default";
  return `${provider ?? "?"}/${model ?? "?"}`;
}

/** A backend id's display name as the status surfaces show it: title-cased
 * (`id.charAt(0).toUpperCase() + id.slice(1)`, so `"claude"` → `"Claude"`, `"codex"` →
 * `"Codex"`). The one home of the spelling the subscription window's per-backend block label
 * (part 3a/9) and the later display parts share, so a backend's name cannot drift between
 * them. */
export function backendDisplayName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** A seam's own-default label when neither a provider nor a model resolves:
 * `<backend> default` — pi's historical `pi default` for the pi backend (and an unknown id,
 * which reads as pi), `claude default` for claude, and so on. The one home of the label
 * `role-render.ts`'s Model line and the status rows share, so the two surfaces cannot
 * disagree about what a seam without a model is named. */
export function backendDefaultLabel(backend: string | undefined): string {
  // Only claude, opencode and codex carry their own `<backend> default`; pi, an absent
  // backend and any unregistered id (which reads as pi) all carry pi's historical `pi
  // default`, matching streamsToolOutput's reads-as-pi window.
  if (backend === "claude" || backend === "opencode" || backend === "codex") return `${backend} default`;
  return "pi default";
}

/** The HTTP status codes the native claude and codex stream translators read as a transient
 * backend (server) failure — the `transientBackend` classification with `backendKind:
 * "server"`. 529 is Anthropic's "overloaded" spelling, which codex's `turn.failed` error
 * carries too. One home for the set the two adapters' classifiers share, so a status added
 * for one cannot go missing from the other (opencode classifies the same failure from message
 * text, not a status code, so it is not in the set). */
export const SERVER_TRANSIENT_STATUS: ReadonlySet<number> = new Set([500, 502, 503, 504, 529]);

/** Classify a failure message's prose into the transient-backend failure it names, when the
 * wire carries no structured signal: a dropped connection or a timeout, read from the message
 * text by claude's and opencode's stream translators, which both fall back to prose for the
 * statuses their native events leave to the message (claude's classifyResult and opencode's
 * classifyError end with this same connection/then-timeout tail). The single home of the
 * connection/timeout vocabulary, so the two backends' tail regexes cannot drift. undefined
 * when the text names neither. */
export function transientProseKind(
  text: string,
): { kind: "transientBackend"; backendKind: "connection" | "timeout" } | undefined {
  if (/connection|econn|refused|reset|terminated/i.test(text)) return { kind: "transientBackend", backendKind: "connection" };
  if (/timed out|timeout/i.test(text)) return { kind: "transientBackend", backendKind: "timeout" };
  return undefined;
}
