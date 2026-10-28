import { BACKEND_IDS, FALLBACK_STEP_KEYS, MODEL_TIERS } from "./config-schema.js";
import { checkKnownKeys, show } from "./config-field-checks.js";
import { isJsonObject } from "../files/json-object.js";
import { isNonBlankString } from "../text/text.js";
import { typoSuffix } from "../text/suggest.js";
import { isBackendId, parseModelSelector } from "./config-model-selector.js";

/** Model-selector and fallback-chain checks that validateConfig (config-validation.ts) runs
 * on each model-choosing section: empty selector halves, `fallback` lists and steps, and an
 * entry's `backend` against its model. Each takes the `problems` list to append to and reads
 * nothing else, so they live beside the generic checkers in config-field-checks.ts rather
 * than inside validateConfig's body. */


/** A selector string that parses to an empty provider or model half (`"/id"`, `"p/"`) passes
 * the non-empty-string rule but never reaches pi: piArgs skips an empty value when it builds
 * its flags (config-field-checks' model-triple note), and fallbackPair drops an empty half, so
 * the team silently runs pi's default model — the same silent-ignore class the empty-string
 * rules exist to prevent. Checked only when no legacy provider is in scope: under one, the
 * whole string is the id (config-views' parse), so a `/` in it is ordinary text and the parse
 * cannot produce an empty half. */
export function checkSelectorHalves(
  obj: Record<string, unknown>,
  prefix: string,
  key: string,
  legacyProvider: unknown,
  problems: string[],
): void {
  checkSelectorValue(`${prefix}${key}`, obj[key], legacyProvider, problems);
}

/** Reject the retired model-id spellings that named a backend: a first segment that is a backend
 * id (`claude/claude-opus-5-5`) and a bare `claude-…` id resolving to pi. Each message names the
 * value and the edit — `backend` is its own key, never part of the model id. `backend` is the
 * one the selector resolves to; an opencode seam's `opencode/<id>` is a legitimate OpenCode id
 * and stays. A tier-name or non-string value is not a selector and is skipped. */
export function checkRetiredSelector(
  name: string,
  v: unknown,
  backend: string,
  problems: string[],
): void {
  if (!isNonBlankString(v) || (MODEL_TIERS as readonly string[]).includes(v)) return;
  const slash = v.indexOf("/");
  const first = slash === -1 ? undefined : v.slice(0, slash);
  if ((first === "claude" || first === "opencode") && backend !== "opencode")
    problems.push(
      `${name} ${show(v)} names the backend "${first}" in its model id — write backend: "${first}" beside model: ${show(v.slice(slash + 1))}`,
    );
  else if (slash !== -1 && backend === "claude")
    problems.push(
      `${name} ${show(v)} is a provider/model id but the backend is claude, which would run it as a paid claude model — add backend: "pi" beside it`,
    );
  else if (slash === -1 && v.startsWith("claude-") && backend === "pi")
    problems.push(
      `${name} ${show(v)} is a claude model id but the backend is pi — add backend: "claude" beside it, or write ${show(`anthropic/${v}`)} to keep it on pi`,
    );
}

/** Validate a `fallback` list (a tier's ordered chain): non-empty, each element a step — a
 * non-blank model id that is not `"pause"` (a whole-tier value only) and parses to both
 * halves, or a `{ backend?, model, maxDailyCostUsd? }` object (checkFallbackStep). */
export function checkFallbackList(
  name: string,
  list: unknown[],
  problems: string[],
  inheritedBackend = "pi",
): void {
  if (list.length === 0) problems.push(`${name} list must not be empty — name at least one model id`);
  list.forEach((el, i) => {
    const at = `${name}[${i}]`;
    if (isJsonObject(el)) checkFallbackStep(at, el, problems, inheritedBackend);
    else if (!isNonBlankString(el))
      problems.push(`${name} list element ${i} must be a non-empty model id or a step object (got ${show(el)})`);
    else if (el === "pause")
      problems.push(`${name} list element ${i} is "pause" — "pause" is only valid as a whole-tier value`);
    else {
      checkSelectorValue(at, el, undefined, problems);
      checkRetiredSelector(at, el, inheritedBackend, problems);
    }
  });
}

