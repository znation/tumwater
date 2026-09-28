import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SUPERVISED_ENV } from "../src/supervisor.js";
import { orderByDuration, selectTestFiles, suiteEnv, suiteGitEnv } from "../src/test-runner.js";
import { tmpdir } from "./repo-fixtures.js";

/** A temp dir standing in for dist/test, seeded with the given compiled file names. */
function fakeDistDir(...files: string[]): string {
  const dir = tmpdir("test-runner-");
  for (const f of files) fs.writeFileSync(path.join(dir, f), "");
  return dir;
}

test("no filters selects every compiled test file except the e2e tier, in sort order", () => {
  const dir = fakeDistDir("z.test.js", "a.test.js", "m.e2e.test.js", "m.test.js");
  fs.writeFileSync(path.join(dir, "helper.js"), ""); // Not a test file — ignored.
  const sel = selectTestFiles([], dir);
  assert.equal(sel.error, undefined);
  // The live-orchestrator e2e files (BUGS.md 2026-09-21) stay out of the unfiltered run
  // the harness's build gate executes — their wall-clock waits are not load-proof.
  assert.deepEqual(sel.names, ["a.test.ts", "m.test.ts", "z.test.ts"]);
  assert.ok(sel.files.every((f) => f.endsWith(".test.js")));
  assert.equal(sel.files[0], path.join(dir, "a.test.js"));
});

test("an explicit filter selects e2e files too, so the tier is one `npm test e2e` away", () => {
  const dir = fakeDistDir("merge.test.js", "orchestrator.e2e.test.js", "orchestrator-2.e2e.test.js");
  // The tier's own filter selects only the e2e files — package.json's test:e2e rides on this.
  assert.deepEqual(selectTestFiles(["e2e"], dir).names, [
    "orchestrator-2.e2e.test.ts",
    "orchestrator.e2e.test.ts",
  ]);
  // …and naming the module brings its e2e files back alongside it.
  assert.deepEqual(selectTestFiles(["orchestrator"], dir).names, [
    "orchestrator-2.e2e.test.ts",
    "orchestrator.e2e.test.ts",
  ]);
});

test("filters substring-match the source-style name and are ORed together", () => {
  const dir = fakeDistDir("merge.test.js", "loop.test.js", "loop-2.test.js", "tui.test.js");
  // A short stem selects every file it occurs in (both loop files).
  assert.deepEqual(selectTestFiles(["loop"], dir).names, ["loop-2.test.ts", "loop.test.ts"]);
  // The full source-style name matches too — a filter copied from the error listing works.
  assert.deepEqual(selectTestFiles(["merge.test.ts"], dir).names, ["merge.test.ts"]);
  // Multiple filters are ORed; order follows the sorted file list, not the filter order.
  assert.deepEqual(selectTestFiles(["tui", "merge"], dir).names, ["merge.test.ts", "tui.test.ts"]);
});

test("matching is a plain substring: case-sensitive, no regex metacharacters", () => {
  const dir = fakeDistDir("Merge.test.js");
  // "merge" does not match "Merge.test.ts" — matching is case-sensitive.
  const sel = selectTestFiles(["merge"], dir);
  assert.match(sel.error ?? "", /no test file matches/);
  // A regex metacharacter in the filter is literal, not a pattern.
  const dotSel = selectTestFiles(["loop-2"], fakeDistDir("loop-2.test.js"));
  assert.deepEqual(dotSel.names, ["loop-2.test.ts"]);
});

test("no match reports every available name so one edit fixes it", () => {
  const dir = fakeDistDir("merge.test.js", "tui.test.js");
  const sel = selectTestFiles(["nosuch"], dir);
  assert.match(sel.error ?? "", /no test file matches "nosuch" — available: merge\.test\.ts, tui\.test\.ts/);
});

test("a missing or empty dist/test dir is an actionable build error", () => {
  const missing = selectTestFiles([], path.join(tmpdir(), "does-not-exist"));
  assert.match(missing.error ?? "", /run `npm run build` first/);
  const empty = selectTestFiles([], tmpdir());
  assert.match(empty.error ?? "", /no \*\.test\.js files/);
});

test("files run longest-first by recorded duration; unrecorded files lead, ties keep name order", () => {
  const files = ["/d/a.test.js", "/d/b.test.js", "/d/c.test.js", "/d/new.test.js", "/d/z.test.js"];
  // Keyed by compiled basename, as the durations reporter records them; `new` has no entry.
  const durations = { "a.test.js": 100, "b.test.js": 900, "c.test.js": 100, "z.test.js": 5_000 };
  assert.deepEqual(orderByDuration(files, durations), [
    "/d/new.test.js", // unknown cost runs first — early is the safe guess
    "/d/z.test.js",
    "/d/b.test.js",
    "/d/a.test.js", // a tie with c keeps the given (name) order
    "/d/c.test.js",
  ]);
  // No record at all (a fresh build) is exactly the name order.
  assert.deepEqual(orderByDuration(files, {}), files);
  // A torn or foreign entry is no record, not a sort key.
  const torn = { "a.test.js": "slow" as unknown as number, "b.test.js": 1 };
  assert.deepEqual(orderByDuration(["/d/a.test.js", "/d/b.test.js"], torn), ["/d/a.test.js", "/d/b.test.js"]);
});

