/** `tumwater run --once` (PLANS.md 2026-09-25): one full round of ticks — every enabled role
 * at most once, every landing that round produced merged — then exit 0. Tests (a)–(d) drive
 * runOrchestrator directly in once mode on the standard fixture pattern (fake pi shim, short
 * poll); (e)–(g) go through the real CLI so the supervisor half, the flag vocabulary, and the
 * summary line are exercised end to end. Like the rest of the orchestrator e2e tier this runs
 * via `npm run test:e2e`, not in the gating `npm test`. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { pauseFleet, resumeFleet } from "../src/fleet/fleet-state.js";
import { freshLoopState, loadLoopState, saveLoopState } from "../src/loop/loop-state.js";
import { orchestratorStatePath } from "../src/paths.js";
import { initProject } from "../src/init/init.js";
import { readEvents } from "../src/events/event-read.js";
import { fastConfig, makeFastRepo, onceRound } from "./fixtures/orchestrator-fixtures.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { mainSha, makeRepo } from "./fixtures/repo-fixtures.js";
import { fakePi, fakePiIdle } from "./fakes/fake-pi.js";
import { cli } from "./helpers/cli-harness.js";
import { assistantLine } from "./fixtures/pi-events.js";

test("once: a fleet where every role finds nothing to do exits on its own, one tick each", async () => {
  const repo = await makeFastRepo("once round test", ["clean", "dry"]);
  const restore = fakePiIdle();
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false, "a once round never reports a restart");
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "clean ticked exactly once");
    assert.equal(loadLoopState(repo, "dry").ticks, 1, "dry ticked exactly once");
  } finally {
    restore();
  }
});

test("once: a round that produces a change merges it before exiting", async () => {
  const repo = await makeFastRepo("once landing test", ["clean"]);
  const before = mainSha(repo);
  // Author run: make a change and finish. Review run (its prompt carries VERDICT): approve.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\\n' '${assistantLine("done\nSUMMARY: add hello file")}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.ok(fs.existsSync(path.join(repo, "hello.txt")), "the change landed on main");
    assert.notEqual(mainSha(repo), before, "main's head moved");
    assert.ok(
      readEvents(repo).some((e) => e.type === "landed" && e.loop === "clean"),
      "the round's landed event is in events.jsonl",
    );
  } finally {
    restore();
  }
});

test("once: a role in error backoff is skipped and does not run, and the round still ends", async () => {
  const repo = await makeFastRepo("once backoff test", ["clean"]);
  // Persisted backoff: nextRunAt in the future with backoffSeconds raised — once mode
  // honors a backoff deadline (it overrides only the min-tick-interval clock, and the
  // clock is told from backoff by backoffSeconds, which only a backoff ladder leaves set).
  saveLoopState(repo, {
    ...freshLoopState("clean"),
    ticks: 3,
    lastResult: "error",
    lastTickEndedAt: Date.now(),
    nextRunAt: Date.now() + 60_000,
    backoffSeconds: 60,
  });
  const restore = fakePiIdle();
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(loadLoopState(repo, "clean").ticks, 3, "the backed-off role ran no tick");
    assert.ok(
      !readEvents(repo).some((e) => e.type === "tick_start" && e.loop === "clean"),
      "no tick started for the backed-off role",
    );
  } finally {
    restore();
  }
});

test("once: a fleet under a standing pause settles every role as paused, ticks nothing, and still exits", async () => {
  const repo = await makeFastRepo("once paused test", ["clean"]);
  pauseFleet(repo);
  const restore = fakePiIdle();
  try {
    // The round must not hang on a pause it cannot lift — a once round has to end even when
    // a pause marker is left over (the orchestrator settles the role before the gates that
    // would otherwise skip it silently, so the at-most-one-tick contract holds).
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(exit.settled?.get("clean"), "paused", "the pause is the recorded settle reason, not idle");
    assert.equal(exit.ticksRun?.get("clean"), 0, "the paused role ran no tick");
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "nothing ticked under the pause");
    assert.ok(
      !readEvents(repo).some((e) => e.type === "tick_start"),
      "no tick started for the paused role",
    );
  } finally {
    resumeFleet(repo);
    restore();
  }
});

test("once: a round started right after a productive daemon tick still ticks the role", async () => {
  const repo = await makeFastRepo("once fresh clock test", ["clean"]);
  // State exactly as a just-finished productive daemon tick leaves it: the min-interval
  // clock is a full interval away (scheduleAtMinInterval) and backoffSeconds is 0. The
  // round is an explicit demand for a round now, so the role must tick despite the fresh
  // clock — this is the scenario the once-mode clock override exists for (a real config's
  // minTickIntervalSeconds made the old gap-only override a no-op here).
  saveLoopState(repo, {
    ...freshLoopState("clean"),
    ticks: 1,
    lastResult: "changed",
    lastTickEndedAt: Date.now(),
    lastMainHead: "seed",
    nextRunAt: Date.now() + 30 * 60 * 1000,
    backoffSeconds: 0,
  });
  const restore = fakePiIdle();
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(loadLoopState(repo, "clean").ticks, 2, "the role ticked despite its fresh clock");
  } finally {
    restore();
  }
});

test("once: a deferrable role with an open backlog is deferred and does not block exit", async () => {
  const repo = await makeFastRepo("once deferral test", ["clean"]);
  // An open backlog (PLANS.md ## Planned) plus a no_change history defers clean's due tick —
  // in once mode that deferral is the role's round answer, not something to wait out.
  fs.writeFileSync(path.join(repo, "PLANS.md"), "# Plans\n\n## Planned\n\n### a queued feature (planned 2026-09-25)\n");
  const head = mainSha(repo);
  saveLoopState(repo, {
    ...freshLoopState("clean"),
    ticks: 1,
    lastResult: "no_change",
    lastMainHead: head,
    nextRunAt: Date.now() - 1000, // due: without deferral it would tick
  });
  const restore = fakePiIdle();
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "the deferred role ran no tick");
    assert.ok(
      readEvents(repo).some((e) => e.type === "tick_deferred" && e.loop === "clean"),
      "the deferral is logged, not silent",
    );
  } finally {
    restore();
  }
});

test("once: the CLI prints a per-role summary line and exits 0", async () => {
  const repo = await makeFastRepo("once cli test", ["clean"]);
  const restore = fakePiIdle();
  try {
    const r = await cli(repo, "run", "--once");
    assert.equal(r.code, 0, `exit 0 on its own (stderr: ${r.stderr})`);
    assert.match(r.stdout, /once: 1 tick — 1 no_change/, `summary line in stdout: ${r.stdout}`);
  } finally {
    restore();
  }
});

test("once: the summary reports a deferred role as deferred, not idle", async () => {
  const repo = makeRepo();
  await initProject(repo, "once summary deferral test");
  saveConfig(repo, fastConfig(["clean"]));
  // Same deferral setup as the in-process test above: an open backlog plus a no_change
  // history defers clean's due tick. The summary is the round's only cron-visible output, so
  // it must carry the orchestrator's own settle reason — "deferred" (the tick WAS due and was
  // set aside) — not the re-derived "idle" (nothing was due), which misreads the round.
  fs.writeFileSync(path.join(repo, "PLANS.md"), "# Plans\n\n## Planned\n\n### a queued feature (planned 2026-09-25)\n");
  const head = mainSha(repo);
  saveLoopState(repo, {
    ...freshLoopState("clean"),
    ticks: 1,
    lastResult: "no_change",
    lastMainHead: head,
    nextRunAt: Date.now() - 1000, // due: the deferral, not the clock, keeps it from running
  });
  const restore = fakePiIdle();
  try {
    const r = await cli(repo, "run", "--once");
    assert.equal(r.code, 0, `exit 0 (stderr: ${r.stderr})`);
    assert.match(r.stdout, /once: 0 ticks — nothing ran, 1 skipped \(deferred\)/,
      `summary names the deferral: ${r.stdout}`);
  } finally {
    restore();
  }
});

test("once: a once round refuses to start while a daemon holds the orchestrator", async () => {
  const repo = makeRepo();
  await initProject(repo, "once daemon guard");
  // Record a live pid (this test process) as the running orchestrator — two writers to main
  // is exactly what the guard exists to prevent, once mode included.
  writeOrchestratorMarker(repo, []);
  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "run", "--once");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /an orchestrator is already running/);
  } finally {
    fs.rmSync(orchestratorStatePath(repo), { force: true });
    restore();
  }
});

test("once: a typo'd flag fails fast with the unknown-argument wording", async () => {
  const repo = makeRepo();
  await initProject(repo, "once flag guard");
  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "run", "--onc");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown argument: --onc/);
    assert.match(r.stderr, /valid flags for tumwater run: --branch <name>, --once, --gui, --for <duration>, --role <id>/);
  } finally {
    restore();
  }
});

// --- Scoped once rounds (`run --once --role <id>`, PLANS.md 2026-09-25) ---

test("once --role: a scoped round ticks only the named role", async () => {
  const repo = await makeFastRepo("once scoped test", ["clean", "dry"]);
  const restore = fakePiIdle();
  try {
    const exit = await onceRound(repo, "clean");
    assert.equal(exit.restart, false, "a scoped round still exits on its own");
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "the scoped role ticked exactly once");
    assert.equal(loadLoopState(repo, "dry").ticks, 0, "the other role never ran");
  } finally {
    restore();
  }
});

test("once --role: a scoped round that produces a change merges it before exiting", async () => {
  const repo = await makeFastRepo("once scoped landing test", ["clean", "dry"]);
  const before = mainSha(repo);
  // Author run: make a change and finish. Review run (its prompt carries VERDICT): approve.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\\n' '${assistantLine("done\\nSUMMARY: add hello file")}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  try {
    const exit = await onceRound(repo, "clean");
    assert.equal(exit.restart, false);
    assert.ok(fs.existsSync(path.join(repo, "hello.txt")), "the change landed on main");
    assert.notEqual(mainSha(repo), before, "main's head moved");
    assert.equal(loadLoopState(repo, "dry").ticks, 0, "the unscoped role never ran");
  } finally {
    restore();
  }
});

test("once --role: the CLI scopes the round — banner and summary name only that role", async () => {
  const repo = await makeFastRepo("once scoped cli test", ["clean", "dry"]);
  const restore = fakePiIdle();
  try {
    const r = await cli(repo, "run", "--once", "--role", "clean");
    assert.equal(r.code, 0, `exit 0 on its own (stderr: ${r.stderr})`);
    assert.match(r.stdout, /loops: clean\n/, `the banner names only the scoped role: ${r.stdout}`);
    assert.match(r.stdout, /once: 1 tick — 1 no_change/,
      `the summary counts only the scoped role's tick: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /\bdry\b/);
    assert.equal(loadLoopState(repo, "dry").ticks, 0, "the other role's persisted counter is unchanged");
  } finally {
    restore();
  }
});

test("once --role: an unknown or disabled role fails fast with the shared wording", async () => {
  const repo = await makeFastRepo("once scoped invalid test", ["clean"]); // dry is disabled
  const restore = fakePi("exit 0");
  try {
    const unknown = await cli(repo, "run", "--once", "--role", "nope");
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /unknown role: nope \(valid ids: .*clean/);
    const disabled = await cli(repo, "run", "--once", "--role", "dry");
    assert.equal(disabled.code, 1);
    assert.match(disabled.stderr, /unknown role: dry \(valid ids: .*clean/,
      "a disabled id reads as unknown: it is not a role this round can run");
  } finally {
    restore();
  }
});

test("once --role: --role without --once fails with its own message", async () => {
  const repo = await makeFastRepo("once scoped daemon test", ["clean"]);
  const restore = fakePi("exit 0");
  try {
    const r = await cli(repo, "run", "--role", "clean");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--role is only valid with --once/,
      "daemon `run --role` stays an error: scoping is a once-round concept");
  } finally {
    restore();
  }
});

test("once --role: a custom loop id is a valid target", async () => {
  const repo = await makeFastRepo("once scoped custom test", ["clean"]);
  const config = loadConfig(repo);
  config.customLoops.push({ name: "docs-sync", task: "Keep the docs current." });
  saveConfig(repo, config);
  const restore = fakePiIdle();
  try {
    const r = await cli(repo, "run", "--once", "--role", "docs-sync");
    assert.equal(r.code, 0, `a custom loop scopes like a built-in (stderr: ${r.stderr}; stdout: ${r.stdout})`);
    assert.equal(loadLoopState(repo, "docs-sync").ticks, 1, "the custom loop ticked once");
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "the enabled built-in never ran");
  } finally {
    restore();
  }
});
