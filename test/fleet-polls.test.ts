import test from "node:test";
import assert from "node:assert/strict";
import { HOLD_BASE_MS, HOLD_CAP_MS, heldProviders, windowHeldProviders, type FleetHold } from "../src/fleet/fleet-hold.js";
import { pollFleetHold, claudeWindowObservation, pollClaudeWindowWarning, pollClaudeWindowReserve, type HoldInputs } from "../src/fleet/fleet-polls.js";
import type { ClaudeAccount } from "../src/agent/claude/claude-account.js";
import { readEvents } from "../src/events/event-read.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// The orchestrator's fleet-hold poll (src/fleet/fleet-polls.ts): the wiring half of the fleet-wide
// backend-failure hold. Its pure policy is pinned in fleet-hold.test.ts; what is only pinned
// here is the wiring itself — the HoldInputs→observations mapping (lastRateLimit and
// lastBackendFailure, retry-after carried only on the former), the exactly-one-event-per-
// crossing rule: `rate_limit_hold` on the way in, `rate_limit_resumed` at the deadline
// carrying the ended hold's own kind (BUGS.md 2026-09-29), silence while held — and the
// per-provider keying (PLANS.md 2026-10-05): one hold per provider, events naming their
// provider, and a lifted hold staying in the map WITHOUT still reading as held.

const T0 = 1_000_000_000;

function holdEvents(root: string) {
  return readEvents(root).filter((e) => e.type === "rate_limit_hold" || e.type === "rate_limit_resumed");
}

function runner(role: string, inputs: Partial<HoldInputs> = {}): HoldInputs {
  return { role, ...inputs };
}

/** Step the poll from a single-provider prev (the default fleet's shape) and read that
 * provider's hold back out of the returned map. */
function pollOne(
  root: string,
  prev: FleetHold | ReadonlyMap<string | undefined, FleetHold>,
  runners: readonly HoldInputs[],
  now: number,
): FleetHold {
  const prevMap =
    prev instanceof Map ? prev : new Map([[(prev as FleetHold).provider ?? undefined, prev]]);
  return pollFleetHold(root, prevMap, runners, now).get(undefined)!;
}

test("pollFleetHold maps HoldInputs to observations: rate-limit with retry-after, backend failures without", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  // Three distinct roles: one plain 429, one 429 with a Retry-After, one connection failure.
  const held = pollOne(
    root,
    new Map(),
    [
      runner("clean", { lastRateLimit: { at: T0 } }),
      runner("coverage", { lastRateLimit: { at: T0 + 5_000, retryAfterSeconds: 300 } }),
      runner("dry", { lastBackendFailure: { at: T0 + 5_000, kind: "connection" } }),
    ],
    T0 + 5_000,
  );
  assert.notEqual(held.until, null, "two distinct roles' 429s trip the hold");
  // The first qualifying kind in observation order wins: the rate-limit group has the two
  // roles it needs, so dry's connection failure rides along in the observations but does
  // not join this hold.
  assert.equal(held.kind, "rate-limit");
  assert.deepEqual(held.roles, ["clean", "coverage"]);
  // The 300 s Retry-After from coverage, measured from its own 429, beats the base hold.
  assert.equal(held.until, T0 + 5_000 + 300_000, "the wired retry-after reaches the gate");
});

test("pollFleetHold logs exactly one rate_limit_hold on the crossing, naming kind, roles, holdMs, escalation", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  const held = pollOne(
    root,
    new Map(),
    [
      runner("clean", { lastRateLimit: { at: T0 } }),
      runner("coverage", { lastRateLimit: { at: T0 } }),
    ],
    T0,
  );
  assert.equal(held.until, T0 + HOLD_BASE_MS);
  const events = holdEvents(root);
  assert.equal(events.length, 1, "one event per crossing");
  const first = events[0]!;
  assert.equal(first.type, "rate_limit_hold");
  assert.equal(first.source, "tumwater");
  assert.equal(first.kind, "rate-limit");
  assert.deepEqual(first.roles, ["clean", "coverage"]);
  assert.equal(first.holdMs, HOLD_BASE_MS);
  assert.equal(first.escalation, 0);
  // An unconfigured provider (pi's default) is omitted from the event, so a single-backend
  // fleet's events render exactly as they always did.
  assert.equal(first.provider, undefined);

  // Held again before the deadline: prev passes through and stays event-free.
  const still = pollFleetHold(root, new Map([[undefined, held]]), [
    runner("clean", { lastRateLimit: { at: T0 } }),
    runner("coverage", { lastRateLimit: { at: T0 } }),
  ], T0 + 1_000);
  assert.equal(still.get(undefined), held, "a held step returns prev itself");
  assert.equal(holdEvents(root).length, 1, "no event while held");
});

