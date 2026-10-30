/** `tumwater start --once` (PLANS.md 2026-09-25): one full round of runs — every enabled role
 * at most once, every change that round produced merged — then exit 0. Tests (a)–(d) drive
 * runOrchestrator directly in once mode on the standard fixture pattern (fake pi shim, short
 * poll); (e)–(g) go through the real CLI so the supervisor half, the flag vocabulary, and the
 * summary line are exercised end to end. Like the rest of the orchestrator e2e tier this runs
 * via `npm run test:e2e`, not in the gating `npm test`. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { pauseTeam, resumeTeam } from "../src/team/team-state.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { orchestratorStatePath } from "../src/paths.js";
import { initProject } from "../src/init/init.js";
import { readEvents } from "../src/events/event-read.js";
import { fastConfig, makeFastRepo, onceRound } from "./fixtures/orchestrator-fixtures.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { mainSha, makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi, fakePiIdle, withIdlePi, withPi } from "./fakes/fake-pi.js";
import { awaitQuietHost } from "./helpers/wait.js";
import { cli } from "./helpers/cli-harness.js";
import { assistantLine } from "./fixtures/pi-events.js";

test("once: a team where every role finds nothing to do exits on its own, one run each", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = await makeFastRepo("once round test", ["clean", "dedupe"]);
  await withIdlePi(async () => {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false, "a once round never reports a restart");
    assert.equal(loadRunnerState(repo, "clean").runs, 1, "clean ran exactly once");
    assert.equal(loadRunnerState(repo, "dedupe").runs, 1, "dedupe ran exactly once");
  });
});

test("once: a round that produces a change merges it before exiting", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = await makeFastRepo("once merge test", ["clean"]);
  const before = mainSha(repo);
  // Author run: make a change and finish. Review run (its prompt carries VERDICT): approve.
  await withPi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\\n' '${assistantLine("done\nSUMMARY: add hello file")}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
    async () => {
      const exit = await onceRound(repo);
      assert.equal(exit.restart, false);
      assert.ok(fs.existsSync(path.join(repo, "hello.txt")), "the change merged on main");
      assert.notEqual(mainSha(repo), before, "main's head moved");
      assert.ok(
        readEvents(repo).some((e) => e.type === "merge_done" && e.source === "clean"),
        "the round's merge_done event is in events.jsonl",
      );
    },
  );
});

test("once: a role in error backoff is skipped and does not run, and the round still ends", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = await makeFastRepo("once backoff test", ["clean"]);
  // Persisted backoff: nextRunAt in the future with backoffSeconds raised — once mode
  // honors a backoff deadline (it overrides only the min-run-interval clock, and the
  // clock is told from backoff by backoffSeconds, which only a backoff ladder leaves set).
  saveRunnerState(repo, {
    ...freshRunnerState("clean"),
    runs: 3,
    lastResult: "error",
    lastRunEndedAt: Date.now(),
    nextRunAt: Date.now() + 60_000,
    backoffSeconds: 60,
  });
  await withIdlePi(async () => {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(loadRunnerState(repo, "clean").runs, 3, "the backed-off role did not run");
    assert.ok(
      !readEvents(repo).some((e) => e.type === "run_start" && e.source === "clean"),
      "no run started for the backed-off role",
    );
  });
});

test("once: a team under a standing pause settles every role as paused, runs nothing, and still exits", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = await makeFastRepo("once paused test", ["clean"]);
  pauseTeam(repo);
  const restore = fakePiIdle();
  try {
    // The round must not hang on a pause it cannot lift — a once round has to end even when
    // a pause marker is left over (the orchestrator settles the role before the gates that
    // would otherwise skip it silently, so the at-most-one-run contract holds).
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(exit.settled?.get("clean"), "paused", "the pause is the recorded settle reason, not idle");
    assert.equal(exit.runsDone?.get("clean"), 0, "the paused role did not run");
    assert.equal(loadRunnerState(repo, "clean").runs, 0, "nothing ran under the pause");
    assert.ok(
      !readEvents(repo).some((e) => e.type === "run_start"),
      "no run started for the paused role",
    );
  } finally {
    resumeTeam(repo);
    restore();
  }
});

test("once: a round started right after a productive daemon run still runs the role", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = await makeFastRepo("once fresh clock test", ["clean"]);
  // State exactly as a just-finished productive daemon run leaves it: the min-interval
  // clock is a full interval away (scheduleAtMinInterval) and backoffSeconds is 0. The
  // round is an explicit demand for a round now, so the role must run despite the fresh
  // clock — this is the scenario the once-mode clock override exists for (a real config's
  // minRunIntervalSeconds made the old gap-only override a no-op here).
  saveRunnerState(repo, {
    ...freshRunnerState("clean"),
    runs: 1,
    lastResult: "changed",
    lastRunEndedAt: Date.now(),
    lastMainHead: "seed",
    nextRunAt: Date.now() + 30 * 60 * 1000,
    backoffSeconds: 0,
  });
  await withIdlePi(async () => {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(loadRunnerState(repo, "clean").runs, 2, "the role ran despite its fresh clock");
  });
});

test("once: a deferrable role with an open backlog is deferred and does not block exit", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = await makeFastRepo("once deferral test", ["clean"]);
  // An open backlog (PLANS.md ## Planned) plus a no_change history defers clean's due run —
  // in once mode that deferral is the role's round answer, not something to wait out.
  fs.writeFileSync(path.join(repo, "PLANS.md"), "# Plans\n\n## Planned\n\n### a queued feature (planned 2026-09-25)\n");
  const head = mainSha(repo);
  saveRunnerState(repo, {
    ...freshRunnerState("clean"),
    runs: 1,
    lastResult: "no_change",
    lastMainHead: head,
    nextRunAt: Date.now() - 1000, // due: without deferral it would run
  });
  await withIdlePi(async () => {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(loadRunnerState(repo, "clean").runs, 1, "the deferred role did not run");
    assert.ok(
      readEvents(repo).some((e) => e.type === "run_deferred" && e.source === "clean"),
      "the deferral is logged, not silent",
    );
  });
});

test("once: the CLI prints a per-role summary line and exits 0", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = await makeFastRepo("once cli test", ["clean"]);
  await withIdlePi(async () => {
    const r = await cli(repo, "run", "--once");
    assert.equal(r.code, 0, `exit 0 on its own (stderr: ${r.stderr})`);
    assert.match(r.stdout, /once: 1 run — 1 no_change/, `summary line in stdout: ${r.stdout}`);
  });
});

test("once: the summary reports a deferred role as deferred, not idle", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = makeRepo();
  await initProject(repo, "once summary deferral test");
  saveConfig(repo, fastConfig(["clean"]));
  // Same deferral setup as the in-process test above: an open backlog plus a no_change
  // history defers clean's due run. The summary is the round's only cron-visible output, so
  // it must carry the orchestrator's own settle reason — "deferred" (the run WAS due and was
  // set aside) — not the re-derived "idle" (nothing was due), which misreads the round.
  fs.writeFileSync(path.join(repo, "PLANS.md"), "# Plans\n\n## Planned\n\n### a queued feature (planned 2026-09-25)\n");
  const head = mainSha(repo);
  saveRunnerState(repo, {
    ...freshRunnerState("clean"),
    runs: 1,
    lastResult: "no_change",
    lastMainHead: head,
    nextRunAt: Date.now() - 1000, // due: the deferral, not the clock, keeps it from running
  });
  await withIdlePi(async () => {
    const r = await cli(repo, "run", "--once");
    assert.equal(r.code, 0, `exit 0 (stderr: ${r.stderr})`);
    assert.match(r.stdout, /once: 0 runs — nothing ran, 1 skipped \(deferred\)/,
      `summary names the deferral: ${r.stdout}`);
  });
});

test("once: a once round refuses to start while a daemon holds the orchestrator", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
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

test("once: a typo'd flag fails fast with the unknown-argument wording", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = makeRepo();
  await initProject(repo, "once flag guard");
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--onc");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown argument: --onc/);
    assert.match(r.stderr, /valid flags for tumwater start: --branch <name>, --once, --json, --gui, --port <n>, --all-interfaces, --token <secret>, --tui, --for <duration>, --role <id>/);
  });
});

// --- Scoped once rounds (`run --once --role <id>`, PLANS.md 2026-09-25) ---

test("once --role: a scoped round runs only the named role", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = await makeFastRepo("once scoped test", ["clean", "dedupe"]);
  await withIdlePi(async () => {
    const exit = await onceRound(repo, "clean");
    assert.equal(exit.restart, false, "a scoped round still exits on its own");
    assert.equal(loadRunnerState(repo, "clean").runs, 1, "the scoped role ran exactly once");
    assert.equal(loadRunnerState(repo, "dedupe").runs, 0, "the other role never ran");
  });
});

test("once --role: a scoped round that produces a change merges it before exiting", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = await makeFastRepo("once scoped merge test", ["clean", "dedupe"]);
  const before = mainSha(repo);
  // Author run: make a change and finish. Review run (its prompt carries VERDICT): approve.
  await withPi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\\n' '${assistantLine("done\\nSUMMARY: add hello file")}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
    async () => {
      const exit = await onceRound(repo, "clean");
      assert.equal(exit.restart, false);
      assert.ok(fs.existsSync(path.join(repo, "hello.txt")), "the change merged on main");
      assert.notEqual(mainSha(repo), before, "main's head moved");
      assert.equal(loadRunnerState(repo, "dedupe").runs, 0, "the unscoped role never ran");
    },
  );
});

test("once --role: the CLI scopes the round — banner and summary name only that role", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = await makeFastRepo("once scoped cli test", ["clean", "dedupe"]);
  await withIdlePi(async () => {
    const r = await cli(repo, "run", "--once", "--role", "clean");
    assert.equal(r.code, 0, `exit 0 on its own (stderr: ${r.stderr})`);
    assert.match(r.stdout, /roles: clean\n/, `the banner names only the scoped role: ${r.stdout}`);
    assert.match(r.stdout, /once: 1 run — 1 no_change/,
      `the summary counts only the scoped role's run: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /\bdedupe\b/);
    assert.equal(loadRunnerState(repo, "dedupe").runs, 0, "the other role's persisted counter is unchanged");
  });
});

test("once --role: an unknown role fails fast with the shared wording, and a disabled one names how to enable it", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = await makeFastRepo("once scoped invalid test", ["clean"]); // dedupe is disabled
  await withPi("exit 0", async () => {
    const unknown = await cli(repo, "run", "--once", "--role", "nope");
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /unknown role: nope \(valid ids: .*clean/);
    const disabled = await cli(repo, "run", "--once", "--role", "dedupe");
    assert.equal(disabled.code, 1);
    assert.match(
      disabled.stderr,
      /dedupe is disabled, so a --once round cannot run it — enable it with `tumwater role dedupe --enable`/,
      "a disabled id is named as disabled, with the command that enables it",
    );
  });
});

test("once --role: --role without --once fails with its own message", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = await makeFastRepo("once scoped daemon test", ["clean"]);
  await withPi("exit 0", async () => {
    const r = await cli(repo, "run", "--role", "clean");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--role is only valid with --once/,
      "daemon `run --role` stays an error: scoping is a once-round concept");
  });
});

test("once --role: a custom role id is a valid target", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = await makeFastRepo("once scoped custom test", ["clean"]);
  const config = loadConfig(repo);
  config.customRoles.push({ name: "docs-sync", task: "Keep the docs current." });
  saveConfig(repo, config);
  await withIdlePi(async () => {
    const r = await cli(repo, "run", "--once", "--role", "docs-sync");
    assert.equal(r.code, 0, `a custom role scopes like a built-in (stderr: ${r.stderr}; stdout: ${r.stdout})`);
    assert.equal(loadRunnerState(repo, "docs-sync").runs, 1, "the custom role ran once");
    assert.equal(loadRunnerState(repo, "clean").runs, 0, "the enabled built-in never ran");
  });
});

test("once: a merge_blocked change is re-queued by the pipeline and merges with no second run", async (t) => {
  const host = await awaitQuietHost();
  if (!host.quiet) {
    t.skip(`host load ${host.load1} on ${host.cpus} cores: e2e deferred, not a verdict`);
    return;
  }
  const repo = await makeFastRepo("once requeue test", ["clean"]);
  const counter = path.join(tmpdir("requeue-count-"), "n");
  const config = loadConfig(repo);
  // Invocation 1 is the review gate's pre-check, 2 the in-lock merge check, and 3 the merge
  // check's one immediate flake re-run — the first attempt's three invocations. The gate's own
  // pre-check moves main (once, via `bump`), so the merge's rebase is not a no-op and the
  // in-lock merge check runs. It is red twice (2 and 3), so the immediate re-run does not pass
  // the red as a flake and merge; the change is re-queued as merge_blocked. The re-queued
  // attempt's pre-check (4) is green. With the pre-merge gate's reviewer gone (part 3h/3), the
  // check command itself stages the main movement that used to ride the reviewer's VERDICT, so
  // the rebase is still not a no-op and the in-lock merge check still runs.
  const bump =
    `[ -f '${counter}.bumped' ] || { touch '${counter}.bumped'; ` +
    `echo bump > '${repo}/bump.txt'; git -C '${repo}' add bump.txt; ` +
    `git -C '${repo}' -c user.name=t -c user.email=t@t commit -q -m bump; }`;
  config.check = {
    command: `${bump}\nn=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'; [ $n -lt 2 ] || [ $n -gt 3 ]`,
  };
  saveConfig(repo, config);
  await withPi(
    [
      `printf '%s\\n' '${assistantLine("done\nSUMMARY: add hello file")}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
    async () => {
      await onceRound(repo);
      const events = readEvents(repo);
      const types = events.map((e) => e.type);
      const failed = events.findIndex((e) => e.type === "merge_failed");
      assert.equal(events[failed]!.result, "merge_blocked", "the first merge attempt was blocked");
      const done = events.findIndex((e) => e.type === "merge_done");
      assert.ok(done > failed, "the change merged after the blocked attempt");
      assert.equal(
        types.slice(failed, done).includes("run_start"),
        false,
        "no run_start for the author between merge_failed and merge_done",
      );
      const requeue = events.slice(failed, done).find((e) => e.type === "merge_queued");
      assert.equal(requeue?.retry, "merge_blocked", "the pipeline's re-queue names the result it retries");
      assert.equal(requeue?.summary, "add hello file", "the re-queue keeps the original summary");
      assert.equal(events[done]!.result, "changed");
    },
  );
});
