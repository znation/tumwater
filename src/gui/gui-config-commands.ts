/**
 * The dashboard's POST config/budget command handlers (barrelled into
 * gui/gui-endpoint-commands.ts, which routes to them from src/gui/gui-server.ts):
 * config-set, config-unset, budget, role-cap, role-enable, and notify-test — the
 * post-handler layer onto
 * the config-write domain module. Each handler adapts HTTP and touches no socket beyond its
 * own `res`.
 */
import { setConfigKey, setDailyBudgetUsd, unsetConfigKey } from "../config/config-write.js";
import { checkDailyBudgetUsd } from "../config/config-keys.js";
import { testNotifyHook } from "../cli/notify-command.js";
import { rejectBadRole, requireConfigKey } from "./gui-args.js";
import { baseRoleOf } from "../roles/loop-ids.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { badRequest, sendJson } from "./http-body.js";
import { gotSuffix } from "../text/text.js";
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

/** Handle POST /api/role-cap: the dashboard role drawer's editor saves one role's daily cost
 * cap — the control the amber role-cap alert remedies. Same body discipline as /api/budget
 * (readPostBody → 400 malformed/non-object, 413 oversized); the value rides the team editor's
 * shared checkDailyBudgetUsd screen (naming the per-role dotted key), then the write goes
 * through the CLI's own setConfigKey dotted path so the per-key validator and whole-candidate
 * validateConfig (which rejects an unknown role id) own the final truth. The director has no
 * cap (role-view.ts's guard exempts it), so it is refused up front with wording that mirrors
 * handleRoleNotes. A bare `feature-2` loop id maps to its base role's cap (baseRoleOf), since
 * the cap is about the role. A write failure is configKeyError's 400 exactly as handleConfigSet
 * reports it. */
export async function handleRoleCap(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"role": "feature", "maxDailyCostUsd": 2}');
  if (!body) return;
  const role = body.role;
  if (typeof role !== "string" || role.trim() === "") {
    badRequest(res, "role required");
    return;
  }
  if (role === DIRECTOR_ROLE) {
    badRequest(res, "the director has no daily cap");
    return;
  }
  const value = body.maxDailyCostUsd;
  if (value === undefined) {
    badRequest(res, "maxDailyCostUsd required");
    return;
  }
  const baseRole = baseRoleOf(role);
  // The shared rule (finite ≥ 0; 0 disables), naming the per-role dotted key so a rejected
  // write tells the operator which key the drawer would set.
  const problem = checkDailyBudgetUsd(value, "maxDailyCostUsdPerRole." + baseRole);
  if (problem) {
    badRequest(res, problem);
    return;
  }
  // setConfigKey takes the raw CLI text; a JSON round-trip of an already-parsed value is
  // exact, so the shared per-key validator + whole-config validateConfig apply unchanged.
  const result = setConfigKey(root, "maxDailyCostUsdPerRole." + baseRole, JSON.stringify(value));
  if (!result.ok) return configKeyError(res, "maxDailyCostUsdPerRole." + baseRole, result);
  sendJson(res, 200, { ok: true, role: baseRole, maxDailyCostUsd: value as number });
}

/** Handle POST /api/role-instructions: the role drawer's standing-instructions editor — the
 * `Instructions override` row's Edit/Save. Same body discipline as /api/role-cap (readPostBody
 * → 400 malformed/non-object, 413 oversized); an empty role id is a 400, and a bare `feature-2`
 * loop id maps to its base role's override (baseRoleOf), the key tick-prompt reads — so an
 * instance edits the instructions its runs carry (readRoleBody's shared guard is not used
 * because it rejects instance ids, and the unknown-role check is validateConfig's, below).
 * The director is editable here (its override reaches its runs), unlike handleRoleNotes'
 * director refusal. An empty/whitespace-only text clears the key (unsetConfigKey, like the
 * CLI's --clear-instructions); otherwise the write goes through the CLI's own setConfigKey
 * with the same JSON.stringify wrapper --instructions-file uses, so validateConfig owns the
 * 4096-char cap and the unknown-role check, and a write failure is configKeyError's 400
 * naming the dotted key. */
