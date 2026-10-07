/** Unit-tier coverage for the orchestrator's fallback-probe admission (src/orchestrator/orchestrator.ts's
 * start pass): once the demoted fallback's cool-down elapses, the orchestrator opens the paused
 * budget gate for exactly ONE role tick — the probe — and closes it again the moment that tick
 * is admitted (startFallbackProbe marks the breaker probing, so a second due role in the same
 * pass is turned away). Until now this wiring ran in no test at any tier: the breaker's state
 * machine has its own unit tests (fallback-breaker.test.ts) and the gate's verdicts theirs
 * (budget-gates.test.ts), but the orchestrator's "one tick's evidence per cool-down" admission
 * was covered nowhere, so a wiring slip (never admitting the probe, or admitting a whole wave)
 * would leave a demoted fallback paused forever — or hammer a dead backend with a full
 * maxConcurrent wave every cool-down.
 *
 * The scenario, driven in-process against the fake pi: one $10 tick on the primary spends to
 * the cap, the gate engages the free pair, and three consecutive failures on it trip the
 * breaker. The breaker's clock is injected (RunOptions.breakerNow) and the test advances it by
 * hand, so every cool-down boundary — the wake that must NOT pierce the demotion, the probe
 * that must, and the doubled cool-down after a failed probe — is a function of the test's own
 * clock, never of how loaded the host is (BUGS.md 2026-10-06: the wall-clock version flaked the
 * gate, whose flake re-run then verified a change on that pass). Each role's own error backoff
 * (seconds, growing) would otherwise dominate the probe timing, so the test drops `tumwater
 * wake` markers (.tumwater/wake.json) to make the roles due at will: a wake inside the cool-down
 * must NOT pierce the demotion pause, and once the cool-down elapses exactly one of the two due
 * roles runs — the other waits for the verdict, and takes the next window's probe itself.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { loadLoopState } from "../src/loop/loop-state.js";
import { readOrchestratorInfo } from "../src/fleet/fleet-state.js";
import { STATE_DIR } from "../src/paths.js";
import { FAST_POLL_MS, fastConfig, makeFastRepo, runRepoOrchestrator } from "./orchestrator-fixtures.js";
import { fakePi } from "./fake-pi.js";
import { assistantLine } from "./pi-events.js";
import { eventsOfType } from "./log-fixtures.js";
import { tmpdir } from "./repo-fixtures.js";
import { fakeClock } from "./fakes/time.js";
import { sleep, waitFor } from "./wait.js";

/** Drop a wake request marker: the next poll consumes it and clears both roles' backoff, so
 * each becomes due at once — the demand lever an operator's `tumwater wake` pulls. */
function wakeAll(repo: string): void {
  fs.writeFileSync(path.join(repo, STATE_DIR, "wake.json"), JSON.stringify({}));
}

/** Role ticks started but not yet ended. The launch pass logs a tick's tick_start before any
 * I/O, and the orchestrator runs in-process, so once the test reads the log every admitted
 * tick is counted here. */
function roleTicksInFlight(repo: string): number {
  return eventsOfType(repo, "tick_start").length - eventsOfType(repo, "tick_end").length;
}