/** Validate one object step `{ backend?, model, maxDailyCostUsd? }`: only those keys, `backend` as
 * checkEntryBackend checks it, `model` a non-blank
 * selector (not `"pause"`) and `maxDailyCostUsd`, when present, a positive finite number. */
export function checkFallbackStep(
  at: string,
  step: Record<string, unknown>,
  problems: string[],
  inheritedBackend = "pi",
): void {
  checkKnownKeys(step, FALLBACK_STEP_KEYS, at, problems);
  checkEntryBackend(step, at, problems);
  const m = step.model;
  if (!isNonBlankString(m)) problems.push(`${at}.model must be a non-empty model id (got ${show(m)})`);
  else if (m === "pause") problems.push(`${at}.model is "pause" — "pause" is only valid as a whole-tier value`);
  else {
    checkSelectorValue(`${at}.model`, m, undefined, problems);
    checkRetiredSelector(`${at}.model`, m, typeof step.backend === "string" ? step.backend : inheritedBackend, problems);
  }
  const cap = step.maxDailyCostUsd;
  if (cap !== undefined && !(typeof cap === "number" && Number.isFinite(cap) && cap > 0))
    problems.push(`${at}.maxDailyCostUsd must be a positive number (got ${show(cap)})`);
}

/** Validate the `backend` of one model-choosing entry (a tier entry, a role or `review`): it must
 * name a registered backend, and — when the entry also names a model — the model must be a
 * valid id for that backend: claude's `--model` takes its own ids (no `/`), pi needs
 * `provider/id` and no backend id as the provider namespace. A tier-name `model` (roles,
 * review) is a reference, not an id, and is skipped. */
export function checkEntryBackend(o: Record<string, unknown>, at: string, problems: string[]): void {
  const b = o.backend;
  if (b === undefined) return;
  if (!isNonBlankString(b)) {
    if (typeof b === "string") problems.push(`${at}.backend must not be empty (got ${show(b)})`);
    else problems.push(`${at}.backend must be a string (got ${show(b)})`);
    return;
  }
  if (!isBackendId(b)) {
    problems.push(`${at}.backend must name a backend (${BACKEND_IDS.join(", ")}; got ${show(b)})${typoSuffix(b, BACKEND_IDS)}`);
    return;
  }
  const m = o.model;
  if (!isNonBlankString(m) || (MODEL_TIERS as readonly string[]).includes(m)) return;
  const sel = parseModelSelector(m);
  if (b === "claude" && sel.provider !== undefined)
    problems.push(`${at}.model ${show(m)} has a "/" but ${at}.backend is "claude" — claude takes its own model ids (e.g. "claude-sonnet-5-5")`);
  if (b === "pi" && sel.provider === undefined)
    problems.push(`${at}.model ${show(m)} has no provider but ${at}.backend is "pi" — pi needs \`provider/id\``);
  if (b === "pi" && isBackendId(sel.provider))
    problems.push(`${at}.model ${show(m)} names the backend "${sel.provider}" as its provider but ${at}.backend is "pi" — drop the "${sel.provider}/" namespace`);
}

/** Report one selector string that parses to an empty provider or model half. `name` is the
 * config path the message names — `model`, a map entry's `model.small`, a section's
 * `roles.feature.model`. Split out of checkSelectorHalves so the map forms, which enumerate
 * their entries instead of looking one key up on an object, run the identical check: a
 * selector's empty half is the same silent-ignore class wherever the string lives. */
export function checkSelectorValue(
  name: string,
  v: unknown,
  legacyProvider: unknown,
  problems: string[],
): void {
  if (!isNonBlankString(v)) return;
  const legacy = isNonBlankString(legacyProvider) ? legacyProvider : undefined;
  const sel = parseModelSelector(v, legacy);
  if (sel.provider?.trim() === "")
    problems.push(
      `${name} ${show(v)} parses to an empty provider half — pi would silently run its default model`,
    );
  if (sel.model.trim() === "")
    problems.push(
      `${name} ${show(v)} parses to an empty model half — pi would silently run its default model`,
    );
}