export async function handleRoleInstructions(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"role": "feature", "text": "…"}');
  if (!body) return;
  const role = body.role;
  if (typeof role !== "string" || role.trim() === "") return badRequest(res, "role required");
  if (typeof body.text !== "string") return badRequest(res, `"text" must be a string — the full replacement instructions, or "" to clear it${gotSuffix(body.text)}`);
  const base = baseRoleOf(role);
  // An empty or whitespace-only buffer clears the override, like the CLI's --clear-instructions;
  // otherwise the same JSON.stringify wrapper --instructions-file uses (setConfigKey takes raw
  // CLI text, so a body that parses as JSON is stored verbatim), with validateConfig owning the
  // 4096-char cap and the unknown-role check in writeConfigMutation. Unlike quiet hours the
  // clear arm carries no role guard (the director may clear, and the unknown-role clear gap is
  // pre-existing).
  writeRoleJsonKey(
    res, root, base, `roles.${base}.instructions`, "instructions", body.text,
    (v) => JSON.stringify(v),
    (v) => `${base}: instructions saved (${v.length} chars)`,
  );
}

/** Handle POST /api/role-enable: the Settings view's "Disabled roles" card Enable button —
 * re-enables one disabled role (the GUI half of the CLI's `tumwater role <id> --enable`). Same
 * body discipline as /api/role-cap (readPostBody → 400 malformed/non-object, 413 oversized); a
 * missing, non-string, or blank role is a 400 `role required`, and a bare `feature-2` loop id
 * maps to its base role's key (baseRoleOf), so an instance enables the role it belongs to. The
 * director is accepted: it cannot be disabled, so enabling it is harmless and mirrors the CLI's
 * --enable. The write goes through the CLI's own setConfigKey with the raw JSON literal "true"
 * (so JSON.parse yields the boolean checkBoolean expects), and validateConfig's unknown-role
 * check refuses an unknown id as configKeyError's 400 before anything is written. */
export async function handleRoleEnable(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"role": "selfcheck"}');
  if (!body) return;
  const role = body.role;
  if (typeof role !== "string" || role.trim() === "") return badRequest(res, "role required");
  const base = baseRoleOf(role);
  const key = `roles.${base}.enabled`;
  // setConfigKey takes raw CLI text; the JSON literal "true" round-trips to the boolean
  // checkBoolean expects, and validateConfig owns the unknown-role check in writeConfigMutation.
  const result = setConfigKey(root, key, "true");
  if (!result.ok) return configKeyError(res, key, result);
  sendJson(res, 200, { ok: true, role: base, message: `${base}: enabled` });
}

/** Handle POST /api/role-quiet-hours: the role drawer's own-window editor sets or clears one
 * role's daily quiet-hours window — the control the `Quiet hours` row it already shows leads
 * to (the counterpart of the in-flight `tumwater role <id> --quiet-hours` CLI write). Same body
 * discipline as /api/role-cap (readPostBody → 400 malformed/non-object, 413 oversized); a
 * missing/blank role is a 400, and a bare `feature-2` loop id maps to its base role's key
 * (baseRoleOf), so an instance edits the window its runs read. The director is refused up front:
 * `quietHoursPerRole.director` is inert (roleQuietHold and doctor both exempt the director). An
 * empty/whitespace-only window clears the key (unsetConfigKey, like the CLI's --clear-quiet-hours);
 * the clear branch checks the role id explicitly (rejectBadRole) because unsetConfigKey's no-op
 * map path skips validateConfig — the guard the set branch gets free from validateConfig's
 * unknown-role refusal; otherwise the write goes through setConfigKey with the same
 * JSON.stringify wrapper, so checkQuietHours (naming quietHoursPerRole.<base>) and validateConfig
 * own the truth, and a write failure is configKeyError's 400 naming the dotted key. */
