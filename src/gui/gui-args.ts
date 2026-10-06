/**
 * The request-argument validators behind the dashboard's /api endpoints (gui/gui-endpoints.ts's
 * GET handlers and gui/gui-endpoint-commands.ts's POST handlers call them): loop-targeting role
 * validation, integer query parsing, the report
 * endpoints' days window, and the body-field checks the paired operator endpoints
 * (prompt/prompt-role, pause/pause-role) must answer with identical 400 wording. Pure
 * HTTP-argument adaptation — each helper either returns the parsed value or sends the 400
 * itself and returns null/false, so a handler is one guard line per argument.
 */
import { knownRoleIdsCached } from "../config/config.js";
import { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS } from "../events/event-window.js";
import { promptLengthProblem } from "../inbox/inbox-submit.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { gotSuffix, parseNonNegativeInt, parsePositiveInt } from "../text.js";
import { typoSuffix } from "../suggest.js";
import { sendJson } from "../http-body.js";
import type http from "node:http";

/** The role ids a loop-targeting endpoint accepts: when tumwater.json parses, catalog +
 * customLoops (knownRoleIds); a transiently broken file falls back to the built-in catalog
 * rather than refusing every id — the rule config.knownRoleIdsCached owns. Shared by
 * /api/transcript and the two operator endpoints so their validation and 400 wording cannot
 * drift. */
export function validRoleIds(root: string): string[] {
  return knownRoleIdsCached(root);
}

/** Validate one request's loop-targeting role against validRoleIds, sending the shared 400 on
 * a miss and reporting whether the request should stop: an absent id reads "role required
 * (valid ids: …)" — unless `allowMissing`, the wake endpoint's `{}` → all-roles default, which
 * only a truly absent `undefined` may ride; an explicit null is always rejected — and a
 * present-but-unknown one reads "unknown role X (valid ids: …)", with a "did you mean"
 * hint when the id is a string and a near miss of a valid one (suggest.ts's suggestClosest — the same
 * hint unknownRoleMessage arms the CLI's unknown-role errors with, so both surfaces
 * correct the same typos). /api/transcript and the
 * wake/abort operator endpoints share it so their validation and 400 wording cannot drift. */
export function rejectBadRole(root: string, res: http.ServerResponse, role: unknown, allowMissing = false): boolean {
  // The all-roles default rides only a truly absent id — check it first, so the wake path
  // (allowMissing with `{}`) never computes the id list it will not validate against.
  if (role === undefined && allowMissing) return false;
  const validIds = validRoleIds(root);
  if (role === undefined || role === null) {
    sendJson(res, 400, { error: `role required (valid ids: ${validIds.join(", ")})` });
    return true;
  }
  if (typeof role !== "string" || !validIds.includes(role)) {
    sendJson(res, 400, {
      error: `unknown role ${JSON.stringify(role)} (valid ids: ${validIds.join(", ")})${
        typeof role === "string" ? typoSuffix(role, validIds) : ""
      }`,
    });
    return true;
  }
  return false;
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
    sendJson(res, 400, { error: `${name} required` });
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
  return n === null ? REPORT_DEFAULT_DAYS : Math.min(REPORT_MAX_DAYS, Math.max(1, n));
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
    sendJson(res, 400, { error: "text required" });
    return null;
  }
  const tooLong = promptLengthProblem(text, role);
  if (tooLong) {
    sendJson(res, 400, { error: tooLong });
    return null;
  }
  return text;
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
