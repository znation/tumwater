/**
 * The request-argument validators behind the dashboard's /api endpoints (gui/gui-endpoints.ts's
 * GET handlers and gui/gui-endpoint-commands.ts's POST handlers call them): loop-targeting role
 * validation, integer query parsing, the report
 * endpoints' days window, and the body-field checks the paired operator endpoints
 * (/api/prompt and /api/prompt-role, /api/pause and /api/pause-role) must answer with
 * identical 400 wording. Pure
 * HTTP-argument adaptation — each helper either returns the parsed value or sends the 400
 * itself and returns null/false, so a handler is one guard line per argument.
 */
import { knownRoleIdsCached } from "../config/config.js";
import { EDITABLE_CONFIG_KEYS } from "../config/config-editable-keys.js";
import { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS } from "../events/event-window.js";
import { promptLengthProblem } from "../inbox/inbox-submit.js";
import { queueFileNameProblem } from "../inbox/inbox-cancel.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { gotSuffix, parseNonNegativeInt, parsePositiveInt } from "../text/text.js";
import { typoSuffix } from "../text/suggest.js";
import { badRequest, sendJson } from "./http-body.js";
import type http from "node:http";

/** The role ids a loop-targeting endpoint accepts: when tumwater.json parses, catalog +
 * customRoles (knownRoleIds); a transiently broken file falls back to the built-in catalog
 * rather than refusing every id — the rule config.knownRoleIdsCached owns. Shared by
 * /api/transcript and the two operator endpoints so their validation and 400 wording cannot
 * drift. */
export function validRoleIds(root: string): string[] {
  return knownRoleIdsCached(root);
}

/** Validate one request's loop-targeting role against validRoleIds, sending the shared 400 on
 * a miss and reporting whether the request should stop: an absent id reads "role required
 * (valid ids: …)" — unless `allowMissing`, the wake endpoint's `{}` → all-roles default,
 * which only a truly absent `undefined` may ride; an explicit null is always rejected — and a
 * present-but-unknown one reads "unknown role X (valid ids: …)", with a "did you mean"
 * hint when the id is a string and a near miss of a valid one (text/suggest.ts's typoSuffix
 * — the same hint unknownRoleMessage arms the CLI's unknown-role errors with, so both
 * surfaces correct the same typos). /api/transcript and the
 * wake/abort operator endpoints share it so their validation and 400 wording cannot drift. */
export function rejectBadRole(root: string, res: http.ServerResponse, role: unknown, allowMissing = false): boolean {
  // The all-roles default rides only a truly absent id — check it first, so the wake path
  // (allowMissing with `{}`) never computes the id list it will not validate against.
  if (role === undefined && allowMissing) return false;
  const validIds = validRoleIds(root);
  if (role === undefined || role === null) {
    badRequest(res, `role required (valid ids: ${validIds.join(", ")})`);
    return true;
  }
  if (typeof role !== "string" || !validIds.includes(role)) {
    badRequest(res, `unknown role ${JSON.stringify(role)} (valid ids: ${validIds.join(", ")})${
      typeof role === "string" ? typoSuffix(role, validIds) : ""
    }`);
    return true;
  }
  return false;
}

/** Validate one request's file-addressed queue name (a queued prompt's basename) through
 * inbox-cancel.ts's queueFileNameProblem, sending its reason as the shared 400 and reporting
 * whether the request should stop — the file twin of rejectBadRole above. The three
 * file-addressed endpoints (/api/prompt-text, /api/prompt-cancel, /api/prompt-edit) share it
 * so their validation and 400 wording cannot drift. */
export function rejectBadQueueFileName(res: http.ServerResponse, name: unknown): boolean {
  const problem = queueFileNameProblem(name);
  if (problem === null) return false;
  badRequest(res, problem);
  return true;
}

/** Read an integer query parameter with the GUI's established discipline for an explicit
 * count: absent → `fallback` (or, when no fallback is given, the parameter is required and
 * its absence is its own 400 — "<name> required"); present but not a plain decimal integer
 * of the requested kind → 400 with the shared wording ("<name> must be a … integer (got
 * …)"). The transcript's n, the backlog's index, and history's n all ride it, so their
 * 400 wording and their absent-vs-malformed split cannot drift. windowDays deliberately
 * does not come through here — a report URL typo degrades to the default window instead of
 * erroring. Returns the parsed value, or null once the 400 is sent. */
export function intQuery(
  q: URLSearchParams,
  res: http.ServerResponse,
  name: string,
  kind: "positive" | "non-negative",
  fallback?: number,
): number | null {
  const raw = q.get(name);
  if (raw === null) {
    if (fallback !== undefined) return fallback;
    badRequest(res, `${name} required`);
    return null;
  }
  const parsed = kind === "positive" ? parsePositiveInt(raw) : parseNonNegativeInt(raw);
  if (parsed === null) {
    sendJson(
      res,
      400,
      {
        error: `${name} must be a ${kind === "positive" ? "positive" : "non-negative"} integer${gotSuffix(raw)}`,
      },
    );
    return null;
  }
  return parsed;
}

/** Clamp a parsed count into 1..max: the bound every GUI count query (`n`, `days`) applies after
 * its parse, so a request never asks for zero or more than the endpoint's cap. */
export function clampCount(n: number, max: number): number {
  return Math.min(max, Math.max(1, n));
}

