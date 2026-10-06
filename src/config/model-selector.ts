/** Parsing model selector strings — `provider/id[:thinking]`, the form pi's own `--model`
 * accepts (plans/model-tiers.md "Selectors"). Tumwater parses them itself because pricing
 * (src/pi/pi-models.ts) needs the provider and id apart, while the argv builder
 * (src/pi/pi-args.ts) still passes `--provider` / `--model` / `--thinking` separately. Pure
 * string algebra — no I/O, no config knowledge beyond THINKING_LEVELS. */

import { THINKING_LEVELS } from "./config-schema.js";

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

/** The inverse of parseModelSelector (in its no-legacyProvider form): the selector string a
 * triple round-trips through, for messages and future writers. */
export function formatModelSelector(triple: ModelSelector): string {
  const base = triple.provider ? `${triple.provider}/${triple.model}` : triple.model;
  return triple.thinking ? `${base}:${triple.thinking}` : base;
}