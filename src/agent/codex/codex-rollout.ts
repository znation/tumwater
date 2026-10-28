/** The codex adapter's rollout reader (plans/codex-backend.md "The rollout read that
 * completes it"). `codex exec --json`'s stream reports usage only once, at the end, counting
 * the WHOLE thread (finding 4) — a resume would otherwise charge its earlier run to the follow-
 * up. The authoritative per-run figures live in `$CODEX_HOME/sessions/…/rollout-*-<id>.jsonl`,
 * Codex's own JSONL record of a session, where each run's `task_started` .. `task_complete`
 * block carries its own `token_usage_record`, `token_count` (the rate limits) and
 * `turn_context` (the model that actually ran). This module reads just that block: what the
 * stream lacks — this run's own usage, the billing and the two usage windows.
 *
 * Pure over text (plus one filesystem walk for `findRollout`): no spawn, no billing math, no
 * session state. Part 7/9's adapter wires the lines into the canonical stream in `afterRun`.
 */

import fs from "node:fs";
import path from "node:path";
import { walkFiles } from "../../files/files.js";
import { isJsonObject, nonNegativeNumber, objectOrEmpty, optionalString, parseJsonObject } from "../../files/json-object.js";
import { windowTypeName } from "./codex-stream.js";

type Json = Record<string, unknown>;

function finite(value: unknown): number | undefined {
  return nonNegativeNumber(value, undefined);
}

/** The rate-limit status of one window: `rejected` when the account hit it outright,
 * `allowed_warning` when it is at or past 90% full, else `allowed` (design §5, decision 7). */
function windowStatus(
  windowType: string,
  rateLimitReachedType: string | undefined,
  usedPercent: number | undefined,
): string {
  if (rateLimitReachedType === windowType) return "rejected";
  if (usedPercent !== undefined && usedPercent >= 100) return "rejected";
  if (usedPercent !== undefined && usedPercent >= 90) return "allowed_warning";
  return "allowed";
}

/** One run's rollout reading: the canonical `run_usage`, `billing` and `rate_limit` lines of
 * design §5 (in that order), or an empty `lines` when the turn's records are missing or
 * malformed. `switchedTo` names the model when the turn's `turn_context.model` differs from
 * what the run requested (finding 24), so the adapter can warn `codex_model_switched`. */
export interface RolloutLines {
  lines: string[];
  switchedTo?: string;
}

/** The scanner's state for one turn: which event set the read turn's usage (`lastUsage`),
 * its rate limits and model, and whether any matching `task_started` was seen (`sawTurn`). */
interface TurnRecords {
  sawTurn: boolean;
  lastUsage: Json | undefined;
  lastRateLimits: Json | undefined;
  model: string | undefined;
  planType: string | undefined;
}

/** The carrier type of one rollout line: an `event_msg` wrapper's `payload.type` when the
 * outer `type` is `event_msg`, else the outer `type` itself. `task_started`, `task_complete`
 * and `token_count` come wrapped in an `event_msg` whose `payload.type` discriminates;
 * `turn_context` and `token_usage_record` name themselves in the outer `type`. Read either. */
function lineCarrierType(parsed: Json, payload: Json): string | undefined {
  return optionalString(parsed.type) === "event_msg" ? optionalString(payload.type) : optionalString(parsed.type);
}

/** Whether a `task_started` line begins the read turn and, when it does, its turn id. Each new
 * task_started begins a fresh turn (a resume appends a second run to the same file), so the
 * collectors restart at the block we are reading. With no turn id (the adapter's read) every
 * task_started restarts them and the last block wins; with one, only the requested turn's does. */
function turnStartReading(payload: Json, sinceTurnStart: string | undefined): { turnId: string | undefined; readsTurn: boolean } {
  const turnId = optionalString(payload.turn_id);
  return { turnId, readsTurn: sinceTurnStart === undefined || turnId === sinceTurnStart };
}

/** The usage figure a `token_usage_record` line contributes — its `turn_token_usage` when it
 * carries input or output tokens, else undefined. */
function usageFromRecord(payload: Json): Json | undefined {
  const turnUsage = objectOrEmpty(payload.turn_token_usage);
  return isJsonObject(turnUsage) && (turnUsage.input_tokens !== undefined || turnUsage.output_tokens !== undefined) ? turnUsage : undefined;
}

/** The rate limits and `plan_type` a `token_count` line contributes, from its `rate_limits`
 * object (assigned even when empty). */
function rateLimitsFromCount(payload: Json): { rateLimits: Json; planType: string | undefined } {
  const rateLimits = objectOrEmpty(payload.rate_limits);
  return { rateLimits, planType: optionalString(rateLimits.plan_type) };
}

/** Scan ONE turn's records out of a rollout's text, tracking `task_started` blocks and
 * collecting the read turn's `turn_context.model`, `token_usage_record` usage, `token_count`
 * rate limits and `plan_type`. `rolloutLines` decides emptiness from `sawTurn`/`lastUsage`;
 * this scanner never decides it. */
