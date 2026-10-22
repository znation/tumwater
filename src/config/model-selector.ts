/** Parsing model selector strings — `provider/id[:thinking]`, the form pi's own `--model`
 * accepts (plans/model-tiers.md "Selectors"). Tumwater parses them itself because pricing
 * (src/pi/pi-models.ts) needs the provider and id apart, while the argv builder
 * (src/pi/pi-args.ts) still passes `--provider` / `--model` / `--thinking` separately. Pure
 * string algebra — no I/O, no config knowledge beyond THINKING_LEVELS. */

import { BACKEND_IDS, THINKING_LEVELS, type BackendId, type ModelTier } from "./config-schema.js";

/** The parsed form of one selector: the triple piArgs consumes. `provider` is absent for a
 * bare model pattern (pi resolves it itself), `thinking` for a selector without a level
 * suffix (the ambient `thinking` config then applies). */
export interface ModelSelector {
  provider?: string;
  model: string;
  thinking?: string;
}

/** Parse one selector string. Rules:
 * 1. A trailing `:x` is a thinking level only when `x` is in THINKING_LEVELS, so
 *    `…:together` (a provider pin) survives on the id while `…:together:low` strips to
 *    thinking `low`.
 * 2. With `legacyProvider`, the whole string is a bare id under that provider — the meaning a
 *    legacy top-level (or section) `provider` key gives `model`, so old configs keep their
 *    argv byte for byte.
 * 3. Otherwise the text before the first `/` is the provider and the rest is the id; a string
 *    with no `/` is a bare model pattern with no provider.
 */
export function parseModelSelector(s: string, legacyProvider?: string): ModelSelector {
  let rest = s;
  let thinking: string | undefined;
  const lastColon = s.lastIndexOf(":");
  if (lastColon !== -1) {
    const tail = s.slice(lastColon + 1);
    if (THINKING_LEVELS.has(tail)) {
      rest = s.slice(0, lastColon);
      thinking = tail;
    }
  }
  const base =
    legacyProvider !== undefined
      ? { provider: legacyProvider, model: rest }
      : (() => {
          const slash = rest.indexOf("/");
          if (slash === -1) return { model: rest };
          return { provider: rest.slice(0, slash), model: rest.slice(slash + 1) };
        })();
  return thinking ? { ...base, thinking } : base;
}

/** True when `s` names a registered agent backend. Validation restricts the config's `backend`
 * key to these ids; a model id never names one. */
export function isBackendId(s: string | undefined): s is BackendId {
  return s !== undefined && (BACKEND_IDS as readonly string[]).includes(s);
}

/** Resolve a seam's backend identity: its own `agent` when it carries one (configForRole,
 * reviewConfig, resolverConfig and a fallback pair's `backend` all do), else pi — the one
 * backend with providers.
 * The single home of the rule: the budget gate's claude check, pi's free-ness and
 * context-window lookups, and the image-input seam all read a seam's backend through it, so
 * no two sites can disagree on which backend a selector runs. */
export function seamAgent(seam: { agent?: string }): string {
  return seam.agent ?? "pi";
}

/** Each agent backend's per-tier default model, applied only when the config resolves no model
 * id for a seam (plans/agent-backends.md "Config" decision 5). pi has none — its own default
 * applies. It lives here, in the pure config layer, because `routeModel` runs at config-
 * resolution time and must not import the runtime backend registry. */
const BACKEND_DEFAULT_MODELS: Record<BackendId, Partial<Record<ModelTier, string>>> = {
  pi: {},
  claude: {
    small: "claude-haiku-5-5",
    default: "claude-sonnet-5-5",
    strong: "claude-opus-5-5",
  },
  // opencode has no tier defaults (design decision 3): with no model, OpenCode's own default
  // applies, exactly as pi's does. The free model is a time-limited promotion, so its id
  // belongs in tumwater.json, not in code.
  opencode: {},
  // codex's tier defaults (plans/codex-backend.md decision 4), from the catalog's own
  // descriptions (design finding 14): strong is `gpt-6-astra`, default is `gpt-6.1-sol` (Codex's
  // own default), small is `gpt-6-luna`. The director runs the strong tier, as on claude.
  codex: {
    small: "gpt-6-luna",
    default: "gpt-6.1-sol",
    strong: "gpt-6-astra",
  },
};

/** The backend and concrete model a resolved seam's provider/model pair routes to
 * (plans/agent-backends.md "Config"). The backend is the `explicitBackend` (a tier entry's,
 * role's or review's `backend` key), else the config's `backend`, else pi — a model id never
 * names one. pi keeps the parsed provider (the caller's); claude and opencode take the whole
 * `provider/model` id with no provider, verbatim; codex takes the bare model as written (there
 * is no `codex/<id>` spelling — a model id never names a backend, and a whole `codex/<id>`
 * parses to provider `codex` which codex, like pi, drops, leaving the model half). When no
 * model id survives the resolution, the
 * backend's tier default fills in (pi and opencode supply none). */
export function routeModel(
  provider: string | undefined,
  model: string | undefined,
  configBackend: string,
  tier: ModelTier,
  explicitBackend?: string,
): { agent: string; model?: string } {
  const backend = explicitBackend ?? configBackend;
  const whole =
    model !== undefined && provider !== undefined && backend !== "pi" && backend !== "codex"
      ? `${provider}/${model}`
      : model;
  if (whole !== undefined) return { agent: backend, model: whole };
  const def = BACKEND_DEFAULT_MODELS[backend as BackendId]?.[tier];
  return def !== undefined ? { agent: backend, model: def } : { agent: backend };
}

/** The inverse of parseModelSelector (in its no-legacyProvider form): the selector string a
 * triple round-trips through, for messages and future writers. */
export function formatModelSelector(triple: ModelSelector): string {
  const base = triple.provider ? `${triple.provider}/${triple.model}` : triple.model;
  return triple.thinking ? `${base}:${triple.thinking}` : base;
}
