/** Unit-tier coverage for the orchestrator's fallback-probe admission (src/orchestrator.ts's
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
 * breaker (a shrunken policy — cooldownMs 1500 — keeps the probe windows inside a test while
 * leaving the wake-window assertions room: the setup between the trip and the wake's own
 * polling window can overshoot on a loaded machine, and a cool-down that elapses mid-setup
 * admits a legitimate probe the assertions would misread as a pierced pause). Each
 * role's own error backoff (seconds, growing) would otherwise dominate the probe timing, so
 * the test drops `tumwater wake` markers (.tumwater/wake.json) to make the roles due at will:
 * a wake inside the cool-down must NOT pierce the demotion pause, and once the cool-down
 * elapses exactly one of the two due roles runs — the other waits for the verdict, and takes
 * the next window's probe itself.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { loadLoopState } from "../src/loop/loop-state.js";
import { STATE_DIR } from "../src/paths.js";
import { FAST_POLL_MS, fastConfig, makeFastRepo, runRepoOrchestrator } from "./orchestrator-fixtures.js";
import { fakePi } from "./fake-pi.js";
import { assistantLine } from "./pi-events.js";
import { eventsOfType } from "./log-fixtures.js";
import { tmpdir } from "./repo-fixtures.js";
import { sleep, waitFor } from "./wait.js";

/** Drop a wake request marker: the next poll consumes it and clears both roles' backoff, so
 * each becomes due at once — the demand lever an operator's `tumwater wake` pulls. */
function wakeAll(repo: string): void {
  fs.writeFileSync(path.join(repo, STATE_DIR, "wake.json"), JSON.stringify({}));
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

  const controller = new AbortController();
  const run = runRepoOrchestrator(repo, {
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
    modelsPath,
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
    const runsAtTrip = onFallback();
    const ticksAt = (role: string) => loadLoopState(repo, role).ticks;
    const ticksAtTrip = { feature: ticksAt("feature"), helper: ticksAt("helper") };

    // An operator wake inside the first cool-down must not pierce the demotion pause: both
    // roles are due at once afterwards, and still nothing runs until the cool-down elapses.
    wakeAll(repo);
    await sleep(150);
    assert.equal(onFallback(), runsAtTrip, "a wake does not start a tick while the breaker holds");
    assert.deepEqual(
      { feature: ticksAt("feature"), helper: ticksAt("helper") },
      ticksAtTrip,
      "the demoted pause holds both roles, wake or no wake",
    );

    // The cool-down elapses: exactly ONE probe tick is admitted — the other due role waits
    // for its verdict instead of joining a wave onto the dead backend.
    await waitFor(() => onFallback() === runsAtTrip + 1, "the first probe tick");
    const prober = ticksAt("feature") > ticksAtTrip.feature ? "feature" : "helper";
    const waiter = prober === "feature" ? "helper" : "feature";
    await sleep(200);
    assert.equal(onFallback(), runsAtTrip + 1, "one probe per cool-down, not a maxConcurrent wave");
    assert.equal(ticksAt(waiter), ticksAtTrip[waiter as keyof typeof ticksAtTrip],
      "the second due role waits for the probe's verdict");

    // A failed probe re-opens the breaker with the cool-down doubled: the first cool-down's
    // whole length now passes with the pause still holding — and the pause never re-announced
    // itself, because the half-open window runs under the paused gate.
    await sleep(500);
    assert.equal(onFallback(), runsAtTrip + 1, "the failed probe doubled the cool-down");
    assert.equal(
      eventsOfType(repo, "budget_paused").length,
      1,
      "the probe runs under the paused gate — no budget event fires for the half-open window",
    );

    // Once the doubled cool-down elapses, the probe asks again — and the waiter takes the
    // slot: the first probe's error backed its role off the short ladder, so the still-due
    // waiter is the one role the window can admit.
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