test("suiteGitEnv appends maintenance.auto=false after any env-injected git config it inherits", () => {
  const fresh = suiteGitEnv({ PATH: "/bin" });
  assert.equal(fresh.GIT_CONFIG_COUNT, "1");
  assert.equal(fresh.GIT_CONFIG_KEY_0, "maintenance.auto");
  assert.equal(fresh.GIT_CONFIG_VALUE_0, "false");
  assert.equal(fresh.PATH, "/bin", "everything else passes through");

  // A caller's own injected entries keep their slots; the suite's goes after them.
  const inherited = suiteGitEnv({
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "a.b",
    GIT_CONFIG_VALUE_0: "1",
    GIT_CONFIG_KEY_1: "c.d",
    GIT_CONFIG_VALUE_1: "2",
  });
  assert.equal(inherited.GIT_CONFIG_COUNT, "3");
  assert.equal(inherited.GIT_CONFIG_KEY_1, "c.d");
  assert.equal(inherited.GIT_CONFIG_KEY_2, "maintenance.auto");

  // An unparsable count is treated as none rather than propagated.
  assert.equal(suiteGitEnv({ GIT_CONFIG_COUNT: "junk" }).GIT_CONFIG_COUNT, "1");
});

test("suiteEnv drops the harness's own variables, so an operator's TUMWATER_PI_BIN cannot displace the suite's fake pis", () => {
  // BUGS.md 2026-09-28: resolveAgentBin prefers TUMWATER_PI_BIN to PATH, and a fleet's build
  // checks and pi tool calls inherit the operator's export, so every fake-pi test spawned the
  // binary it named instead of the shim the test had put on PATH.
  const base: NodeJS.ProcessEnv = {
    PATH: "/no/such/dir", // no git on it, so the macOS shim workaround leaves PATH alone
    TUMWATER_PI_BIN: "/opt/pi-wrapper/pi",
    [SUPERVISED_ENV]: "1",
    NODE_OPTIONS: "--max-old-space-size=4096",
    HOME: "/home/operator",
  };
  const scratch = tmpdir("suite-env-");
  const env = suiteEnv(scratch, base);
  assert.equal("TUMWATER_PI_BIN" in env, false, "resolveAgentBin must fall through to the fakes on PATH");
  assert.equal(SUPERVISED_ENV in env, false, "a CLI child's `run` must take its supervisor half");

  // Everything else rides through, NODE_OPTIONS included (it carries the harness's LaunchServices
  // preload and the operator's own flags), alongside what the suite adds for git.
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=4096");
  assert.equal(env.HOME, "/home/operator");
  assert.equal(env.PATH, "/no/such/dir");
  assert.equal(env.GIT_TEMPLATE_DIR, path.join(scratch, "git-templates"));
  assert.equal(env.GIT_CONFIG_KEY_0, "maintenance.auto");
  // main() hands in process.env itself, so the result is a copy.
  assert.equal(base.TUMWATER_PI_BIN, "/opt/pi-wrapper/pi");
  assert.equal(base[SUPERVISED_ENV], "1");
});

/** The compiled entry point, as a developer's `npm test <filter>` spawns it. */
const runnerPath = fileURLToPath(new URL("../src/test-runner.js", import.meta.url));

/** The runner's env with the outer node --test's child marker removed: inheriting it would
 * make the nested node --test run think it is a test child and write nothing to stdout. */
function runnerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// main() itself — the spawn, the filter announcement, the durations ledger, the exit code —
// only runs when dist/src/test-runner.js is the program, so these exercise it as a subprocess.
// json-object is the suite's cheapest file (fractions of a second), keeping the nested run
// well inside a tick's budget.

test("the spawned runner runs exactly the filtered file and exits with its result", () => {
  const r = spawnSync(process.execPath, [runnerPath, "json-object"], {
    encoding: "utf8",
    env: runnerEnv(),
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // The one-line announcement only appears on the filtered path (the unfiltered suite's
  // output stays byte-identical for the harness's build gate).
  assert.match(r.stdout ?? "", /^running 1 test file\(s\): json-object\.test\.ts$/m);
  // The nested node --test run really executed the file, and its summary came through.
  assert.match(r.stdout ?? "", /^ℹ\s+fail 0$/m);
  assert.match(r.stdout ?? "", /^ℹ\s+pass \d+$/m);
  // The run folded the file's fresh duration into the ledger beside the compiled tests,
  // so later runs of the same build order this file by its real cost.
  const durations = JSON.parse(
    fs.readFileSync(path.join(path.dirname(runnerPath), "../test/.durations.json"), "utf8"),
  );
  assert.ok(
    typeof durations["json-object.test.js"] === "number" && durations["json-object.test.js"] >= 0,
    `expected a json-object.test.js duration, got ${JSON.stringify(durations)}`,
  );
});

test("the spawned runner exits 1 and lists candidates when a filter matches nothing", () => {
  const r = spawnSync(process.execPath, [runnerPath, "nosuchfilter"], {
    encoding: "utf8",
    env: runnerEnv(),
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr ?? "", /^tumwater: no test file matches "nosuchfilter" — available:/m);
});
