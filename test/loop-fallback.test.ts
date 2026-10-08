/** The loop wiring of the model-fallback state machine (PLANS.md "Model failure fallback,
 * part 1/2"): consecutive provider-class failures trip the episode and the next tick runs the
 * role's tier fallback pair, a clean probe tick after the cooldown returns to the primary and
 * emits the ended event, and a role with no fallback configured never trips. The regression
 * tests at the bottom pin the review's objections: only the AUTHORING run of a tick is
 * evidence, and a tick that never invoked pi is no probe. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { makeLoopRunner } from "./loop-fixtures.js";
import { initializedRepo, tmpdir } from "./repo-fixtures.js";
import { readRunLines, withPi, withIdlePi, TOUCH_SESSION } from "./fakes/fake-pi.js";
import { eventsOfType } from "./log-fixtures.js";
import { transientErrorText } from "./fakes/transient.js";
import { assistantLine, errorLine } from "./pi-events.js";

/** A fake pi that records each run's --provider/--model flags then fails the run with an
 * HTTP 503 backend error. `server` is a backend kind the transient retry does NOT cover, so
 * each tick makes exactly one recorded run. */
function failingRecorder(argsFile: string): string {
  return [
    `m=""; p=""; n=""`,
    `while [ $# -gt 0 ]; do case "$1" in --model) m="$2";; --provider) p="$2";; -n) n="$2";; esac; shift; done`,
    `echo "run: model=$m provider=$p session=$n" >> "${argsFile}"`,
    `printf '%s\\n' '${errorLine(transientErrorText("backend"))}'`,
    `exit 1`,
  ].join("\n");
}

test("three provider failures trip fallback; the next tick runs the fallback pair", async () => {
  const repo = await initializedRepo();
  const argsFile = path.join(tmpdir(), "fb-trip.log");
  const config = defaultConfig();
  config.model = "primary/m1";
  config.fallback = "backup/f1";
  await withPi(failingRecorder(argsFile), async () => {
    const runner = makeLoopRunner(repo, "clean", config);
    for (let i = 0; i < 4; i++) assert.equal((await runner.tick()).result, "error");
    assert.ok(runner.state.modelFallback, "the episode is persisted");
    assert.ok(runner.state.modelFallback.since > 0);
    const started = eventsOfType(repo, "model_fallback_started");
    assert.equal(started.length, 1);
    assert.equal(started[0]!.provider, "backup");
    assert.equal(started[0]!.model, "f1");
    assert.equal(started[0]!.reason, "server");
    const runs = readRunLines(argsFile);
    assert.equal(runs.length, 4, "one run per failing tick (503 is not transient-retried)");
    assert.match(runs[0]!, /model=m1 provider=primary/);
    assert.match(runs[3]!, /model=f1 provider=backup/, "the fourth tick ran the fallback pair");
  });
});

