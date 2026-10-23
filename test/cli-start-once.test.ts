import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initProject } from "../src/init/init.js";
import { makeRepo, writeConfig } from "./fixtures/repo-fixtures.js";
import { fastConfig } from "./fixtures/orchestrator-fixtures.js";
import { withIdlePi, withPi } from "./fakes/fake-pi.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { cli, exitCode, spawnCli } from "./helpers/cli-harness.js";
import { waitFor } from "./helpers/wait.js";
import { orchestratorStatePath } from "../src/paths.js";
import { readJson } from "./helpers/json-read.js";

// The scoped `run --once --role` happy path through the real CLI. The pre-boot `--role` guards
// live in cli-start-guards.test.ts; this is the round they gate. Split out of the run-live family
// so the once round's own startup/exit is measured apart from the long-running lifecycle and
// forced-exit/sigint files (cli-start-shutdown.test.ts, cli-start-sigint.test.ts,
// cli-start-force-exit.test.ts).

test("run --once --role runs only the scoped role through the real CLI and exits 0", async () => {
  // The scoped round's happy path. Until now only the e2e tier pinned a successful --once
  // round (orchestrator-once.e2e.test.ts), so the gating suite never ran one: the wiring this
  // exercises — the startup gate, the role filter into runOrchestrator, the once banner, the
  // summary, and the exit — could regress with `npm test` staying green.
  const repo = makeRepo();
  await initProject(repo, "cli run once scoped");
  writeConfig(repo, fastConfig(["clean", "dedupe"]));

  // fakePiIdle ends every run as nothing-to-do, so the round exits on its own without
  // merging anything — the round's own exit is the observable, not a merge.
  await withIdlePi(async () => {
    const r = await cli(repo, "run", "--once", "--role", "clean");
    assert.equal(r.code, 0, `exit 0 on its own (stderr: ${r.stderr})`);
    assert.match(r.stdout, /tumwater once on branch main/, `the once banner: ${r.stdout}`);
    assert.match(r.stdout, /roles: clean\n/, `the banner names only the scoped role: ${r.stdout}`);
    assert.match(r.stdout, /once: 1 run — 1 no_change/,
      `the summary counts only the scoped role's run: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /\bdedupe\b/, `the unscoped role must be invisible: ${r.stdout}`);
    assert.equal(loadRunnerState(repo, "clean").runs, 1, "the scoped role ran exactly once");
    assert.equal(loadRunnerState(repo, "dedupe").runs, 0, "the unscoped role never ran");
  });
});

test("run --once --role with a comma list runs exactly the listed roles and exits 0", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run once scoped list");
  writeConfig(repo, fastConfig(["clean", "dedupe", "organize"]));

  await withIdlePi(async () => {
    const r = await cli(repo, "run", "--once", "--role", "clean,dedupe");
    assert.equal(r.code, 0, `exit 0 on its own (stderr: ${r.stderr})`);
    assert.match(r.stdout, /roles: clean, dedupe\n/, `the banner names the listed roles: ${r.stdout}`);
    assert.match(r.stdout, /once: 2 runs — 2 no_change/, `the summary counts both runs: ${r.stdout}`);
    assert.equal(loadRunnerState(repo, "clean").runs, 1);
    assert.equal(loadRunnerState(repo, "dedupe").runs, 1);
    assert.equal(loadRunnerState(repo, "organize").runs, 0, "the unlisted role never ran");
  });
});

test("run --once exits 3 and names the role when its run ended in error", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run once failed");
  writeConfig(repo, fastConfig(["clean"]));
  await withPi("exit 1", async () => {
    const r = await cli(repo, "run", "--once", "--role", "clean");
    assert.equal(loadRunnerState(repo, "clean").lastResult, "error");
    assert.equal(r.code, 3, `exit 3 (stderr: ${r.stderr})`);
    assert.match(r.stdout, /once: failed — clean error/);
  });
});

test("run --once --json prints one JSON object and no banner or event stream", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run once json");
  writeConfig(repo, fastConfig(["clean"]));
  await withIdlePi(async () => {
    const r = await cli(repo, "run", "--once", "--json");
    assert.equal(r.code, 0, `exit 0 (stderr: ${r.stderr})`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.runs, 1);
    assert.deepEqual(parsed.outcomes, { no_change: 1 });
    assert.deepEqual(parsed.skipped, []);
    assert.deepEqual(parsed.failures, []);
    assert.doesNotMatch(r.stdout, /tumwater once on branch/, "no banner on stdout");
    assert.doesNotMatch(r.stdout, /roles:/, "no roles banner on stdout");
  });
});

test("run --once --json interrupted by a signal prints only the JSON and exits non-zero", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run once json signal");
  writeConfig(repo, fastConfig(["clean"]));
  // The pi shim sleeps, so the round is still in flight when the signal lands — the
  // deterministic window in which a signal really interrupts a --once --json round. The
  // graceful stop must not leak prose onto stdout (its contract is one JSON document) and
  // the truncated round must not exit 0, or a cron/CI caller reads a cut-short run as success.
  await withPi("sleep 30", async () => {
    const s = spawnCli(repo, ["run", "--once", "--json"]);
    try {
      await waitFor(() => {
        const file = orchestratorStatePath(repo);
        if (!fs.existsSync(file)) return false;
        const info = readJson(file) as { pid?: number };
        return typeof info.pid === "number";
      }, "the orchestrator info file");
      const { pid } = readJson(orchestratorStatePath(repo)) as { pid: number };
      process.kill(pid, "SIGINT");
      const code = await exitCode(s.child);
      assert.notEqual(code, 0, `an interrupted --once --json round must not exit 0; out: ${s.out()}`);
      const parsed = JSON.parse(s.out().trim());
      assert.equal(typeof parsed.runs, "number", `stdout holds the one JSON document: ${s.out()}`);
      assert.doesNotMatch(s.out(), /stopping — finishing current runs/, "no stop prose on stdout");
    } finally {
      s.kill();
    }
  });
});

test("run --json without --once is refused and boots nothing", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run json refused");
  writeConfig(repo, fastConfig(["clean"]));
  const r = await cli(repo, "run", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json is only valid with --once/);
});
