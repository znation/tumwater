// vocabulary: plain
/** Parsing model selector strings — `provider/id[:thinking]`, the form pi's own `--model`
 * accepts (plans/model-tiers.md "Selectors"). Tumwater parses them itself because pricing
 * (src/pi/pi-models.ts) needs the provider and id apart, while the argv builder
 * (src/pi/pi-args.ts) still passes `--provider` / `--model` / `--thinking` separately. Pure
 * string algebra — no I/O, no config knowledge beyond THINKING_LEVELS. */

import { AGENT_IDS, THINKING_LEVELS, type AgentId, type ModelTier } from "./config-schema.js";

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

/** True when `s` names a registered agent backend — the reserved selector provider namespace
 * (`claude/<id>` always runs on claude). Validation restricts the config's `agent` key to the
 * same ids; a `provider/id` selector's provider is checked here. */
export function isAgentId(s: string | undefined): s is AgentId {
  return s !== undefined && (AGENT_IDS as readonly string[]).includes(s);
}

/** Each agent backend's per-tier default model, applied only when the config resolves no model
 * id for a seam (plans/agent-backends.md "Config" decision 5). pi has none — its own default
 * applies. It lives here, in the pure config layer, because `routeModel` runs at config-
 * resolution time and must not import the runtime backend registry. */
const AGENT_DEFAULT_MODELS: Record<AgentId, Partial<Record<ModelTier, string>>> = {
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
};

/** The backend and concrete model a resolved seam's provider/model pair routes to
 * (plans/agent-backends.md "Config"). The provider segment decides the backend: a provider
 * naming a registered agent id runs that agent (and its provider field is cleared, since it is
 * a namespace, not a pi provider); any other provider runs on pi, the one backend with
 * providers; no provider at all runs on the config's `agent`. When no model id survives the
 * resolution, the backend's tier default fills in (pi supplies none).
 *
 * Rule 3a (plans/provider-concurrency.md "Routing a bare Claude model id to claude"): a bare id
 * (no provider) that starts with `claude-` runs on claude, whatever `configAgent` says — the one
 * prefix where the model id decides the backend. A named provider still wins
 * (`anthropic/claude-…` stays pi); bare aliases (`sonnet`, `opus`) keep today's routing. */
export function routeModel(
  provider: string | undefined,
  model: string | undefined,
  configAgent: string,
  tier: ModelTier,
): { agent: string; model?: string } {
  const agent =
    provider === undefined
      ? model?.startsWith("claude-")
        ? "claude"
        : configAgent
      : isAgentId(provider)
        ? provider
        : "pi";
  if (model !== undefined) return { agent, model };
  const def = AGENT_DEFAULT_MODELS[agent as AgentId]?.[tier];
  return def !== undefined ? { agent, model: def } : { agent };
}

/** The inverse of parseModelSelector (in its no-legacyProvider form): the selector string a
 * triple round-trips through, for messages and future writers. */
export function formatModelSelector(triple: ModelSelector): string {
  const base = triple.provider ? `${triple.provider}/${triple.model}` : triple.model;
  return triple.thinking ? `${base}:${triple.thinking}` : base;
}
