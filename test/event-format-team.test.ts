/** The team-control family of formatEvent tests (src/events/event-format.ts): the events the
 * harness
 * emits as it manages the team — the daily-cost budget's transitions (and its per-role cap
 * siblings), the live config changes (maxConcurrent, sessionRetentionDays, edited keys), the
 * operator and breaker pause/resume events, and the team-wide 429/backend holds with their
 * kinds. These tests live only here — event-format.test.ts holds no copies of them. They share
 * one rendering
 * contract — a routine state change renders plainly, never with the warning prefix — so they
 * are tested together, apart from the run/merge/review event lines in event-format.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import { formatEvent } from "../src/events/event-format.js";
import { formatTime } from "../src/text/datetime.js";

// The daily cost budget's transition events (plans/daily-cost-budget.md): routine state
// changes like counters_reset — plain lines carrying the spend and cap that triggered them,
// no warning prefix.
test("formatEvent renders the budget warning with the spend phrase and the still-open gate", () => {
  const warned = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "budget_warning",
    spentUsd: 40.005,
    capUsd: 50,
  } as never);
  assert.match(warned, /tumwater\s+budget warning — \$40\.01 of \$50\.00 of the daily cap spent; runs still start/);
});

test("formatEvent names the top spenders on a budget warning and ignores malformed entries", () => {
  const base = { ts: 0, source: "tumwater", type: "budget_warning", spentUsd: 40.005, capUsd: 50 };
  const top = formatEvent({
    ...base,
    topRoles: [{ role: "feature", spentUsd: 30 }, { role: "plan", spentUsd: 10.01 }],
  } as never);
  assert.match(top, /budget warning — \$40\.01 of \$50\.00 of the daily cap spent \(most by feature \$30\.00, plan \$10\.01\); runs still start/);
  const bad = formatEvent({ ...base, topRoles: [null, { role: 3, spentUsd: 1 }, { role: "x", spentUsd: "1" }] } as never);
  assert.match(bad, /of the daily cap spent; runs still start/);
});

test("formatEvent renders the per-role cap warning naming the role and that it keeps running", () => {
  const warned = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "role_cap_warning",
    role: "docs",
    spentUsd: 0.85,
    capUsd: 1,
  } as never);
  assert.match(warned, /tumwater\s+role docs at \$0\.85 of \$1\.00 of its daily cap — it keeps running/);
  assert.match(warned, /raise or remove the cap in tumwater\.json before it pauses/);
});

test("formatEvent renders the budget transition events plainly with spend and cap", () => {
  const paused = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "budget_paused",
    spentUsd: 50.123,
    capUsd: 50,
  } as never);
  assert.match(paused, /tumwater\s+budget paused — \$50\.12 of \$50\.00 daily cost reached/);
  assert.ok(!paused.includes("warning"), "a routine state change is not a warning");

  const topRoles = [{ role: "feature", spentUsd: 40 }, { role: "plan", spentUsd: 10.12 }];
  const pausedTop = formatEvent({ ts: 0, source: "tumwater", type: "budget_paused", spentUsd: 50.12, capUsd: 50, topRoles } as never);
  assert.match(pausedTop, /budget paused — \$50\.12 of \$50\.00 daily cost reached \(most by feature \$40\.00, plan \$10\.12\); roles start no new runs/);
  const fallbackTop = formatEvent({ ts: 0, source: "tumwater", type: "budget_fallback", spentUsd: 50.12, capUsd: 50, topRoles } as never);
  assert.match(fallbackTop, /daily cost reached \(most by feature \$40\.00, plan \$10\.12\); roles continue on /);

  const resumed = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "budget_resumed",
    spentUsd: 12.345,
    capUsd: 50,
  } as never);
  assert.match(resumed, /tumwater\s+budget resumed \(\$12\.35 of \$50\.00 today\)/);

  // The per-role cap transitions (src/gates/role-cap-gates.ts) name the role, its spend vs its
  // cap, and the two lift paths; the resume states the role runs again. Team-rendering
  // siblings of the budget pause/resume above, so they live here too.
  const rolePaused = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "role_cap_paused",
    role: "docs",
    spentUsd: 0.5,
    capUsd: 0.5,
  } as never);
  assert.match(rolePaused, /tumwater\s+role docs paused — \$0\.50 of \$0\.50 of its daily cap spent/);
  assert.match(rolePaused, /raised or removed in tumwater\.json or the local day rolls over/);
  assert.ok(!rolePaused.includes("warning"), "a routine state change is not a warning");

  const roleResumed = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "role_cap_resumed",
    role: "docs",
  } as never);
  assert.match(roleResumed, /tumwater\s+role docs resumed — it is under its daily cap again and runs again/);

  // The handback (PLANS.md 2026-09-30): the reopen names which in-flight fallback runs were
  // handed back to the primary, so the resulting aborted runs read as the budget reopening.
  const handback = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "budget_handback",
    roles: ["steward", "plan"],
  } as never);
  assert.match(handback, /tumwater\s+budget reopened: handed steward, plan back to the primary/);
  const bareHandback = formatEvent({ ts: 0, source: "tumwater", type: "budget_handback" } as never);
  assert.match(bareHandback, /budget reopened: handed \? back to the primary/);

  // A torn or hand-edited event line could carry no payloads; the fallback must still render.
  const bare = formatEvent({ ts: 0, source: "tumwater", type: "budget_paused" } as never);
  assert.match(bare, /budget paused — \$0\.00 of \$0\.00 daily cost reached/);

  // The cost n/a fallback (plans/fallback-model.md): a switch names the model that took over,
  // and a pause names a configured fallback the gate refused — the operator's next action.
  const fallback = formatEvent({
    ts: Date.UTC(2026, 0, 2, 3, 4, 5),
    source: "tumwater",
    type: "budget_fallback",
    spentUsd: 10.5,
    capUsd: 10,
    provider: "omlx",
    model: "local-free",
  } as never);
  assert.match(
    fallback,
    /tumwater\s+over-cap model — \$10\.50 of \$10\.00 daily cost reached; roles continue on omlx\/local-free \(cost n\/a\)/,
  );
  const refused = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "budget_paused",
    spentUsd: 10.5,
    capUsd: 10,
    fallbackRejected: "omlx/typo",
  } as never);
  assert.match(refused, /budget paused — \$10\.50 of \$10\.00 daily cost reached \(over-cap model omlx\/typo is not a cost n\/a model in pi's models\.json\)/);
  // A free fallback the breaker demoted (BUGS.md 2026-09-20): the backend is what to fix, and
  // the team retries it on its own — both belong on the line.
  const demoted = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "budget_paused",
    spentUsd: 10.5,
    capUsd: 10,
    fallbackDemoted: "omlx/qwen",
    failures: 3,
  } as never);
  assert.match(
    demoted,
    /budget paused — \$10\.50 of \$10\.00 daily cost reached \(over-cap model omlx\/qwen is not serving — 3 runs failed in a row on it; one trial run retries it after a cool-down\)/,
  );
  assert.ok(!demoted.includes("warning"), "a routine state change is not a warning");
  // Every branch ends by naming how the pause lifts.
  for (const line of [paused, bare, refused, demoted])
    assert.match(line, /; roles start no new runs until maxDailyCostUsd is raised or removed in tumwater\.json or the local day rolls over$/);
  assert.match(refused, /models\.json\); roles start/);
  assert.match(demoted, /after a cool-down\); roles start/);
});

// The live concurrency-cap change event: a routine state
// change like counters_reset — a plain line carrying from → to in that order, no warning
// prefix.
test("formatEvent renders the maxConcurrent change event plainly with from and to", () => {
  const line = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "max_concurrent_changed",
    from: 1,
    to: 4,
  } as never);
  assert.match(line, /tumwater\s+maxConcurrent changed: 1 → 4/);
  assert.ok(!line.includes("warning"), "a routine state change is not a warning");

  // A torn or hand-edited event line could carry no payloads; the fallback must still render.
  const bare = formatEvent({ ts: 0, source: "tumwater", type: "max_concurrent_changed" } as never);
  assert.match(bare, /maxConcurrent changed:/);
});

// The live session-retention change event: a routine
// state change like max_concurrent_changed — a plain line carrying from → to, no warning
// prefix.
test("formatEvent renders the retention change event plainly with from and to", () => {
  const line = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "retention_changed",
    from: 30,
    to: 1,
  } as never);
  assert.match(line, /tumwater\s+sessionRetentionDays changed: 30 → 1/);
  assert.ok(!line.includes("warning"), "a routine state change is not a warning");

  // A torn or hand-edited event line could carry no payloads; the fallback must still render.
  const bare = formatEvent({ ts: 0, source: "tumwater", type: "retention_changed" } as never);
  assert.match(bare, /sessionRetentionDays changed:/);
});

// The live config-change event: a routine state change
// like its maxConcurrent/retention siblings — a plain line naming the edited keys, no warning.
test("formatEvent renders the config change event plainly with the edited keys", () => {
  const line = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "config_changed",
    keys: ["provider", "thrashTurns"],
  } as never);
  assert.match(line, /tumwater\s+config changed: provider, thrashTurns/);
  assert.ok(!line.includes("warning"), "a routine state change is not a warning");

  // A torn or hand-edited event line could carry no keys; the fallback must still render.
  const bare = formatEvent({ ts: 0, source: "tumwater", type: "config_changed" } as never);
  assert.match(bare, /config changed$/);
  const empty = formatEvent({ ts: 0, source: "tumwater", type: "config_changed", keys: [] } as never);
  assert.match(empty, /config changed$/);
});
// Operator-intent gate (src/orchestrator/orchestrator.ts): `tumwater pause`/`resume` log these once
// per
// transition. Both are routine state changes an operator reads at a glance; the paused line
// states the scope and the director exemption, the resumed line says role runs are back.
test("formatEvent renders the team pause and resume events plainly", () => {
  const paused = formatEvent({ ts: 0, source: "tumwater", type: "team_paused" } as never);
  assert.match(
    paused,
    /tumwater\s+team paused — roles start no new runs \(director keeps running\)$/,
    `the pause must state its scope and the director exemption: ${paused}`,
  );
  assert.ok(!paused.includes("warning"), `a deliberate pause is routine, not a warning: ${paused}`);

  const until = Date.UTC(2026, 9, 20, 14, 5, 0);
  const timed = formatEvent({ ts: 0, source: "tumwater", type: "team_paused", until, reason: "deploy freeze" } as never);
  assert.ok(
    timed.endsWith(
      `team paused — roles start no new runs until ${formatTime(new Date(until))}: deploy freeze (director keeps running)`,
    ),
    timed,
  );
  const corrupt = formatEvent({ ts: 0, source: "tumwater", type: "team_paused", until: "soon", reason: 7 } as never);
  assert.match(corrupt, /team paused — roles start no new runs \(director keeps running\)$/);

  const resumed = formatEvent({ ts: 0, source: "tumwater", type: "team_resumed" } as never);
  assert.match(resumed, /tumwater\s+team resumed — roles run again$/, `resume line: ${resumed}`);
  assert.ok(!resumed.includes("warning"), `a resume is routine, not a warning: ${resumed}`);
  assert.match(
    formatEvent({ ts: 0, source: "tumwater", type: "team_resumed", expired: true } as never),
    /team resumed — roles run again \(its timed pause ran out\)$/,
  );
  assert.match(
    formatEvent({ ts: 0, source: "tumwater", type: "role_resumed", role: "docs", expired: true } as never),
    /role docs resumed — it runs again \(its timed pause ran out\)$/,
  );
  assert.match(
    formatEvent({ ts: 0, source: "tumwater", type: "team_resumed", expired: "yes" } as never),
    /team resumed — roles run again$/,
  );
});

// Per-role pause (`tumwater pause --role <id>`): the team pause's narrower sibling. Both lines
// name the role, and the paused line states what stays running — every other role, the
// director included.
test("formatEvent renders the per-role pause and resume events with the role named", () => {
  const paused = formatEvent({ ts: 0, source: "tumwater", type: "role_paused", role: "docs" } as never);
  assert.match(
    paused,
    /tumwater\s+role docs paused — it starts no new runs \(the rest of the team keeps running\)$/,
    `the pause must name the role and what keeps running: ${paused}`,
  );
  assert.ok(!paused.includes("warning"), `a deliberate pause is routine, not a warning: ${paused}`);
  const until = Date.UTC(2026, 9, 20, 12, 0, 0);
  const timed = formatEvent({ ts: 0, source: "tumwater", type: "role_paused", role: "docs", until } as never);
  assert.match(
    timed,
    new RegExp(`role docs paused — it starts no new runs until ${formatTime(new Date(until))} \\(the rest of the team keeps running\\)$`),
  );
  const junk = formatEvent({ ts: 0, source: "tumwater", type: "role_paused", role: "docs", until: "soon" } as never);
  assert.equal(junk, paused);

  const resumed = formatEvent({ ts: 0, source: "tumwater", type: "role_resumed", role: "docs" } as never);
  assert.match(resumed, /tumwater\s+role docs resumed — it runs again$/, `resume line: ${resumed}`);
  assert.ok(!resumed.includes("warning"), `a resume is routine, not a warning: ${resumed}`);

  // role_streak_paused (src/gates/streak-gate.ts): the breaker's pause IS the harness handling the
  // failure — routine with an explanation, like rate_limit_hold, never a warning. It names
  // the streak depth and how to lift it.
  const streakPaused = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "role_streak_paused",
    role: "docs",
    streak: 10,
  } as never);
  assert.match(
    streakPaused,
    /tumwater\s+role docs paused — 10 runs failed in a row; fix the cause and resume it \(tumwater resume --role <id>\)$/,
    `breaker pause line: ${streakPaused}`,
  );
  assert.ok(!streakPaused.includes("warning"), `the breaker's pause is routine, not a warning: ${streakPaused}`);
  const withError = (lastError: string) =>
    formatEvent({ ts: 0, source: "tumwater", type: "role_streak_paused", role: "docs", streak: 10, lastError } as never);
  const named = withError("pi exited 1\n  at runTick");
  assert.match(
    named,
    /role docs paused — 10 runs failed in a row — last error: pi exited 1 at runTick; fix the cause and resume it \(tumwater resume --role <id>\)$/,
    `names the last error: ${named}`,
  );
  assert.ok(!named.includes("warning"), `still routine: ${named}`);
  const clipped = withError("x".repeat(300));
  const shown = /last error: (.*); fix the cause/.exec(clipped)?.[1] ?? "";
  assert.equal(shown.length, 120);
  assert.ok(shown.endsWith("…"), `clipped with an ellipsis: ${shown}`);
  assert.equal(withError("   "), streakPaused, "a blank lastError renders the summary-less line");
});

// Team-wide 429 hold (src/team/team-hold.ts; BUGS.md 2026-09-21 "A 429 storm still has no
// team-wide hold"): the hold is the harness handling a storm, so both lines are routine. The
// hold line names who saw the 429s, how long nothing new starts, a relapse when the storm came
// straight back, and the director exemption.
test("formatEvent renders the 429 hold and its re-open plainly", () => {
  const hold = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "rate_limit_hold",
    roles: ["bugfix", "coverage"],
    holdMs: 60_000,
    escalation: 0,
  } as never);
  assert.match(
    hold,
    /tumwater\s+waiting: provider limit — bugfix, coverage rate-limited by the provider; roles on every provider start no new runs for 60s \(director keeps running\)$/,
    `the hold must name its roles, duration and scope: ${hold}`,
  );
  assert.ok(!hold.includes("warning"), `the hold is routine, not a warning: ${hold}`);

  const relapse = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "rate_limit_hold",
    roles: ["dedupe", "feature"],
    holdMs: 15 * 60_000,
    escalation: 4,
  } as never);
  assert.match(relapse, /for 15m \(relapse 4\) \(director keeps running\)$/, `relapse line: ${relapse}`);

  const resumed = formatEvent({ ts: 0, source: "tumwater", type: "rate_limit_resumed" } as never);
  assert.match(resumed, /tumwater\s+provider limit lifted — roles on every provider run again$/, `resumed line: ${resumed}`);
});

// The hold's generalization (PLANS.md 2026-09-29): a backend-failure kind renders as a backend
// hold naming the kind, while the rate-limit kind keeps the exact wording every historical
// event has.
test("formatEvent renders a backend hold with its kind, and keeps the 429 wording for rate limits", () => {
  const backend = formatEvent({
    ts: 0,
    source: "tumwater",
    type: "rate_limit_hold",
    kind: "connection",
    roles: ["bugfix", "clean"],
    holdMs: 60_000,
    escalation: 0,
  } as never);
  assert.match(
    backend,
    /tumwater\s+waiting: backend failing \(connection error\) — bugfix, clean hit backend failures; roles on every provider start no new runs for 60s \(director keeps running\)$/,
    `backend hold line: ${backend}`,
  );
  const modelLoad = formatEvent({
    ts: 0, source: "tumwater", type: "rate_limit_hold", kind: "model-load", roles: ["dedupe"], holdMs: 120_000, escalation: 1,
  } as never);
  assert.match(modelLoad, /waiting: backend failing \(model load failure\) — dedupe hit backend failures; roles on every provider start no new runs for 2m \(relapse 1\)/, `model-load line: ${modelLoad}`);

  // A timeout storm names its own phrase too — the digest pools plain and progressing run
  // timeouts under this kind, and a timeout hold must not borrow a connection's wording.
  const timeout = formatEvent({
    ts: 0, source: "tumwater", type: "rate_limit_hold", kind: "timeout", roles: ["tests"], holdMs: 60_000, escalation: 0,
  } as never);
  assert.match(
    timeout,
    /tumwater\s+waiting: backend failing \(request timed out\) — tests hit backend failures; roles on every provider start no new runs for 60s \(director keeps running\)$/,
    `timeout hold line: ${timeout}`,
  );
  const timeoutResumed = formatEvent({
    ts: 0, source: "tumwater", type: "rate_limit_resumed", kind: "timeout",
  } as never);
  assert.match(
    timeoutResumed,
    /tumwater\s+backend recovered \(request timed out\) — roles on every provider run again$/,
    `timeout resumed line: ${timeoutResumed}`,
  );

  // The lift names what actually ended (BUGS.md 2026-09-29): the resumed event carries the
  // ended hold's kind, so a backend hold's re-open must not render as "429 hold lifted".
  const backendResumed = formatEvent({
    ts: 0, source: "tumwater", type: "rate_limit_resumed", kind: "connection",
  } as never);
  assert.match(
    backendResumed,
    /tumwater\s+backend recovered \(connection error\) — roles on every provider run again$/,
    `backend resumed line: ${backendResumed}`,
  );
  // A rate-limit hold's lift (and a torn resumed line with no kind) keeps the historical wording.
  const rlResumed = formatEvent({
    ts: 0, source: "tumwater", type: "rate_limit_resumed", kind: "rate-limit",
  } as never);
  assert.match(rlResumed, /provider limit lifted — roles on every provider run again$/, `rate-limit resumed line: ${rlResumed}`);
});

test("formatEvent renders main_red_hold as its message with no warning prefix", () => {
  const message = "main abc1234 is red (test: x) — code merges blocked until main is green";
  const line = formatEvent({ ts: 0, type: "main_red_hold", source: "tumwater", message } as never);
  assert.ok(line.endsWith(message), `line: ${line}`);
  assert.ok(!line.includes("warning:"), `line: ${line}`);
});

// The disk-floor events (the gate sampler's disk_low/disk_ok/disk_reclaim) render each GB field
// one-decimal. A torn or hand-edited event whose value is missing or non-numeric must read "0.0",
// never "NaN", for freeGB, holdGB, and freedGB alike.
test("formatEvent renders the disk-floor events' GB fields one-decimal and never NaN", () => {
  const low = formatEvent({ ts: 0, source: "tumwater", type: "disk_low", freeGB: 12.34, holdGB: 5 } as never);
  assert.match(low, /waiting: low disk — 12\.3 GB free on the workspaces volume \(floor 5\.0 GB\)/, `disk low line: ${low}`);
  const ok = formatEvent({ ts: 0, source: "tumwater", type: "disk_ok", freeGB: 12.34 } as never);
  assert.match(ok, /disk recovered — 12\.3 GB free on the workspaces volume/, `disk ok line: ${ok}`);
  const reclaim = formatEvent({
    ts: 0, source: "tumwater", type: "disk_reclaim", mode: "pressure", worktrees: ["a", "b"], freedGB: 1.25, freeGB: 40,
  } as never);
  assert.match(reclaim, /disk reclaim \(pressure\) — freed 1\.3 GB from a, b; 40\.0 GB free now/, `disk reclaim line: ${reclaim}`);

  // Corrupt values: each GB field falls back to 0.0 rather than interpolating NaN.
  const torn = formatEvent({ ts: 0, source: "tumwater", type: "disk_low", freeGB: "x", holdGB: null } as never);
  assert.match(torn, /waiting: low disk — 0\.0 GB free on the workspaces volume \(floor 0\.0 GB\)/, `torn disk low line: ${torn}`);
  const tornReclaim = formatEvent({ ts: 0, source: "tumwater", type: "disk_reclaim", freedGB: "x", freeGB: null } as never);
  assert.match(tornReclaim, /freed 0\.0 GB from \?; 0\.0 GB free now/, `torn disk reclaim line: ${tornReclaim}`);
});

// The subscription usage-window events (plans/agent-backends.md §8, PLANS.md part 6c/7): the
// account's own throttle lines, routine-with-explanation like the failure holds. The reset
// stamp renders local HH:MM:SS through the shared formatTime; a torn line without resetsAt
// omits the clause rather than printing NaN.
test("formatEvent renders the subscription-window warning, limited, and reset lines", () => {
  const resetsAt = Date.UTC(2026, 9, 10, 14, 30, 0);
  const clock = formatTime(new Date(resetsAt));
  const warning = formatEvent({
    ts: 0, source: "tumwater", type: "claude_window_warning", windowType: "five_hour", resetsAt,
  } as never);
  assert.match(
    warning,
    new RegExp(`tumwater\\s+claude subscription window five_hour near its limit, resets ${clock} — subscription claude model jobs keep running`),
    `warning line: ${warning}`,
  );
  const filled = formatEvent({
    ts: 0, source: "tumwater", type: "claude_window_warning", windowType: "five_hour", resetsAt, utilization: 0.82,
  } as never);
  assert.match(
    filled,
    new RegExp(`near its limit \\(at 82% used\\), resets ${clock} — subscription claude model jobs keep running`),
    `filled warning line: ${filled}`,
  );
  const bad = formatEvent({
    ts: 0, source: "tumwater", type: "claude_window_warning", windowType: "five_hour", resetsAt, utilization: "x",
  } as never);
  assert.match(bad, /near its limit, resets/);
  assert.ok(!bad.includes("NaN"), `bad line: ${bad}`);
  const limited = formatEvent({
    ts: 0, source: "tumwater", type: "claude_window_limited", windowType: "five_hour", resetsAt,
  } as never);
  assert.match(
    limited,
    new RegExp(`tumwater\\s+waiting: claude subscription window five_hour rejected — claude model jobs wait, resets ${clock} \\(director keeps running\\)`),
    `limited line: ${limited}`,
  );
  assert.ok(!limited.includes("warning"), "a routine hold is not a warning");
  const reset = formatEvent({ ts: 0, source: "tumwater", type: "claude_window_reset" } as never);
  assert.match(reset, /tumwater\s+claude subscription window reset — claude model jobs run again/, `reset line: ${reset}`);

  // A torn limited line with no resetsAt drops the clause instead of rendering NaN.
  const torn = formatEvent({ ts: 0, source: "tumwater", type: "claude_window_limited", windowType: "five_hour" } as never);
  assert.ok(!torn.includes("resets"), `torn limited line: ${torn}`);
});

test("claude_window_limited with tiers says the work moves; budget_handback reason window names the window", () => {
  const moved = formatEvent({
    ts: 0, loop: "harness", type: "claude_window_limited", windowType: "five_hour", // retired-name-ok: legacy event field in a fixture
    tiers: { default: "free/qwen-free", strong: "free/qwen-free" },
  } as never);
  assert.match(moved, /claude model jobs move to /);
  assert.match(moved, /free\/qwen-free/);
  const back = formatEvent({ ts: 0, loop: "harness", type: "budget_handback", roles: ["feature"], reason: "window" } as never); // retired-name-ok: legacy event field in a fixture
  assert.match(back, /claude subscription window reset/);
});

test("fallback_switched renders each changed tier's destination and reason", () => {
  const line = formatEvent({
    ts: 0, source: "tumwater", type: "fallback_switched",
    tiers: {
      default: { from: null, to: "deepseek/DeepSeek-V4-Flash", reason: "window" },
      strong: { from: "x/y", to: null, reason: "available" },
    },
  } as never);
  assert.ok(line.endsWith("fallback: default → deepseek/DeepSeek-V4-Flash (window); strong → primary (available)"), line);
});

test("formatEvent renders the reserve crossing with utilization, reserve and reset", () => {
  const resetsAt = Date.UTC(2026, 9, 10, 14, 30, 0);
  const line = formatEvent({
    ts: 0, source: "tumwater", type: "claude_window_reserved", windowType: "seven_day", utilization: 0.85, reserve: 0.8, resetsAt,
  } as never);
  assert.match(line, new RegExp(`seven_day at 85%, past its 80% reserve, resets ${formatTime(new Date(resetsAt))} — the team leaves it to you \\(director keeps running\\)`));
  assert.match(formatEvent({ ts: 0, source: "tumwater", type: "claude_window_reserved" } as never), /at \?, past its \? reserve —/);
});
