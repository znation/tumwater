/**
 * The dashboard's POST config/budget command handlers (barrelled into
 * gui/gui-endpoint-commands.ts, which routes to them from src/gui/gui-server.ts):
 * config-set, config-unset, and budget — the post-handler layer onto the config-write domain
 * module. Each handler adapts HTTP and touches no socket beyond its own `res`.
 */
import { setConfigKey, setDailyBudgetUsd, unsetConfigKey } from "../config/config-write.js";
import { checkDailyBudgetUsd } from "../config/config-keys.js";
import { requireConfigKey } from "./gui-args.js";
import { badRequest, sendJson } from "./http-body.js";
import { readPostBody } from "./gui-endpoint-common.js";
import type http from "node:http";

/** Handle POST /api/budget: the dashboard's budget-badge editor saves the daily cost cap —
 * same body discipline as /api/prompt (readJsonObject), and the same shared validation rule +
 * atomic setter the TUI's Ctrl+B uses, so both surfaces write tumwater.json identically and
 * the running orchestrator picks the change up on its next ~2 s poll. */
export async function handleBudget(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"maxDailyCostUsd": 25}');
  if (!body) return;
  const value = body.maxDailyCostUsd;
  if (value === undefined) {
    badRequest(res, "maxDailyCostUsd required");
    return;
  }
  // The shared rule (finite ≥ 0; 0 disables): missing/non-finite/negative → 400 with
  // the offending value named.
  const problem = checkDailyBudgetUsd(value);
  if (problem) {
    badRequest(res, problem);
    return;
  }
  const result = setDailyBudgetUsd(root, value as number);
  if (!result.ok) {
    // The value was valid — this is a server-side failure (broken tumwater.json or
    // disk), not the client's fault.
    sendJson(res, 500, { error: result.error });
    return;
  }
  sendJson(res, 200, { ok: true, maxDailyCostUsd: value as number });
}

/** The shared 400 for a failed config mutation — the set and unset write paths both nest the
 * write's error under the key it names, so the Settings view can tell which field failed and a
 * retried request gets the same wording from either surface. Its void return keeps the guard
 * a one-liner: `if (!result.ok) return configKeyError(res, key, result);` */
function configKeyError(res: http.ServerResponse, key: string, result: { error: string }): void {
  badRequest(res, `${key}: ${result.error}`);
}
/** Handle POST /api/config-set: the Settings view's per-key Save — one curated key set to
 * one JSON value, through setConfigKey so the browser cannot drift from the CLI's rules
 * (unknown-key refusal, the per-key validators' messages, whole-candidate validateConfig,
 * atomic write the running fleet picks up live). A key outside EDITABLE_CONFIG_KEYS is
 * refused 400 with the key named — a known-but-not-curated key (customRoles) included, so
 * the panel's reach stays exactly EDITABLE_CONFIG_KEYS. The body's value is re-encoded with
 * JSON.stringify before setConfigKey parses it back, so `set model gpt-5`'s
 * JSON-or-literal rule is bypassed harmlessly: the browser already sent parsed JSON.
 * Same body discipline as /api/budget (readPostBody → 400 malformed/non-object, 413
 * oversized). */
export async function handleConfigSet(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"key": "model", "value": "gpt-5"}');
  if (!body) return;
  const key = requireConfigKey(res, body);
  if (key === null) return;
  if (body.value === undefined) {
    badRequest(res, `value required for ${key}`);
    return;
  }
  // setConfigKey takes the raw CLI text; a JSON round-trip of an already-parsed value is
  // exact (JSON.parse(JSON.stringify(v)) === v), so the shared write path applies unchanged.
  const result = setConfigKey(root, key, JSON.stringify(body.value));
  if (!result.ok) return configKeyError(res, key, result);
  sendJson(res, 200, { ok: true, key, value: result.value, oldValue: result.oldValue });
}

/** Handle POST /api/config-unset: the Settings view's per-key Clear — one curated key removed,
 * through unsetConfigKey so the browser cannot drift from `tumwater config unset`'s rules
 * (unknown-key refusal, whole-candidate validateConfig, atomic write the running fleet picks
 * up live). The same EDITABLE_CONFIG_KEYS gate as /api/config-set, so the panel's reach stays
 * exactly the curated set; a key outside it is refused 400 with the key named. Same body
 * discipline (readPostBody → 400 malformed/non-object, 413 oversized). The 200 body omits
 * `oldValue` when the file never held the key (JSON.stringify drops an undefined), so the
 * client can tell a retraction from a no-op; a file value of `null` still serializes and is a
 * real retraction. */
export async function handleConfigUnset(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"key": "model"}');
  if (!body) return;
  const key = requireConfigKey(res, body);
  if (key === null) return;
  const result = unsetConfigKey(root, key);
  if (!result.ok) return configKeyError(res, key, result);
  sendJson(res, 200, { ok: true, key, oldValue: result.oldValue });
}