test("pollFleetHold logs one rate_limit_resumed at the deadline, carrying the ended hold's kind", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  // A connection-error hold, not a 429 one — the resumed event must name what actually ended.
  const held = pollOne(
    root,
    new Map(),
    [
      runner("clean", { lastBackendFailure: { at: T0, kind: "connection" } }),
      runner("coverage", { lastBackendFailure: { at: T0, kind: "connection" } }),
    ],
    T0,
  );
  assert.equal(held.kind, "connection");
  assert.equal(holdEvents(root).length, 1);

  // At the deadline, with no fresh failures, the hold re-opens and the lift is logged with
  // the hold's own kind — "429 hold lifted" after a connection-error hold would be a lie.
  const open = pollOne(root, held, [], held.until!);
  assert.equal(open.until, null);
  assert.equal(open.kind, "connection", "kind stays for the relapse test after the lift");
  const resumed = holdEvents(root).filter((e) => e.type === "rate_limit_resumed");
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]!.kind, "connection");
  assert.equal(resumed[0]!.source, "tumwater");
  // The lifted provider STAYS in the map — its relapse memory — but no longer reads as held.
  assert.deepEqual([...heldProviders(new Map([[undefined, open]]))], []);
});

test("pollFleetHold logs a relapse crossing with its escalation depth", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  const failures = (at: number) => [
    runner("clean", { lastRateLimit: { at } }),
    runner("coverage", { lastRateLimit: { at } }),
  ];
  const held = pollOne(root, new Map(), failures(T0), T0);
  const open = pollOne(root, held, [], held.until!);
  // The same kind relapses within HOLD_RELAPSE_MS on fresh failures (the gate ignores
  // observations from before the re-open): a second hold event, escalation 1.
  const relapsed = pollOne(root, open, failures(open.reopenedAt! + 1_000), open.reopenedAt! + 1_000);
  assert.equal(relapsed.escalation, 1);
  assert.equal(relapsed.until, open.reopenedAt! + 1_000 + HOLD_BASE_MS * 2);
  const holds = holdEvents(root).filter((e) => e.type === "rate_limit_hold");
  assert.equal(holds.length, 2, "each crossing logs its own event");
  assert.equal(holds[1]!.escalation, 1);
});

test("pollFleetHold stays event-free while the fleet is open", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  // One role's 429s (its attempt and its retry) never trip the hold — and log nothing.
  const next = pollOne(
    root,
    new Map(),
    [
      runner("feature", { lastRateLimit: { at: T0 } }),
      runner("feature", { lastRateLimit: { at: T0 + 1_000 } }),
      runner("quiet", { lastBackendFailure: { at: T0, kind: "model-load" } }),
    ],
    T0 + 1_000,
  );
  assert.equal(next.until, null);
  assert.equal(holdEvents(root).length, 0, "an open fleet logs no hold events");

  // A huge Retry-After is still capped through the wiring.
  const capped = pollOne(
    root,
    new Map(),
    [
      runner("clean", { lastRateLimit: { at: T0, retryAfterSeconds: 9_999 } }),
      runner("coverage", { lastRateLimit: { at: T0 } }),
    ],
    T0,
  );
  assert.equal(capped.until, T0 + HOLD_CAP_MS);
  assert.equal(holdEvents(root).length, 1);
});

test("pollFleetHold keys holds per provider: a storm at P holds only P's entry, and its event names the provider", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  // Two roles on provider P trip P's hold; two roles on provider Q in the SAME poll —
  // which would trip a whole-fleet hold under the single-backend keying — hold nothing,
  // because each provider's hold steps with only its own observations.
  const holds = pollFleetHold(
    root,
    new Map(),
    [
      runner("clean", { provider: "P", lastRateLimit: { at: T0 } }),
      runner("coverage", { provider: "P", lastRateLimit: { at: T0 + 1_000 } }),
      runner("dry", { provider: "Q", lastRateLimit: { at: T0 + 1_000 } }),
      runner("perf", { provider: "Q", lastRateLimit: { at: T0 + 2_000 } }),
    ],
    T0 + 2_000,
  );
  const p = holds.get("P")!;
  const q = holds.get("Q")!;
  assert.notEqual(p.until, null, "P's storm trips P's hold");
  assert.equal(p.provider, "P");
  assert.deepEqual(p.roles, ["clean", "coverage"]);
  // Two DISTINCT roles on Q trip Q's hold too — each provider's storm is its own, on its own
  // clock: P's deadline never gates Q's.
  assert.notEqual(q.until, null, "Q's own storm trips Q's hold independently");
  assert.deepEqual(q.roles, ["dry", "perf"]);
  const events = holdEvents(root).filter((e) => e.type === "rate_limit_hold");
  assert.equal(events.length, 2, "each provider's crossing logs its own event");
  assert.deepEqual(events.map((e) => e.provider).sort(), ["P", "Q"]);
  assert.deepEqual([...heldProviders(holds)].sort(), ["P", "Q"]);
});