test("a demoted fallback admits exactly one probe tick per cool-down; other due roles wait", async () => {
  const repo = await makeFastRepo("fallback probe admission test", ["feature", "helper"]);
  const cfg = fastConfig(["feature", "helper"]);
  cfg.maxDailyCostUsd = 10;
  cfg.fallbackModel = { provider: "free", model: "qwen-free" };
  // The second role is a custom loop, not bugfix: a custom never defers (DEFERRABLE_ROLES
  // holds only built-ins), so it stays due behind its wake and can take the probe slot.
  cfg.customLoops = [{ name: "helper", task: "Keep the scratch notes current." }];
  const cfgPath = path.join(repo, "tumwater.json");
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  // pi's model catalog, pricing the fallback pair at zero (an absent cost is free) — the
  // modelsPath seam keeps the test off the real ~/.pi definitions.
  const modelsPath = path.join(tmpdir("probe-models-"), "models.json");
  fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
  fs.writeFileSync(
    modelsPath,
    JSON.stringify({ providers: { free: { models: [{ id: "qwen-free" }] } } }),
  );

  // The fake pi serves the primary a $10 nothing-to-do and dies on the fallback pair — the
  // dead backend whose demotion the probe exists to re-test.
  const argsFile = path.join(tmpdir("probe-args-"), "argv.log");
  const script =
    `echo "$@" >> '${argsFile}'\n` +
    `for a in "$@"; do case "$a" in qwen-free) echo 'fallback backend dead' >&2; exit 1;; esac; done\n` +
    `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO", { cost: 10 })}'`;
  const restore = fakePi(script);

  // The breaker's clock, advanced by hand: the cool-down deadline and its elapsed check read
  // only this, so an assertion about "the breaker still holds" cannot be outrun by a slow
  // host. Scheduling and tick timing stay on the real clock.
  const clock = fakeClock(Date.now());
  const controller = new AbortController();
  const run = runRepoOrchestrator(repo, {
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
    modelsPath,
    breakerNow: clock.now,
    fallbackBreakerPolicy: { failureLimit: 3, cooldownMs: 1500, maxCooldownMs: 6000 },
  });
  const timeout = setTimeout(() => controller.abort(), 45_000);
  timeout.unref();
  try {
    // Three dead-backend failures trip the breaker: the gate drops to paused, naming the
    // demotion (the trip itself is orchestrator-fallback.test.ts's subject — here it is
    // only the setup for what follows).
    await waitFor(
      () => eventsOfType(repo, "budget_paused").length === 1,
      "the breaker's budget_paused event",
    );
    const onFallback = () => fs.readFileSync(argsFile, "utf8").match(/--model qwen-free/g)?.length ?? 0;
    await waitFor(() => onFallback() >= 3, "the three tripping failures");
    // Both roles fail in lockstep, so the other role's tick is usually still in flight when the
    // third failure trips the breaker — a straggler admitted before the trip, which runs to its
    // own failure by design (recordFallbackTick). Its tick_start precedes the worktree reset and
    // the pi spawn, so on a loaded host its argv line can land after budget_paused and read as a
    // pierced pause (BUGS.md 2026-10-07). The snapshot waits for every started tick to end; no
    // new tick can start meanwhile, since admission reads the tripped breaker.
    await waitFor(() => roleTicksInFlight(repo) === 0, "the pre-trip stragglers to finish");
    const runsAtTrip = onFallback();
    const ticksAt = (role: string) => loadLoopState(repo, role).ticks;
    const ticksAtTrip = { feature: ticksAt("feature"), helper: ticksAt("helper") };

    // Read the deadline the orchestrator itself published rather than guessing from sleeps:
    // the breaker entry's probeAt is the invariant the assertions below move against.
    const demoted = () => readOrchestratorInfo(repo)?.fallbackDemoted;
    await waitFor(() => demoted()?.probeAt !== undefined, "the demotion's published cool-down");
    const firstProbeAt = demoted()!.probeAt;
    assert.ok(firstProbeAt > clock.now(), "the published cool-down is still in the future");

    // An operator wake inside the first cool-down must not pierce the demotion pause: both
    // roles are due at once afterwards, and still nothing runs while the injected clock sits
    // below probeAt — a frozen fact, not a 150 ms window a loaded host could overshoot.
    wakeAll(repo);
    await waitFor(() => eventsOfType(repo, "wake").length >= 2, "the wake consumed for both roles");
    await sleep(300); // a full poll cycle or two: a broken cooldown check would probe by now
    assert.equal(onFallback(), runsAtTrip, "a wake does not start a tick while the breaker holds");
    assert.deepEqual(
      { feature: ticksAt("feature"), helper: ticksAt("helper") },
      ticksAtTrip,
      "the demoted pause holds both roles, wake or no wake",
    );

    // Elapse the cool-down on the breaker's own clock: exactly ONE probe tick is admitted —
    // the other due role waits for its verdict instead of joining a wave onto the dead backend.
    clock.advance(firstProbeAt - clock.now() + 1);
    await waitFor(() => onFallback() === runsAtTrip + 1, "the first probe tick");
    const prober = ticksAt("feature") > ticksAtTrip.feature ? "feature" : "helper";
    const waiter = prober === "feature" ? "helper" : "feature";
    // The failed probe re-opens the breaker with the cool-down doubled; waiting for the
    // published probeAt to move is how the test knows the evidence folded.
    await waitFor(() => demoted()!.probeAt !== firstProbeAt, "the failed probe's doubled cool-down");
    const doubledProbeAt = demoted()!.probeAt;
    assert.equal(doubledProbeAt, clock.now() + 3000, "the failed probe doubles the 1500 ms cool-down");

    // Halfway into the doubled cool-down (past the *undoubled* 1500 ms but short of 3000 ms):
    // a second probe here would mean the doubling was lost.
    clock.advance(2000);
    await sleep(300);
    assert.equal(onFallback(), runsAtTrip + 1, "one probe per cool-down, not a maxConcurrent wave");
    assert.equal(ticksAt(waiter), ticksAtTrip[waiter as keyof typeof ticksAtTrip],
      "the second due role waits for the probe's verdict");
    assert.equal(
      eventsOfType(repo, "budget_paused").length,
      1,
      "the probe runs under the paused gate — no budget event fires for the half-open window",
    );

    // Past the doubled cool-down, the probe asks again — and the waiter takes the slot: the
    // first probe's error backed its role off the short ladder, so the still-due waiter is the
    // one role the window can admit.
    clock.advance(doubledProbeAt - clock.now() + 1);
    await waitFor(() => onFallback() === runsAtTrip + 2, "the second probe tick");
    assert.equal(ticksAt(waiter), ticksAtTrip[waiter as keyof typeof ticksAtTrip] + 1,
      "the role that waited takes the next window's probe");
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await run.catch(() => undefined); // shutdown noise must not mask the assertions above
    restore();
  }
});
