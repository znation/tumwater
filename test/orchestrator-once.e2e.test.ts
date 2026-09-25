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
import { runOrchestrator } from "../src/orchestrator.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { freshLoopState, loadLoopState, saveLoopState } from "../src/state.js";
import { orchestratorStatePath } from "../src/paths.js";
import { initProject } from "../src/init.js";
import { readEvents } from "../src/events.js";
import {
  assistantLine,
  cli,
  fakePi,
  fakePiIdle,
  FAST_POLL_MS,
  fastConfig,
  makeRepo,
  sh,
} from "./util.js";

/** Run one once round in-process with the repo's on-disk config, failing loudly if the round
 * does not exit on its own — a once round that hangs is the bug this feature exists to avoid. */
function onceRound(repo: string): Promise<{ restart: boolean }> {
  const done = runOrchestrator({
    root: repo,
    config: loadConfig(repo),
    mainBranch: "main",
    signal: new AbortController().signal,
    pollMs: FAST_POLL_MS,
    once: true,
  });
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error("once round did not exit on its own")), 30_000);
    t.unref();
  });
  return Promise.race([done, timeout]);
}

test("once: a fleet where every role finds nothing to do exits on its own, one tick each", async () => {
  const repo = makeRepo();
  await initProject(repo, "once round test");
  saveConfig(repo, fastConfig(["clean", "dry"]));
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
  const repo = makeRepo();
  await initProject(repo, "once landing test");
  saveConfig(repo, fastConfig(["clean"]));
  const before = sh(repo, "git", "rev-parse", "main").trim();
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
    assert.notEqual(sh(repo, "git", "rev-parse", "main").trim(), before, "main's head moved");
    assert.ok(
      readEvents(repo).some((e) => e.type === "landed" && e.loop === "clean"),
      "the round's landed event is in events.jsonl",
    );
  } finally {
    restore();
  }
});

test("once: a role in error backoff is skipped and does not run, and the round still ends", async () => {
  const repo = makeRepo();
  await initProject(repo, "once backoff test");
  saveConfig(repo, fastConfig(["clean"]));
  // Persisted backoff: nextRunAt in the future — once mode honors it (it overrides only the
  // min-tick-interval gap, never error backoff).
  saveLoopState(repo, {
    ...freshLoopState("clean"),
    ticks: 3,
    lastResult: "no_change",
    lastTickEndedAt: Date.now(),
    nextRunAt: Date.now() + 60_000,
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

test("once: a deferrable role with an open backlog is deferred and does not block exit", async () => {
  const repo = makeRepo();
  await initProject(repo, "once deferral test");
  saveConfig(repo, fastConfig(["clean"]));
  // An open backlog (PLANS.md ## Planned) plus a no_change history defers clean's due tick —
  // in once mode that deferral is the role's round answer, not something to wait out.
  fs.writeFileSync(path.join(repo, "PLANS.md"), "# Plans\n\n## Planned\n\n### a queued feature (planned 2026-09-25)\n");
  const head = sh(repo, "git", "rev-parse", "main").trim();
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
  const repo = makeRepo();
  await initProject(repo, "once cli test");
  saveConfig(repo, fastConfig(["clean"]));
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
  const head = sh(repo, "git", "rev-parse", "main").trim();
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
  fs.mkdirSync(path.dirname(orchestratorStatePath(repo)), { recursive: true });
  fs.writeFileSync(
    orchestratorStatePath(repo),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: [] }),
  );
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
    assert.match(r.stderr, /valid flags for tumwater run: --branch <name>, --once/);
  } finally {
    restore();
  }
});