test("pollFleetHold separates the same kind at different providers: no cross-provider storm", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  // One role failing at P and one at Q — the same kind, two providers — is NOT a storm at
  // either: the grouping is provider AND kind (PLANS.md 2026-10-05).
  const holds = pollFleetHold(
    root,
    new Map(),
    [
      runner("clean", { provider: "P", lastRateLimit: { at: T0 } }),
      runner("coverage", { provider: "Q", lastRateLimit: { at: T0 + 1_000 } }),
    ],
    T0 + 1_000,
  );
  assert.equal(holds.get("P")!.until, null);
  assert.equal(holds.get("Q")!.until, null);
  assert.equal(holdEvents(root).length, 0);
});

test("a stamp's own provider dominates the runner's: a claude reviewer storm holds claude, not the pi author provider", () => {
  // PLANS.md "Mixed claude + pi fleets, part 2/4", gap 3: a 429 on a claude reviewer folds
  // through the pi author's run and stamps `claude` (the failing seam's hold key). The
  // runner-level provider is the pi author's `huggingface`, so without the stamp's own
  // provider the storm would hold the pi author's provider instead. The observation mapper
  // files each stamp under its own provider, and only falls back to the runner's when the
  // stamp carries none.
  const root = tmpdir("tumwater-fleet-polls-");
  const holds = pollFleetHold(
    root,
    new Map(),
    [
      runner("clean", { provider: "huggingface", lastRateLimit: { at: T0, provider: "claude" } }),
      runner("coverage", { provider: "huggingface", lastRateLimit: { at: T0 + 1_000, provider: "claude" } }),
    ],
    T0 + 1_000,
  );
  const claude = holds.get("claude")!;
  assert.notEqual(claude.until, null, "the claude reviewer storm trips claude's hold");
  assert.equal(claude.provider, "claude");
  assert.deepEqual(claude.roles, ["clean", "coverage"]);
  // The pi author provider got no storm observations at all, so it is not even a hold key —
  // and plainly not a held one.
  assert.ok(!heldProviders(holds).has("huggingface"), "the pi author provider stays open");
  assert.deepEqual([...heldProviders(holds)], ["claude"]);
});

test("a stamp without its own provider falls back to the runner's provider", () => {
  // A pre-part-2/4 stamp (or an unconfigured pi-default seam) carries no provider; the
  // observation is then filed under the runner's own provider, preserving the old behavior.
  const root = tmpdir("tumwater-fleet-polls-");
  const holds = pollFleetHold(
    root,
    new Map(),
    [
      runner("clean", { provider: "omlx", lastRateLimit: { at: T0 } }),
      runner("coverage", { provider: "omlx", lastRateLimit: { at: T0 + 1_000 } }),
    ],
    T0 + 1_000,
  );
  const omlx = holds.get("omlx")!;
  assert.notEqual(omlx.until, null, "the fallback-to-runProvider observation still trips the hold");
  assert.equal(omlx.provider, "omlx");
});

test("a lifted provider's hold stays in the map with its relapse memory but stops reading as held", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  const storm = (provider: string, at: number) => [
    runner("clean", { provider, lastRateLimit: { at } }),
    runner("coverage", { provider, lastRateLimit: { at: at + 1_000 } }),
  ];
  let holds = pollFleetHold(root, new Map(), storm("P", T0), T0 + 1_000);
  const pUntil = holds.get("P")!.until!;
  assert.deepEqual([...heldProviders(holds)], ["P"]);

  // The lift: P re-opens at its deadline (its resumed event), stays keyed in the map for
  // its relapse memory, and heldProviders() no longer names it — key presence is NOT held.
  holds = pollFleetHold(root, holds, [], pUntil);
  const lifted = holds.get("P")!;
  assert.equal(lifted.until, null);
  assert.equal(lifted.kind, "rate-limit", "the lift keeps kind for the relapse test");
  assert.deepEqual([...heldProviders(holds)], [], "a lifted hold never reads as held");

  // The subsequent poll: a fresh storm at P within the relapse window escalates off the
  // memory the lifted entry kept — proof the map entry survives the lift usefully.
  holds = pollFleetHold(root, holds, storm("P", lifted.reopenedAt! + 1_000), lifted.reopenedAt! + 2_000);
  assert.equal(holds.get("P")!.escalation, 1);
  assert.equal(holds.get("P")!.until, lifted.reopenedAt! + 2_000 + HOLD_BASE_MS * 2);
  assert.deepEqual([...heldProviders(holds)], ["P"]);
});

