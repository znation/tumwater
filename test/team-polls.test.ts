import test from "node:test";
import assert from "node:assert/strict";
import { HOLD_BASE_MS, HOLD_CAP_MS, heldProviders, type TeamHold } from "../src/team/team-hold.js";
import { pollTeamHold, type HoldInputs } from "../src/team/team-polls.js";
import { readEvents } from "../src/events/event-read.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// The orchestrator's team-hold poll (src/team/team-polls.ts): the wiring half of the team-wide
// backend-failure hold. Its pure policy is pinned in team-hold.test.ts; what is only pinned
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

/** Step the poll from a single-provider prev (the default team's shape) and read that
 * provider's hold back out of the returned map. */
function pollOne(
  root: string,
  prev: TeamHold | ReadonlyMap<string | undefined, TeamHold>,
  runners: readonly HoldInputs[],
  now: number,
): TeamHold {
  const prevMap =
    prev instanceof Map ? prev : new Map([[(prev as TeamHold).provider ?? undefined, prev]]);
  return pollTeamHold(root, prevMap, runners, now).get(undefined)!;
}

test("pollTeamHold maps HoldInputs to observations: rate-limit with retry-after, backend failures without", () => {
  const root = tmpdir("tumwater-team-polls-");
  // Three distinct roles: one plain 429, one 429 with a Retry-After, one connection failure.
  const held = pollOne(
    root,
    new Map(),
    [
      runner("clean", { lastRateLimit: { at: T0 } }),
      runner("coverage", { lastRateLimit: { at: T0 + 5_000, retryAfterSeconds: 300 } }),
      runner("dedupe", { lastBackendFailure: { at: T0 + 5_000, kind: "connection" } }),
    ],
    T0 + 5_000,
  );
  assert.notEqual(held.until, null, "two distinct roles' 429s trip the hold");
  // The first qualifying kind in observation order wins: the rate-limit group has the two
  // roles it needs, so dedupe's connection failure rides along in the observations but does
  // not join this hold.
  assert.equal(held.kind, "rate-limit");
  assert.deepEqual(held.roles, ["clean", "coverage"]);
  // The 300 s Retry-After from coverage, measured from its own 429, beats the base hold.
  assert.equal(held.until, T0 + 5_000 + 300_000, "the wired retry-after reaches the gate");
});

test("pollTeamHold logs exactly one rate_limit_hold on the crossing, naming kind, roles, holdMs, escalation", () => {
  const root = tmpdir("tumwater-team-polls-");
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
  // team's events render exactly as they always did.
  assert.equal(first.provider, undefined);

  // Held again before the deadline: prev passes through and stays event-free.
  const still = pollTeamHold(root, new Map([[undefined, held]]), [
    runner("clean", { lastRateLimit: { at: T0 } }),
    runner("coverage", { lastRateLimit: { at: T0 } }),
  ], T0 + 1_000);
  assert.equal(still.get(undefined), held, "a held step returns prev itself");
  assert.equal(holdEvents(root).length, 1, "no event while held");
});

test("pollTeamHold logs one rate_limit_resumed at the deadline, carrying the ended hold's kind", () => {
  const root = tmpdir("tumwater-team-polls-");
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

test("pollTeamHold logs a relapse crossing with its escalation depth", () => {
  const root = tmpdir("tumwater-team-polls-");
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

test("pollTeamHold stays event-free while the team is open", () => {
  const root = tmpdir("tumwater-team-polls-");
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
  assert.equal(holdEvents(root).length, 0, "an open team logs no hold events");

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

test("pollTeamHold keys holds per provider: a storm at P holds only P's entry, and its event names the provider", () => {
  const root = tmpdir("tumwater-team-polls-");
  // Two roles on provider P trip P's hold; two roles on provider Q in the SAME poll —
  // which would trip a whole-team hold under the single-backend keying — hold nothing,
  // because each provider's hold steps with only its own observations.
  const holds = pollTeamHold(
    root,
    new Map(),
    [
      runner("clean", { provider: "P", lastRateLimit: { at: T0 } }),
      runner("coverage", { provider: "P", lastRateLimit: { at: T0 + 1_000 } }),
      runner("dedupe", { provider: "Q", lastRateLimit: { at: T0 + 1_000 } }),
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
  assert.deepEqual(q.roles, ["dedupe", "perf"]);
  const events = holdEvents(root).filter((e) => e.type === "rate_limit_hold");
  assert.equal(events.length, 2, "each provider's crossing logs its own event");
  assert.deepEqual(events.map((e) => e.provider).sort(), ["P", "Q"]);
  assert.deepEqual([...heldProviders(holds)].sort(), ["P", "Q"]);
});

test("pollTeamHold separates the same kind at different providers: no cross-provider storm", () => {
  const root = tmpdir("tumwater-team-polls-");
  // One role failing at P and one at Q — the same kind, two providers — is NOT a storm at
  // either: the grouping is provider AND kind (PLANS.md 2026-10-05).
  const holds = pollTeamHold(
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
  const root = tmpdir("tumwater-team-polls-");
  const holds = pollTeamHold(
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
  const root = tmpdir("tumwater-team-polls-");
  const holds = pollTeamHold(
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
  const root = tmpdir("tumwater-team-polls-");
  const storm = (provider: string, at: number) => [
    runner("clean", { provider, lastRateLimit: { at } }),
    runner("coverage", { provider, lastRateLimit: { at: at + 1_000 } }),
  ];
  let holds = pollTeamHold(root, new Map(), storm("P", T0), T0 + 1_000);
  const pUntil = holds.get("P")!.until!;
  assert.deepEqual([...heldProviders(holds)], ["P"]);

  // The lift: P re-opens at its deadline (its resumed event), stays keyed in the map for
  // its relapse memory, and heldProviders() no longer names it — key presence is NOT held.
  holds = pollTeamHold(root, holds, [], pUntil);
  const lifted = holds.get("P")!;
  assert.equal(lifted.until, null);
  assert.equal(lifted.kind, "rate-limit", "the lift keeps kind for the relapse test");
  assert.deepEqual([...heldProviders(holds)], [], "a lifted hold never reads as held");

  // The subsequent poll: a fresh storm at P within the relapse window escalates off the
  // memory the lifted entry kept — proof the map entry survives the lift usefully.
  holds = pollTeamHold(root, holds, storm("P", lifted.reopenedAt! + 1_000), lifted.reopenedAt! + 2_000);
  assert.equal(holds.get("P")!.escalation, 1);
  assert.equal(holds.get("P")!.until, lifted.reopenedAt! + 2_000 + HOLD_BASE_MS * 2);
  assert.deepEqual([...heldProviders(holds)], ["P"]);
});