test("a clean probe tick after the cooldown returns to primary and ends the episode", async () => {
  const repo = await initializedRepo();
  const argsFile = path.join(tmpdir(), "fb-probe.log");
  const marker = path.join(tmpdir(), "fb-probe-phase");
  const config = defaultConfig();
  config.model = "primary/m1";
  config.fallback = "backup/f1";
  const runner = makeLoopRunner(repo, "clean", config);
  // Three recorded 503s trip the episode; the fourth run idles so the probe succeeds.
  const script = [
    `m=""; p=""; n=""`,
    `while [ $# -gt 0 ]; do case "$1" in --model) m="$2";; --provider) p="$2";; -n) n="$2";; esac; shift; done`,
    `echo "run: model=$m provider=$p session=$n" >> "${argsFile}"`,
    `attempt_file="${marker}"`,
    `if [ -f "$attempt_file" ]; then c=$(cat "$attempt_file"); else c=0; fi`,
    `c=$((c + 1)); echo "$c" > "$attempt_file"`,
    `if [ "$c" -le 3 ]; then`,
    `  printf '%s\\n' '${errorLine(transientErrorText("backend"))}'`,
    `  exit 1`,
    `fi`,
    `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
  ].join("\n");
  await withPi(script, async () => {
    for (let i = 0; i < 3; i++) assert.equal((await runner.tick()).result, "error");
    assert.equal(eventsOfType(repo, "model_fallback_started").length, 1);
    assert.ok(runner.state.modelFallback);
    // Fast-forward the cooldown: the next tick is the due probe on the primary.
    runner.state.modelFallback.probeAt = Date.now() - 1;
    assert.equal((await runner.tick()).result, "no_change");
  });
  assert.equal(runner.state.modelFallback, undefined, "the successful probe cleared the episode");
  const started = eventsOfType(repo, "model_fallback_started");
  const ended = eventsOfType(repo, "model_fallback_ended");
  assert.equal(ended.length, 1);
  assert.equal(ended[0]!.provider, "primary");
  assert.equal(ended[0]!.model, "m1");
  assert.ok(started[0]!.ts <= ended[0]!.ts, "the started event precedes the ended event");
  const runs = readRunLines(argsFile);
  assert.equal(runs.length, 4);
  assert.match(runs[3]!, /model=m1 provider=primary/, "the probe ran the primary");
});

test("a role with no fallback configured never trips and keeps its primary argv", async () => {
  const repo = await initializedRepo();
  const argsFile = path.join(tmpdir(), "fb-none.log");
  const config = defaultConfig();
  config.model = "primary/m1";
  await withPi(failingRecorder(argsFile), async () => {
    const runner = makeLoopRunner(repo, "clean", config);
    for (let i = 0; i < 3; i++) assert.equal((await runner.tick()).result, "error");
    assert.equal(runner.state.modelFallback, undefined);
    assert.equal(eventsOfType(repo, "model_fallback_started").length, 0);
    for (const line of readRunLines(argsFile)) assert.match(line, /model=m1 provider=primary/);
  });
});

test("a fallback-episode tick's missing-SUMMARY follow-up runs on the fallback pair too", async () => {
  const repo = await initializedRepo();
  const argsFile = path.join(tmpdir(), "fb-summary.log");
  const marker = path.join(tmpdir(), "fb-summary-phase");
  const config = defaultConfig();
  config.model = "primary/m1";
  config.fallback = "backup/f1";
  // Three 503s trip the episode; the fourth (fallback) tick edits the worktree and ends
  // without a SUMMARY, so the harness issues its one follow-up turn — which must ride the
  // same fallback pair, not the primary the episode abandoned.
  const script = [
    `m=""; p=""; n=""; prev=""`,
    `for a in "$@"; do case "$prev" in --model) m="$a";; --provider) p="$a";; -n) n="$a";; esac; prev="$a"; done`,
    `echo "run: model=$m provider=$p session=$n" >> "${argsFile}"`,
    TOUCH_SESSION,
    `if [ -f "${marker}" ]; then c=$(cat "${marker}"); else c=0; fi`,
    `c=$((c + 1)); echo "$c" > "${marker}"`,
    `if [ "$c" -le 3 ]; then`,
    `  printf '%s\\n' '${errorLine(transientErrorText("backend"))}'`,
    `  exit 1`,
    `fi`,
    `for a in "$@"; do case "$a" in *"did not include the required closing block"*)`,
    `  printf '%s\\n' '${assistantLine("SUMMARY: Fallback tick\\nWHY: test\\nRISK: none\\nVERIFIED: none")}'`,
    `  exit 0;; esac; done`,
    `echo x > x.txt`,
    `printf '%s\\n' '${assistantLine("did it, no summary")}'`,
  ].join("\n");
  await withPi(script, async () => {
    const runner = makeLoopRunner(repo, "clean", config);
    for (let i = 0; i < 3; i++) assert.equal((await runner.tick()).result, "error");
    assert.ok(runner.state.modelFallback?.since, "the episode is active");
    assert.equal((await runner.tick()).result, "queued");
  });
  const runs = readRunLines(argsFile);
  assert.equal(runs.length, 5, JSON.stringify(runs));
  assert.match(runs[3]!, /model=f1 provider=backup/, "the fallback tick ran the pair");
  assert.match(runs[4]!, /model=f1 provider=backup/, "its SUMMARY follow-up ran the same pair");
});

test("removing the fallback config mid-episode clears the episode on the next primary run", async () => {
  const repo = await initializedRepo();
  const config = defaultConfig();
  config.model = "primary/m1";
  config.fallback = "backup/f1";
  const runner = makeLoopRunner(repo, "clean", config);
  runner.state.modelFallback = {
    failures: 0,
    since: Date.now() - 1000,
    probeAt: Date.now() + 10 * 60_000,
    cooldownMs: 5 * 60_000,
    reason: "server",
  };
  // A live edit (or a `"pause"`) drops the pair: the tick runs the primary, and its clean
  // answer ends the episode instead of leaving a stale "on fallback" mark with no pair.
  runner.config = { ...config, fallback: undefined };
  await withIdlePi(async () => {
    assert.equal((await runner.tick()).result, "no_change");
  });
  assert.equal(runner.state.modelFallback, undefined, "the episode was cleared");
  const ended = eventsOfType(repo, "model_fallback_ended");
  assert.equal(ended.length, 1);
  assert.equal(ended[0]!.provider, "primary");
  assert.equal(ended[0]!.model, "m1");
});

test("runProvider and runConfig name the pair the next tick will actually use", async () => {
  const repo = await initializedRepo();
  const config = defaultConfig();
  config.model = "primary/m1";
  config.fallback = "backup/f1";
  const runner = makeLoopRunner(repo, "clean", config);
  const now = Date.now();
  assert.equal(runner.runProvider(now), "primary");
  assert.equal(runner.runConfig(now).model, "m1");
  runner.state.modelFallback = {
    failures: 0,
    since: now,
    probeAt: now + 60_000,
    cooldownMs: 5 * 60_000,
    reason: "server",
  };
  assert.equal(runner.runProvider(now), "backup", "an active episode is gated by its fallback provider");
  assert.equal(runner.runConfig(now).model, "f1", "and resolves to the fallback pair");
  assert.equal(runner.runProvider(now + 60_001), "primary", "a due probe is gated by the primary");
  runner.config = { ...config, fallback: undefined };
  assert.equal(runner.runProvider(now), "primary", "no fallback pair means the primary provider");
});

test("a due probe tick that never invokes pi leaves the episode active", async () => {
  const repo = await initializedRepo();
  const config = defaultConfig();
  config.model = "primary/m1";
  config.fallback = "backup/f1";
  const runner = makeLoopRunner(repo, "director", config);
  runner.state.modelFallback = {
    failures: 0,
    since: Date.now() - 1000,
    probeAt: Date.now() - 1,
    cooldownMs: 5 * 60_000,
    reason: "server",
  };
  const before = runner.state.modelFallback;
  const outcome = await runner.tick(); // empty director inbox: skipped, no pi run
  assert.equal(outcome.result, "skipped");
  assert.equal(runner.state.modelFallback, before, "no pi ran, so there is no probe verdict");
  assert.equal(eventsOfType(repo, "model_fallback_ended").length, 0);
});

test("a provider failure the transient retry recovers does not count against the primary", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "fb-retry-phase");
  const config = defaultConfig();
  config.model = "primary/m1";
  config.fallback = "backup/f1";
  // Every odd attempt severs the stream (a kind the retry covers); every even attempt idles.
  // Each tick therefore ends on a clean authoring run, while its first attempt still stamps
  // the tick's lastBackendFailure — evidence the fold must NOT read.
  const script = [
    `attempt_file="${marker}"`,
    `if [ -f "$attempt_file" ]; then n=$(cat "$attempt_file"); else n=0; fi`,
    `n=$((n + 1)); echo "$n" > "$attempt_file"`,
    `if [ $((n % 2)) -eq 1 ]; then`,
    `  printf '%s\\n' '${errorLine("terminated")}'`,
    `  exit 1`,
    `fi`,
    `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
  ].join("\n");
  await withPi(script, async () => {
    const runner = makeLoopRunner(repo, "clean", config);
    for (let i = 0; i < 3; i++) assert.equal((await runner.tick()).result, "no_change");
    assert.equal(runner.lastBackendFailure?.kind, "stream-severed", "the failed attempts did stamp the tick");
    assert.equal(runner.state.modelFallback, undefined, "the authoring run answered, so no trip");
    assert.equal(eventsOfType(repo, "model_fallback_started").length, 0);
  });
});