/** The window both report endpoints serve, from ?days=N on the request. One exact rule,
 * shared so /api/report and /api/failures cannot drift: missing or non-decimal →
 * REPORT_DEFAULT_DAYS, out-of-range clamped to 1..REPORT_MAX_DAYS (the same bounds the CLI's
 * --days enforces, shared in report.ts) — never an error (a URL typo must degrade to the
 * default window, deliberately unlike handleTranscript's parsePositiveInt→400 idiom).
 * "Non-decimal" is the shared plain-digit rule (text.parseNonNegativeInt):
 * hex/scientific/signed/padded spellings are not counts and get the default instead of a
 * coerced value — raw Number.parseInt would read "1e3" as 1, "0x10" as 0, and "-5" as -5. */
export function windowDays(q: URLSearchParams): number {
  const n = parseNonNegativeInt(q.get("days") ?? "");
  return n === null ? REPORT_DEFAULT_DAYS : clampCount(n, REPORT_MAX_DAYS);
}

/** Pull the prompt text out of a prompt endpoint's body — the shared validator for
 * /api/prompt and /api/prompt-role, which must reject a non-string, blank, or over-long text
 * with the same 400 wording: both dashboards' prompt bars sit behind the same length rule
 * (inbox-submit.ts's promptLengthProblem) and a retried request must get identical answers from
 * either surface. Returns the validated text, or null once the 400 is sent. */
export function requirePromptText(
  res: http.ServerResponse,
  body: Record<string, unknown>,
  role: string = DIRECTOR_ROLE,
): string | null {
  const text = body.text;
  if (typeof text !== "string") {
    sendJson(
      res,
      400,
      { error: `text must be a string${text === undefined ? "" : gotSuffix(text)}` },
    );
    return null;
  }
  if (!text.trim()) {
    badRequest(res, "text required");
    return null;
  }
  const tooLong = promptLengthProblem(text, role);
  if (tooLong) {
    badRequest(res, tooLong);
    return null;
  }
  return text;
}

/** Parse and cap a dashboard `?sinceMs=` trailing-window length. The caller branches on the
 * parameter's presence, so only a present one reaches here: the value rides intQuery's
 * positive-integer rule (malformed → the shared 400), and a value above `maxMs` is a 400 built
 * by `overCap` rather than a silent clamp — an explicit window typo must not shrink to some
 * other window. Shared by the report endpoints (through reportSinceMs, event-window.ts's
 * REPORT_SINCE_MAX_MS and its "must be between 1 and …" wording) and /api/history
 * (LOGS_SINCE_MAX_MS, the CLI's "is capped at …" wording), so the parse-and-cap discipline
 * cannot drift between them; each caller keeps its own wording through `overCap`. Returns the
 * parsed length, or null once the 400 is sent. */
export function sinceMsQuery(
  q: URLSearchParams,
  res: http.ServerResponse,
  maxMs: number,
  overCap: (sinceMs: number) => string,
): number | null {
  const sinceMs = intQuery(q, res, "sinceMs", "positive");
  if (sinceMs === null) return null;
  if (sinceMs > maxMs) {
    badRequest(res, overCap(sinceMs));
    return null;
  }
  return sinceMs;
}

/** Pull the required curated config key out of a config endpoint's body — the shared validator
 * for /api/config-set and /api/config-unset, which must reject a missing or uncurated key with
 * the same 400 wording: the panel's reach stays exactly EDITABLE_CONFIG_KEYS, and the browser and
 * a retried request must get identical answers from both surfaces. An absent key reads as no
 * value (the gotSuffix convention: append only a value the request actually carried). Returns
 * the validated key, or null once the 400 is sent. */
export function requireConfigKey(
  res: http.ServerResponse,
  body: Record<string, unknown>,
): string | null {
  const key = body.key;
  if (typeof key !== "string" || !(EDITABLE_CONFIG_KEYS as readonly string[]).includes(key)) {
    badRequest(res, `key must be one of ${EDITABLE_CONFIG_KEYS.join(", ")}${key === undefined ? "" : gotSuffix(key)}${typeof key === "string" ? typoSuffix(key, EDITABLE_CONFIG_KEYS) : ""}`);
    return null;
  }
  return key;
}

/** Pull the required, non-blank string `role` out of a config POST body — the shared 400
 * (`role required`) for the role-cap, min-run-interval, instances, model, instructions,
 * role-enable/disable, and quiet-hours handlers in gui-config-commands.ts. Returns the role
 * as sent (untrimmed, not yet validated against the role list), or null once the 400 is sent. */
export function requireRoleField(res: http.ServerResponse, body: Record<string, unknown>): string | null {
  const role = body.role;
  if (typeof role !== "string" || role.trim() === "") {
    badRequest(res, "role required");
    return null;
  }
  return role;
}

/** Pull the required `paused` boolean out of a pause endpoint's body — the shared validator
 * for /api/pause and /api/pause-role, which must reject a missing or non-boolean target state
 * with the same 400 wording: the target state is explicit (`paused: true|false`), so a retried
 * request is idempotent only if both surfaces agree on what counts as an explicit state.
 * Returns null once the 400 is sent. */
export function requirePausedFlag(res: http.ServerResponse, body: Record<string, unknown>): boolean | null {
  const value = body.paused;
  if (typeof value !== "boolean") {
    sendJson(
      res,
      400,
      { error: `paused must be a boolean${value === undefined ? "" : gotSuffix(value)}` },
    );
    return null;
  }
  return value;
}