// The subscription usage window (plans/agent-backends.md §8, PLANS.md part 6c/7): the
// account reader's answer becomes one provider-`claude` hold observation, and the poll's
// crossing events are the window's own (claude_window_limited/reset), once per window.

/** A persisted account state as 6a's reader returns it: subscription by default, one
 * `five_hour` window at `status` resetting at `resetsAt`. */
function account(
  over: Partial<ClaudeAccount> = {},
  window: { status: string; resetsAt?: number; isUsingOverage?: boolean } = {
    status: "rejected",
    resetsAt: T0 + 3_600_000,
  },
): ClaudeAccount {
  return {
    billing: "subscription",
    observedAt: T0,
    windows: { five_hour: { ...window, observedAt: T0 } },
    ...over,
  };
}

function windowEvents(root: string) {
  return readEvents(root).filter(
    (e) =>
      e.type === "claude_window_warning" ||
      e.type === "claude_window_limited" ||
      e.type === "claude_window_reset",
  );
}

test("claudeWindowObservation: a rejected subscription window holds; API billing, overage, and a past reset do not", () => {
  assert.equal(claudeWindowObservation(null, T0), null, "no account is today's behavior");
  const obs = claudeWindowObservation(account(), T0)!;
  assert.equal(obs.provider, "claude");
  assert.equal(obs.kind, "subscription-window");
  assert.equal(obs.windowType, "five_hour");
  assert.equal(obs.resetsAt, T0 + 3_600_000);
  // Over the API, the subscription window is not the throttle; an overage window is paid
  // overflow (never a hold); a window already reset holds nothing.
  assert.equal(claudeWindowObservation(account({ billing: "api" }), T0), null);
  assert.equal(
    claudeWindowObservation(account({}, { status: "rejected", resetsAt: T0 + 3_600_000, isUsingOverage: true }), T0),
    null,
  );
  assert.equal(claudeWindowObservation(account({}, { status: "rejected", resetsAt: T0 - 1 }), T0), null);
  // The furthest reset among several rejected windows is the deadline the fleet waits out.
  const twoWindow = account();
  twoWindow.windows.seven_day = { status: "rejected", resetsAt: T0 + 7_200_000, observedAt: T0 };
  assert.equal(claudeWindowObservation(twoWindow, T0)!.resetsAt, T0 + 7_200_000);
});

test("pollFleetHold holds provider claude until resetsAt and logs claude_window_limited once, reset once", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  const resetsAt = T0 + 3_600_000;
  const acct = account({}, { status: "rejected", resetsAt });
  // A pi seam and an API claude seam share this poll; the subscription hold gates only claude.
  const holds = pollFleetHold(root, new Map(), [runner("feature", { provider: "openai" })], T0, acct);
  assert.notEqual(holds.get("claude")!.until, null);
  assert.equal(holds.get("claude")!.until, resetsAt);
  assert.equal(holds.get("claude")!.kind, "subscription-window");
  assert.deepEqual([...heldProviders(holds)], ["claude"], "only the claude provider is held");
  let events = windowEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "claude_window_limited");
  assert.equal(events[0]!.windowType, "five_hour");
  assert.equal(events[0]!.resetsAt, resetsAt);

  // Many polls across the one window: held, silent, and still standing.
  const mid = pollFleetHold(root, holds, [], resetsAt - 1_000, acct);
  assert.equal(mid.get("claude")!.until, resetsAt);
  assert.equal(windowEvents(root).length, 1, "no repeat while held");

  // Over the API no hold is placed at all.
  const api = tmpdir("tumwater-fleet-polls-");
  const apiHolds = pollFleetHold(api, new Map(), [], T0, account({ billing: "api" }));
  assert.equal(apiHolds.get("claude")?.until ?? null, null, "API-billed claude seams tick");
  assert.equal(windowEvents(api).length, 0);

  // At resetsAt the hold lifts by itself and the reset is logged once.
  const open = pollFleetHold(root, mid, [], resetsAt, acct);
  assert.equal(open.get("claude")!.until, null);
  events = windowEvents(root);
  assert.equal(events.filter((e) => e.type === "claude_window_reset").length, 1);
  assert.equal(events.filter((e) => e.type === "claude_window_limited").length, 1);
});

