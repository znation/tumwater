/** True when `value` is a plain JSON object — not null, not an array, not a scalar. The one
 * definition of "a JSON object at this position" for every consumer that parses untrusted
 * JSON (the state/marker/info files, the harness event log, pi's stdout log lines, an HTTP
 * request body, tumwater.json's sections, a model's cost map, the qa coverage ledger), so the
 * three-part check cannot be spelled out slightly differently — or forgotten — at one site
 * while the others reject the same torn/foreign value. Narrows to an indexable object, which
 * also removes the `as Record<string, unknown>` cast each caller used to add after the check.
 *
 * JSON.parse("null") succeeds and yields null, and an array is an object in JS: both pass a
 * bare `typeof x === "object"` and then throw or misread when indexed, so the null and array
 * clauses are part of the definition, not extras. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read an untrusted JSON field that should be a string list, returning its string entries
 * when it is an array and [] otherwise — the one home of the "an event/record field is the
 * list or it is nothing" read every formatter applies (event-format.ts's review_rejected
 * reasons, dep_install packages, config_changed keys; src/failure/failure-state-change.ts's
 * config_changed keys; time-spend.ts's review-rejection reasons; team-state.ts's paused-roles
 * list). A torn or hand-edited line
 * never throws and never renders a placeholder: the field reads as absent, and the caller's
 * empty-list branch fires. Foreign entries inside an array are dropped for the same reason —
 * letting them through made `join` render "[object Object]" and handed
 * truncateExample's `.trim()` an object (a TypeError) — so every returned element is a
 * string. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Read an untrusted JSON field that should be a number, returning `fallback` when it is
 * absent, not a number, or not finite (NaN/±Infinity poison arithmetic and comparisons: a
 * NaN costUsd makes every budget-cap comparison false, so the cap never trips) — the one
 * home of the "the field is the number or it is nothing" read. The call sites, by the
 * fallback each passes: event-read.ts's eventRun (run → 0), eventUsage (tokens, costUsd →
 * 0), eventDayKey (ts → null), runStartMap and runSpanMs (both ts → null);
 * event-format.ts's elapsed (ms → null), gigabytes (v → 0), minutes (ms → 0), and the
 * build_stale, slot_wait, restart, and permit_reserve renderers (aheadCommits, waitedMs,
 * abortedRuns, reserve → 0); phrases.ts's budgetPhrase (spentUsd, capUsd → 0); redeploy.ts's
 * autoRestartRecord (lastAt → null); build/build-info.ts's readBuildInfo (builtAt → 0);
 * failure/failure-state-change.ts's model_fallback_ended (durationMs → 0) and build_stale
 * renderer (aheadCommits → 0); gates/maintenance-quota.ts's foldLine and seed (ev.ts → null);
 * team/orchestrator-info.ts's isFiniteNumber (v → undefined); team/team-state.ts's
 * standingMarker, pausedRoles, and standingRolesUntil (until → undefined);
 * operator/operator-requests.ts's consumeWakeRequest (notBeforeMs → undefined);
 * git/slots-state.ts's readSlotRecord (pinnedAt, lastReleasedAt → null); git/worktree-use.ts's
 * readWorktreeRecord (lastUsedAt, reclaimedAt → undefined); this file's own nonNegativeNumber
 * (whose call sites are enumerated below); and test/test-runner.ts's
 * orderByDuration cost (→ Infinity, the "no recorded duration" marker). */
export function finiteNumber<T>(value: unknown, fallback: T): number | T {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Read an untrusted JSON field or wire number that must be non-negative, returning `fallback`
 * when it is absent, not a number, not finite, or negative — finiteness plus the >= 0 floor,
 * the shared base of every "a count or amount is unusable, read the fallback" site. A negative
 * amount is as poisonous as NaN: it runs a spend total backwards and makes every `>= cap`
 * comparison false, so the daily budget's safety valve would never trip. The call sites, by
 * the fallback each passes: budget/budget.ts's spendNumber (dayCostUsd/usd → 0),
 * runner/runner-state.ts's healNumber (every numeric RunnerState field → 0),
 * run/run-usage.ts's counter (each persisted usage count → 0), pi/pi-stream.ts's usageNumber
 * (one wire usage number → 0), ui/progress-data.ts's message_end read (totalTokens → the
 * previous context, output and its peak floor → 0), time-spend.ts's runDurationMs (an event's
 * durationMs → null, the "no own duration" marker), pi-extension/context-budget.ts's
 * contextNote (usedTokens, usedWindow → null), pi-extension/context-shake.ts's percentOf
 * (tokens, contextWindow → null), merge/merge-queue.ts's isMergeEntry (run, enqueuedAt,
 * revisionRound → null), git/slots-state.ts's isSlotLease (since, pid → null); and
 * agent/claude/claude-stream.ts's canonicalUsage (each wire usage
 * number → 0) and its result/retry/rate-limit reads (api_error_status, attempt,
 * maxAttempts, error_status, resetsAt, utilization, total_cost_usd → undefined). */
export function nonNegativeNumber<T>(value: unknown, fallback: T): number | T {
  const n = finiteNumber(value, fallback);
  return typeof n === "number" && n >= 0 ? n : fallback;
}

/** Parse `text` as JSON and require the result to be a plain object, returning null when
 * either half fails — the one home of the "read one JSON value or read it as no data" policy
 * every line-oriented parser here applies (parseEventLine on the harness event log,
 * parsePiEventLine on pi's log lines, PiStreamParser.feedLine on pi's stdout). A torn or
 * partial line, a non-JSON fragment, or a valid-JSON scalar/`null`/array is never a thrower
 * and never a truthy stand-in for data: it reads as nothing, exactly as isJsonObject's
 * definition above requires. Callers that need the parse ERROR (not just its absence) keep
 * their own try/catch, like config-write.ts. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `value` when it is a JSON object (isJsonObject), `{}` otherwise — the one home of the
 * "this section is the object or it is nothing" read, so a torn, hand-edited, or foreign value
 * at a nested position reads as an empty section instead of being indexed. */
export function objectOrEmpty(value: unknown): Record<string, unknown> {
  return isJsonObject(value) ? value : {};
}

/** Assemble a stream translator's canonical usage block from the four already-validated non-
 * negative counts and the USD cost — the one home of the shape both the claude and opencode
 * translators (agent/claude/claude-stream.ts, agent/opencode/opencode-stream.ts) build, so the
 * `totalTokens` sum and the `cost.total` envelope cannot drift between backends. The wire-
 * specific field-name reads stay in each translator; this owns only the identical assembly. */
export function canonicalUsageBlock(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
  costTotal: number,
): Record<string, unknown> {
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    totalTokens: input + cacheRead + cacheWrite + output,
    cost: { total: costTotal },
  };
}