export async function handleRoleQuietHours(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, '{"role": "feature", "window": "23:00-07:00"}');
  if (!body) return;
  const role = body.role;
  if (typeof role !== "string" || role.trim() === "") return badRequest(res, "role required");
  if (role === DIRECTOR_ROLE) return badRequest(res, "the director has no quiet hours");
  if (typeof body.window !== "string") return badRequest(res, `"window" must be a string — a window like 23:00-07:00, or "" to clear it${gotSuffix(body.window)}`);
  const base = baseRoleOf(role);
  // An empty or whitespace-only window clears the hold, like the CLI's --clear-quiet-hours;
  // the clear arm carries rejectBadRole because unsetConfigKey's no-op map path (a role the
  // file never holds, an unknown id included) skips validateConfig, so without it the set
  // branch's unknown-role refusal would never fire on a clear and a bogus id would answer 200
  // "cleared" (mirrors the CLI's knownRoleIds guard). The set arm runs setConfigKey raw, its
  // map branch checking the dotted key as the label and validateConfig owning the unknown role.
  writeRoleJsonKey(
    res, root, base, `quietHoursPerRole.${base}`, "quiet hours", body.window,
    (v) => JSON.stringify(v),
    (v) => `${base}: quiet hours set to ${v}`,
    () => rejectBadRole(root, res, role),
  );
}

/** The shared 400 for a failed config mutation — the set and unset write paths both nest the
 * write's error under the key it names, so the Settings view can tell which field failed and a
 * retried request gets the same wording from either surface. Its void return keeps the guard
 * a one-liner: `if (!result.ok) return configKeyError(res, key, result);` */
function configKeyError(res: http.ServerResponse, key: string, result: { error: string }): void {
  badRequest(res, `${key}: ${result.error}`);
}

/** The set-or-clear write the two per-role JSON-config-key handlers (quiet hours, standing
 * instructions) share: an empty/whitespace `raw` unsets `key` (after `guardClear`, a per-call
 * check the clear arm runs first — quiet hours' unknown-role guard; instructions has none),
 * else sets it via setConfigKey (which JSON-encodes nothing, so `serialize` shapes the stored
 * value). `noun` names the hold in the "cleared" 200 and `setMessage` is the exact set-arm 200
 * message, threaded so each handler keeps its own wording. Always writes the response, so the
 * caller never falls through to further output. */
function writeRoleJsonKey(
  res: http.ServerResponse,
  root: string,
  base: string,
  key: string,
  noun: string,
  raw: string,
  serialize: (value: string) => string,
  setMessage: (value: string) => string,
  guardClear?: () => boolean,
): void {
  if (raw.trim() === "") {
    if (guardClear?.()) return;
    const result = unsetConfigKey(root, key);
    if (!result.ok) configKeyError(res, key, result);
    else sendJson(res, 200, { ok: true, role: base, message: `${base}: ${noun} cleared` });
    return;
  }
  const result = setConfigKey(root, key, serialize(raw));
  if (!result.ok) configKeyError(res, key, result);
  else sendJson(res, 200, { ok: true, role: base, message: setMessage(raw) });
}
/** Handle POST /api/config-set: the Settings view's per-key Save — one curated key set to
 * one JSON value, through setConfigKey so the browser cannot drift from the CLI's rules
 * (unknown-key refusal, the per-key validators' messages, whole-candidate validateConfig,
 * atomic write the running team picks up live). A key outside EDITABLE_CONFIG_KEYS is
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
 * (unknown-key refusal, whole-candidate validateConfig, atomic write the running team picks
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

/** Handle POST /api/notify-test: the Settings view's "Send test" — what `tumwater notify --test`
 * runs (testNotifyHook, under the same NOTIFY_TEST_TIMEOUT_MS bound), with the hook's stdio
 * ignored so its output never reaches the server's terminal. The body is ignored, like
 * /api/restart's. No hook set is a 409 with the CLI's wording; a hook that fails or times out is
 * still a 200 — the request worked, and `passed` carries the verdict. */
export async function handleNotifyTest(req: http.IncomingMessage, res: http.ServerResponse, root: string): Promise<void> {
  const body = await readPostBody(req, res, "{}");
  if (!body) return;
  const outcome = await testNotifyHook(root, "ignore");
  if (outcome.status === "not_configured") {
    sendJson(res, 409, { error: "notify is not configured (set `notify` in tumwater.json)" });
    return;
  }
  sendJson(res, 200, { ok: true, passed: outcome.passed, message: outcome.message });
}