function scanTurnRecords(text: string, sinceTurnStart: string | undefined): TurnRecords {
  let currentTurn: string | undefined;
  let sawTurn = false;
  let lastUsage: Json | undefined;
  let lastRateLimits: Json | undefined;
  let model: string | undefined;
  let planType: string | undefined;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseJsonObject(line);
    if (!parsed) continue; // a torn or foreign line belongs to no turn
    const payload = objectOrEmpty(parsed.payload);
    const ptype = lineCarrierType(parsed, payload);
    if (ptype === "task_started") {
      const start = turnStartReading(payload, sinceTurnStart);
      currentTurn = start.turnId;
      if (start.readsTurn) {
        sawTurn = true;
        lastUsage = undefined;
        lastRateLimits = undefined;
        model = undefined;
        planType = undefined;
      }
      continue;
    }
    if (sinceTurnStart !== undefined && currentTurn !== sinceTurnStart) continue;
    switch (ptype) {
      case "turn_context":
        if (model === undefined) model = optionalString(payload.model);
        break;
      case "token_usage_record":
        lastUsage = usageFromRecord(payload) ?? lastUsage;
        break;
      case "token_count": {
        const reading = rateLimitsFromCount(payload);
        lastRateLimits = reading.rateLimits;
        if (reading.planType !== undefined) planType = reading.planType;
        break;
      }
      default:
        break;
    }
  }
  return { sawTurn, lastUsage, lastRateLimits, model, planType };
}

/** Assemble the reading's canonical `run_usage`, `billing` and up-to-two `rate_limit` lines
 * (in that order), plus the `switchedTo` model comparison, from scanned records. */
function buildRolloutLines(records: TurnRecords, requestedModel: string): RolloutLines {
  // `rolloutLines` guarantees `lastUsage` is a Json object before calling (its presence check
  // stays there, so this builder never reads `sawTurn`); narrow the shared interface here.
  const lastUsage = records.lastUsage as Json;
  const { lastRateLimits, model, planType } = records;
  const lines: string[] = [];
  const input = finite(lastUsage.input_tokens) ?? 0;
  const cacheRead = finite(lastUsage.cached_input_tokens) ?? 0;
  lines.push(
    JSON.stringify({
      type: "run_usage",
      input: Math.max(0, input - cacheRead),
      output: finite(lastUsage.output_tokens) ?? 0,
      cacheRead,
      cacheWrite: finite(lastUsage.cache_write_input_tokens) ?? 0,
    }),
  );

  if (planType !== undefined) {
    // A reading with a plan_type bills on the subscription (finding 5; API-key login is
    // refused, decision 5).
    lines.push(JSON.stringify({ type: "billing", billing: "subscription" }));
  }

  // Two windows when present: the primary (5 h) and the secondary (weekly). A killed run's
  // rollout has a token_usage_record but no token_count, so it yields run_usage with no
  // rate_limit (finding 23).
  if (lastRateLimits !== undefined) {
    const reached = optionalString(lastRateLimits.rate_limit_reached_type);
    for (const key of ["primary", "secondary"] as const) {
      const windowRaw = lastRateLimits[key];
      if (!isJsonObject(windowRaw)) continue;
      const minutes = finite(windowRaw.window_minutes);
      if (minutes === undefined) continue;
      const typeName = windowTypeName(minutes);
      const usedPercent = finite(windowRaw.used_percent);
      lines.push(
        JSON.stringify({
          type: "rate_limit",
          rateLimitType: typeName,
          status: windowStatus(typeName, reached, usedPercent),
          ...(usedPercent !== undefined ? { utilization: usedPercent / 100 } : {}),
          ...(finite(windowRaw.resets_at) !== undefined ? { resetsAt: finite(windowRaw.resets_at) } : {}),
        }),
      );
    }
  }

  const switchedTo =
    model !== undefined && requestedModel !== undefined && model !== requestedModel ? model : undefined;
  return { lines, ...(switchedTo !== undefined ? { switchedTo } : {}) };
}

/** Read the records of ONE turn out of a rollout's text. A rollout is one file per thread that
 * appends a new `task_started` block per run, so the adapter's `afterRun` read (which knows
 * only the thread id that names the file, never a turn id) reads the LAST block — everything
 * after the last `task_started`. `sinceTurnStart` (optional) selects a specific turn's block
 * instead, which pins per-turn isolation: the thread total hides a resume's own figures
 * (finding 4). `requestedModel` is the `-m` tumwater passed; a turn whose `turn_context.model`
 * differs reports the switch. */
export function rolloutLines(text: string, opts: { sinceTurnStart?: string; requestedModel: string }): RolloutLines {
  const { sinceTurnStart, requestedModel } = opts;
  const records = scanTurnRecords(text, sinceTurnStart);
  // No matching task_started, or the turn's usage record is missing or malformed (a truncated
  // or torn file): there is no reading. (currentTurn will have moved on to a later run's
  // task_started in a resume-shared file; sawTurn — not currentTurn — is the real signal.)
  if (!records.sawTurn || !isJsonObject(records.lastUsage)) {
    return { lines: [] };
  }
  return buildRolloutLines(records, requestedModel);
}

/** Locate the rollout file of `$CODEX_HOME` that names the session `id`: the first
 * `sessions/…/rollout-*-<id>.jsonl` under `home`, or null. It takes no start date and does no
 * date math — the id match alone decides (finding 5: Codex's rollout name carries local time,
 * so a UTC-derived bound can miss the file; the sessions tree is one directory per active day,
 * so the walk stays small). */
export function findRollout(home: string, id: string): string | null {
  const sessionsRoot = path.join(home, "sessions");
  if (!fs.existsSync(sessionsRoot)) return null;
  const suffix = `-${id}.jsonl`;
  let found: string | null = null;
  // The walk-and-swallow recursion is files.ts's walkFiles (an unreadable dir is no match);
  // the id match alone decides, so only the one id's rollout can win. The sessions tree is one
  // directory per active day, so walking it whole to the first match stays small.
  walkFiles(sessionsRoot, (file, entry) => {
    if (found === null && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) found = file;
  });
  return found;
}