test("pollClaudeWindowWarning logs the first allowed_warning once per window", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  const resetsAt = T0 + 3_600_000;
  const acct = account({}, { status: "allowed_warning", resetsAt });
  const key = pollClaudeWindowWarning(root, null, acct, T0);
  assert.equal(key, `five_hour:${resetsAt}`);
  const warnings = () => readEvents(root).filter((e) => e.type === "claude_window_warning");
  assert.equal(warnings().length, 1);
  assert.equal(warnings()[0]!.windowType, "five_hour");
  assert.equal(warnings()[0]!.resetsAt, resetsAt);
  // The same window on later polls is not re-announced…
  assert.equal(pollClaudeWindowWarning(root, key, acct, T0 + 1_000), key);
  assert.equal(warnings().length, 1, "once per window, not per poll");
  // …while the next window's warning is its own crossing.
  const next = account({}, { status: "allowed_warning", resetsAt: resetsAt + 3_600_000 });
  const nextKey = pollClaudeWindowWarning(root, key, next, T0 + 1_000);
  assert.notEqual(nextKey, key);
  assert.equal(warnings().length, 2);
  // API billing and no account warn nothing.
  const api = tmpdir("tumwater-fleet-polls-");
  assert.equal(pollClaudeWindowWarning(api, null, account({ billing: "api" }), T0), null);
  assert.equal(windowEvents(api).length, 0);
});

test("pollFleetHold stamps the window move's tiers on claude_window_limited", () => {
  const root = tmpdir("fleet-polls-");
  pollFleetHold(root, new Map(), [], T0, account(), { default: "free/qwen-free" });
  const limited = windowEvents(root).filter((e) => e.type === "claude_window_limited");
  assert.equal(limited.length, 1);
  assert.deepEqual(limited[0]!.tiers, { default: "free/qwen-free" });
});

test("a reserve crossing holds claude but not the director, and logs claude_window_reserved once per window", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  const resetsAt = T0 + 3_600_000;
  const reserve = { five_hour: 0.8 };
  const acct = account({}, { status: "allowed", resetsAt, utilization: 0.85 } as never);
  const obs = claudeWindowObservation(acct, T0, reserve)!;
  assert.equal(obs.reserve, true);
  assert.equal(claudeWindowObservation(acct, T0), null, "without a reserve nothing holds");
  assert.equal(claudeWindowObservation(account({}, { status: "allowed", resetsAt, utilization: 0.75 } as never), T0, reserve), null);
  const holds = pollFleetHold(root, new Map(), [], T0, acct, {}, reserve);
  assert.deepEqual([...heldProviders(holds)], ["claude"], "subscription claude jobs wait");
  assert.equal(holds.get("claude")!.until, resetsAt);
  assert.equal(windowHeldProviders(holds).size, 0, "the director is not held on a reserve");
  assert.equal(windowEvents(root).filter((e) => e.type === "claude_window_limited").length, 0);
  const key = pollClaudeWindowReserve(root, null, acct, T0, reserve);
  assert.equal(key, `five_hour:${resetsAt}`);
  assert.equal(pollClaudeWindowReserve(root, key, acct, T0 + 1_000, reserve), key);
  const logged = readEvents(root).filter((e) => e.type === "claude_window_reserved");
  assert.equal(logged.length, 1);
  assert.deepEqual(
    { w: logged[0]!.windowType, u: logged[0]!.utilization, r: logged[0]!.reserve, at: logged[0]!.resetsAt },
    { w: "five_hour", u: 0.85, r: 0.8, at: resetsAt },
  );
  // A rejected window still holds the director.
  const rejected = pollFleetHold(root, new Map(), [], T0, account(), {}, reserve);
  assert.deepEqual([...windowHeldProviders(rejected)], ["claude"]);
  // A standing reserve hold that hardens into a rejected window logs the limit.
  const root2 = tmpdir("tumwater-fleet-polls-");
  const reserved = pollFleetHold(root2, new Map(), [], T0, acct, {}, reserve);
  const hardened = pollFleetHold(root2, reserved, [], T0 + 1_000, account(), {}, reserve);
  assert.deepEqual([...windowHeldProviders(hardened)], ["claude"]);
  assert.equal(windowEvents(root2).filter((e) => e.type === "claude_window_limited").length, 1);
});
