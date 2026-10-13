import test from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init/init.js";
import { makeRepo, writeConfig } from "./fixtures/repo-fixtures.js";
import { fastConfig } from "./fixtures/orchestrator-fixtures.js";
import { withIdlePi, withPi } from "./fakes/fake-pi.js";
import { loadLoopState } from "../src/loop/loop-state.js";
import { cli } from "./helpers/cli-harness.js";

// The scoped `run --once --role` happy path through the real CLI. The pre-boot `--role` guards
// live in cli-run-guards.test.ts; this is the round they gate. Split out of the run-live family
// so the once round's own startup/exit is measured apart from the long-running lifecycle and
// forced-exit/sigint files (cli-run-shutdown.test.ts, cli-run-sigint.test.ts,
// cli-run-force-exit.test.ts).

test("run --once --role ticks only the scoped role through the real CLI and exits 0", async () => {
  // The scoped round's happy path. Until now only the e2e tier pinned a successful --once
  // round (orchestrator-once.e2e.test.ts), so the gating suite never ran one: the wiring this
  // exercises — the startup gate, the role filter into runOrchestrator, the once banner, the
  // summary, and the exit — could regress with `npm test` staying green.
  const repo = makeRepo();
  await initProject(repo, "cli run once scoped");
  writeConfig(repo, fastConfig(["clean", "dry"]));

  // fakePiIdle ends every tick as nothing-to-do, so the round exits on its own without
  // landing anything — the round's own exit is the observable, not a merge.
  await withIdlePi(async () => {
    const r = await cli(repo, "run", "--once", "--role", "clean");
    assert.equal(r.code, 0, `exit 0 on its own (stderr: ${r.stderr})`);
    assert.match(r.stdout, /tumwater once on branch main/, `the once banner: ${r.stdout}`);
    assert.match(r.stdout, /loops: clean\n/, `the banner names only the scoped role: ${r.stdout}`);
    assert.match(r.stdout, /once: 1 tick — 1 no_change/,
      `the summary counts only the scoped role's tick: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /\bdry\b/, `the unscoped role must be invisible: ${r.stdout}`);
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "the scoped role ticked exactly once");
    assert.equal(loadLoopState(repo, "dry").ticks, 0, "the unscoped role never ran");
  });
});

test("run --once exits 3 and names the role when its tick ended in error", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run once failed");
  writeConfig(repo, fastConfig(["clean"]));
  await withPi("exit 1", async () => {
    const r = await cli(repo, "run", "--once", "--role", "clean");
    assert.equal(loadLoopState(repo, "clean").lastResult, "error");
    assert.equal(r.code, 3, `exit 3 (stderr: ${r.stderr})`);
    assert.match(r.stdout, /once: failed — clean error/);
  });
});
