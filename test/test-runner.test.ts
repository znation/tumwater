import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { realGitFromXcrun } from "../src/git/xcrun-git.js";
import { SUPERVISED_ENV } from "../src/process/supervisor.js";
import { DASHBOARD_CHILD_ENV } from "../src/redeploy/self-reload.js";
import { readJson } from "./helpers/json-read.js";
import { coverageRowsFromDumps, formatCoverageTable } from "./coverage-table.js";
import {
  buildNodeTestArgs,
  nodeSupportsTestCoverageExclude,
  noNameMatchReason,
  orderByDuration,
  parseFilter,
  selectTestFiles,
  splitCoverageArgv,
  suiteEnv,
  suiteGitEnv,
  SUITE_TIMEOUT_MS,
  timedOutFailure,
} from "./test-runner.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { exitWithOwnerEnv } from "./fixtures/victim-fixture.js";
import { withWedgedXcrun, xcrunProbeUnsupported } from "./helpers/wedged-xcrun.js";

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

test("a #name part filters the tests inside the selected files, as one escaped-literal pattern", () => {
  const dir = fakeDistDir("loop.test.js", "tui.test.js", "loop.e2e.test.js");
  // The file part selects like a bare filter (e2e included — naming a file is deliberate).
  const sel = selectTestFiles(["loop#hangs"], dir);
  assert.equal(sel.error, undefined);
  assert.deepEqual(sel.names, ["loop.e2e.test.ts", "loop.test.ts"]);
  assert.equal(sel.namePattern, "hangs");
  assert.deepEqual(sel.nameFilters, ["hangs"], "the raw typed name is kept for the announcement");
  // The name parts OR together and are regex-escaped, so node --test's matcher sees the
  // literal substring typed — the same no-regex rule the file part follows.
  const two = selectTestFiles(["loop#one", "tui#x.y"], dir);
  assert.equal(two.error, undefined);
  assert.equal(two.namePattern, "one|x\\.y");
  assert.deepEqual(two.nameFilters, ["one", "x.y"], "raw names, not the escaped alternation");
  // A bare #name filter searches the whole suite — the unfiltered gating set, e2e excluded.
  const bare = selectTestFiles(["#only"], dir);
  assert.equal(bare.error, undefined);
  assert.deepEqual(bare.names, ["loop.test.ts", "tui.test.ts"]);
  assert.equal(bare.namePattern, "only");
  // A filter with no name part still selects without a pattern, as before.
  assert.equal(selectTestFiles(["tui"], dir).namePattern, undefined);
  // A bare `#` would mean "run nothing" — rejected with the syntax shown.
  const empty = selectTestFiles(["loop#"], dir);
  assert.match(empty.error ?? "", /a "#" must be followed by the test name to run/);
  // parseFilter splits at the first # only; a test name may itself carry one.
  assert.deepEqual(parseFilter("a#b#c"), { file: "a", name: "b#c" });
  assert.deepEqual(parseFilter("plain"), { file: "plain", name: null });
});

test("noNameMatchReason reads the run's TAP side-channel: all-file ok lines mean the #name filter matched nothing", () => {
  const tap = (content: string): string => {
    const dir = tmpdir("tap-guard-");
    const file = path.join(dir, "tap.out");
    fs.writeFileSync(file, content);
    return file;
  };
  // node --test names a file whose tests all miss the pattern by the file itself; matched
  // tests and their parent describes carry their own names.
  assert.match(noNameMatchReason(tap("ok 1 - loop.test.js\nok 2 - tui.test.js\n")) ?? "", /no test name matches/);
  // The typed name parts are echoed so a multi-name run need not reread its command line.
  assert.match(
    noNameMatchReason(tap("ok 1 - loop.test.js\n"), ["resume", "wake"]) ?? "",
    /no test name matches "resume" or "wake"/,
  );
  assert.equal(noNameMatchReason(tap("ok 1 - resume hangs\nok 2 - loop.test.js\n")), null);
  assert.equal(noNameMatchReason(tap("ok 1 - resume # SKIP later\nok 2 - tui.test.js\n")), null, "a directive suffix is not the name");
  assert.equal(noNameMatchReason(tap("not ok 1 - a failed test\nok 2 - loop.test.js\n")), null, "a failed match still matched");
  // No TAP (a crashed run) is not evidence: the exit code already reports that.
  assert.equal(noNameMatchReason(path.join(tmpdir(), "absent-tap.out")), null);
  assert.equal(noNameMatchReason(tap("")), null);
});

test("no match reports every available name so one edit fixes it", () => {
  const dir = fakeDistDir("merge.test.js", "tui.test.js");
  const sel = selectTestFiles(["nosuch"], dir);
  assert.match(sel.error ?? "", /no test file matches "nosuch" — available: merge\.test\.ts, tui\.test\.ts/);
});

test("a near-miss filter names the file it probably meant", () => {
  const dir = fakeDistDir("loop.test.js", "tui.test.js");
  // A one-letter slip of the stem (`lopp` for `loop`) gets the shared did-you-mean an
  // unknown value elsewhere in the harness prints, while the listing still follows it.
  const stem = selectTestFiles(["lopp"], dir);
  assert.match(stem.error ?? "", /did you mean `loop`\?/);
  // A near-miss of the full source-style name suggests the name itself, so the hint can be
  // pasted as a filter unchanged.
  const full = selectTestFiles(["loop.test.tss"], dir);
  assert.match(full.error ?? "", /did you mean `loop\.test\.ts`\?/);
  // A filter with no near miss keeps the plain listing — no invented suggestion.
  assert.doesNotMatch(selectTestFiles(["nosuch"], dir).error ?? "", /did you mean/);
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

test("splitCoverageArgv lifts --coverage out of the filters wherever it appears", () => {
  assert.deepEqual(splitCoverageArgv([]), { filters: [], coverage: false });
  assert.deepEqual(splitCoverageArgv(["--coverage"]), { filters: [], coverage: true });
  // Either position, and composed with filters and #name parts alike.
  assert.deepEqual(splitCoverageArgv(["--coverage", "loop"]), { filters: ["loop"], coverage: true });
  assert.deepEqual(splitCoverageArgv(["loop", "--coverage", "tui"]), { filters: ["loop", "tui"], coverage: true });
  assert.deepEqual(splitCoverageArgv(["--coverage", "loop#resume"]), { filters: ["loop#resume"], coverage: true });
  assert.deepEqual(splitCoverageArgv(["loop"]), { filters: ["loop"], coverage: false });
});

test("nodeSupportsTestCoverageExclude follows node 22.5, where the flag arrived", () => {
  // The engines floor is >=20.3, so the predicate must hold for every node the package supports,
  // not just current ones.
  assert.equal(nodeSupportsTestCoverageExclude("20.3.0"), false);
  assert.equal(nodeSupportsTestCoverageExclude("22.4.9"), false);
  assert.equal(nodeSupportsTestCoverageExclude("22.5.0"), true);
  assert.equal(nodeSupportsTestCoverageExclude("22.12.0"), true);
  assert.equal(nodeSupportsTestCoverageExclude("24.7.0"), true);
  // An unparsable version is not evidence of the flag.
  assert.equal(nodeSupportsTestCoverageExclude(""), false);
});

test("buildNodeTestArgs adds the coverage flags only under coverage, and keeps the #name reporters", () => {
  const sel = { files: ["/d/a.test.js"], namePattern: "resume" };
  const base = { reporter: "rep.js", fresh: "/s/fresh.json", tap: "/s/tap.out" };
  const plain = buildNodeTestArgs(sel, base);
  assert.ok(plain.includes("--test"));
  assert.ok(plain.includes("--test-reporter=rep.js"));
  assert.ok(plain.includes("--test-name-pattern=resume"));
  assert.ok(plain.includes("--test-reporter=tap"));
  assert.ok(plain.every((a) => !a.startsWith("--experimental-test-coverage") && !a.startsWith("--test-coverage-exclude")));

  const cov = buildNodeTestArgs(sel, { ...base, coverage: true });
  assert.ok(cov.includes("--experimental-test-coverage"));
  // The exclude flag only when this node knows it (v22.5+); the #name reporters survive either way.
  assert.equal(
    cov.includes("--test-coverage-exclude=**/test/**"),
    nodeSupportsTestCoverageExclude(process.versions.node),
  );
  assert.ok(cov.includes("--test-name-pattern=resume"));
  assert.ok(cov.includes("--test-reporter=tap"));
  // The files come last, in the order the caller ordered them.
  assert.deepEqual(cov.slice(-1), ["/d/a.test.js"]);

  // Without a name pattern there is no TAP reporter, coverage or not.
  const noPattern = buildNodeTestArgs({ files: ["/d/a.test.js"] }, { ...base, coverage: true });
  assert.ok(noPattern.every((a) => !a.startsWith("--test-reporter=tap")));
  assert.ok(noPattern.includes("--experimental-test-coverage"));
});

test("timedOutFailure reads a real spawnSync timeout kill as the ceiling message and every other outcome as null", () => {
  assert.ok(SUITE_TIMEOUT_MS >= 20 * 60_000, "the ceiling must stay far above any healthy full-suite run");
  // A genuinely hung child, killed by spawnSync's own timeout — the exact shape main() gets back.
  const hung = spawnSync(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { timeout: 100, env: exitWithOwnerEnv() });
  const message = timedOutFailure(hung);
  assert.match(message ?? "", /exceeded its 30-minute ceiling and was killed/);
  assert.match(message ?? "", /bisect with npm test '<file filter>'/);
  // A clean exit and a failing exit are node --test's own outcomes, not timeouts.
  assert.equal(timedOutFailure(spawnSync(process.execPath, ["-e", "process.exit(0)"])), null);
  assert.equal(timedOutFailure(spawnSync(process.execPath, ["-e", "process.exit(3)"])), null);
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

test("suiteEnv drops every variable the harness resolves, so a fleet-started suite matches a hand-run one", () => {
  // BUGS.md 2026-09-28: resolveAgentBin prefers TUMWATER_PI_BIN to PATH, and a fleet's build
  // checks and pi tool calls inherit the operator's export, so every fake-pi test spawned the
  // binary it named instead of the shim the test had put on PATH. The same leak applies to the
  // other harness-resolved variables, so suiteEnv clears them too.
  const base: NodeJS.ProcessEnv = {
    PATH: "/no/such/dir", // no git on it, so the macOS shim workaround leaves PATH alone
    TUMWATER_PI_BIN: "/opt/pi-wrapper/pi",
    [SUPERVISED_ENV]: "1",
    TUMWATER_NOTES_PATH: "/state/notes/feature.md",
    TUMWATER_RUN: "4242-abcdef",
    [DASHBOARD_CHILD_ENV]: "4242",
    NODE_OPTIONS: "--max-old-space-size=4096",
    HOME: "/home/operator",
  };
  const scratch = tmpdir("suite-env-");
  const env = suiteEnv(scratch, base);
  assert.equal("TUMWATER_PI_BIN" in env, false, "resolveAgentBin must fall through to the fakes on PATH");
  assert.equal(SUPERVISED_ENV in env, false, "a CLI child's `run` must take its supervisor half");
  assert.equal("TUMWATER_NOTES_PATH" in env, false, "a non-authoring run must not carry a notebook");
  assert.equal("TUMWATER_RUN" in env, false, "a spawned run must start its marker from scratch");
  assert.equal(DASHBOARD_CHILD_ENV in env, false, "a reload must take the supervisor branch");

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
  assert.equal(base.TUMWATER_NOTES_PATH, "/state/notes/feature.md");
  assert.equal(base.TUMWATER_RUN, "4242-abcdef");
  assert.equal(base[DASHBOARD_CHILD_ENV], "4242");
});

/** suiteEnv's macOS xcrun probe runs through a synchronous spawnSync, so a wedged xcrun would
 * block the whole test run with no watchdog able to fire. This pins the bound: a fake xcrun
 * that never answers is abandoned at `timeoutMs` and the probe reports no real binary, leaving
 * PATH alone. Before the fix the call waited the fake out, so the elapsed-time assertion
 * failed. */
test(
  "a wedged xcrun cannot freeze the suite environment probe: the probe is bounded",
  { skip: xcrunProbeUnsupported },
  () => {
    withWedgedXcrun("suite-xcrun-", () => {
      const started = Date.now();
      const real = realGitFromXcrun(300);
      const elapsed = Date.now() - started;
      assert.equal(real, null, "an unanswered probe leaves PATH alone");
      assert.ok(elapsed < 1_500, `probe took ${elapsed}ms; it was not bounded`);
    });
  },
);

/** The compiled entry point, as a developer's `npm test <filter>` spawns it. */
const runnerPath = fileURLToPath(new URL("./test-runner.js", import.meta.url));

/** The runner's env with the outer node --test's child marker removed: inheriting it would
 * make the nested node --test run think it is a test child and write nothing to stdout. */
function runnerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** Spawn dist/test/test-runner.js as a subprocess with the options every runner test needs
 * (string stdout/stderr, runnerEnv's NODE_TEST_CONTEXT strip) — the one home for the spawn
 * boilerplate, so a test states only the filter it exercises. */
function runRunner(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [runnerPath, ...args], { encoding: "utf8", env: runnerEnv() });
}

// main() itself — the spawn, the filter announcement, the durations ledger, the exit code —
// only runs when dist/test/test-runner.js is the program, so these exercise it as a subprocess.
// json-object is the suite's cheapest file (fractions of a second), keeping the nested run
// well inside a tick's budget.

test("the spawned runner runs exactly the filtered file and exits with its result", () => {
  const r = runRunner(["json-object"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // The one-line announcement only appears on the filtered path (the unfiltered suite's
  // output stays byte-identical for the harness's build gate).
  assert.match(r.stdout ?? "", /^running 1 test file\(s\): json-object\.test\.ts$/m);
  // The nested node --test run really executed the file, and its summary came through.
  assert.match(r.stdout ?? "", /^ℹ\s+fail 0$/m);
  assert.match(r.stdout ?? "", /^ℹ\s+pass \d+$/m);
  // The run folded the file's fresh duration into the ledger beside the compiled tests,
  // so later runs of the same build order this file by its real cost.
  const durations = readJson<Record<string, number>>(
    path.join(path.dirname(runnerPath), "../test/.durations.json"),
  );
  assert.ok(
    typeof durations["json-object.test.js"] === "number" && durations["json-object.test.js"] >= 0,
    `expected a json-object.test.js duration, got ${JSON.stringify(durations)}`,
  );
});

test("the spawned runner runs only the tests a #name filter matches, and fails a pattern that matches nothing", () => {
  // json-object.test.ts's first test, matched by a substring of its name.
  const hit = runRunner(["json-object#plain object"]);
  assert.equal(hit.status, 0, `stderr: ${hit.stderr}`);
  assert.match(hit.stdout ?? '', /^running 1 test file\(s\) \(tests matching plain object\): json-object\.test\.ts$/m);
  assert.match(hit.stdout ?? '', /^✔ a plain object is a JSON object/m);

  // A pattern that matches nothing exits 0 at node --test's level — node sees a green run of
  // file wrappers — so the runner's own guard must fail it, or a typo'd filter would read as
  // a green suite that verified nothing.
  const miss = runRunner(["json-object#nosuchname"]);
  assert.equal(miss.status, 1);
  assert.match(miss.stderr ?? "", /^tumwater: no test name matches "nosuchname"/m);
  // The pattern and the syntax error surface like the file filters' do.
  const bare = runRunner(["json-object#"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr ?? "", /must be followed by the test name to run/);
});

test("the spawned runner under --coverage ends with node's coverage table and leaves the durations ledger alone", () => {
  const durationsPath = path.join(path.dirname(runnerPath), ".durations.json");
  const before = fs.readFileSync(durationsPath, "utf8");
  const r = runRunner(["--coverage", "json-object"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // The filter composed: exactly the one file ran, and node's table followed the spec output.
  assert.match(r.stdout ?? "", /^running 1 test file\(s\): json-object\.test\.ts$/m);
  // The table rides the spec reporter (ℹ-prefixed) and keeps to source: the `**/test/**`
  // exclude (node >= 22.5) keeps the test files out of it.
  assert.match(r.stdout ?? "", /^ℹ file +\| line %/m);
  assert.match(r.stdout ?? "", /^ℹ all files/m);
  assert.doesNotMatch(r.stdout ?? "", /^ℹ test\//m);
  // Coverage skips the ledger: instrumentation slows every file, and recording the skewed
  // times would skew later runs' ordering.
  assert.equal(fs.readFileSync(durationsPath, "utf8"), before);
});

test("coverageRowsFromDumps merges the raw V8 dumps with any-process semantics and names never-loaded files", () => {
  // A synthetic dist tree and two synthetic dumps. Dump A ran everything but the `ran = used()`
  // statement's block and the `if` block; dump B ran exactly those two blocks. Node's own
  // merge flips depending on which of these reports it combines (BUGS.md 2026-09-30); the
  // any-process merge must count both blocks covered, from either dump alone. The first line
  // keeps `used`'s range off offset 0, where it would be indistinguishable from the module root.
  const lines = ["let ran = 0;", "function used() { return 1; }", "function unused() { return 2; }", "ran = used();", "if (ran) { used(); }"];
  const src = lines.join("\n") + "\n";
  const lineStart = (i: number): number => lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
  const usedStart = lineStart(1), usedEnd = usedStart + lines[1]!.length;
  const unusedStart = lineStart(2), unusedEnd = unusedStart + lines[2]!.length;
  const stmtStart = lineStart(3), stmtEnd = stmtStart + lines[3]!.length;
  const ifStart = src.indexOf("{ used(); }"), ifEnd = ifStart + "{ used(); }".length;
  const dist = tmpdir("cov-table-");
  fs.mkdirSync(path.join(dist, "src"), { recursive: true });
  fs.writeFileSync(path.join(dist, "src", "tiny.js"), src);
  fs.writeFileSync(path.join(dist, "src", "ghost.js"), "never loaded();\nalso never();\n");
  const url = "file://" + fs.realpathSync(path.join(dist, "src", "tiny.js"));
  const dump = (blockCounts: [number, number]): string =>
    JSON.stringify({
      result: [
        {
          url,
          functions: [
            { functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }] },
            { functionName: "used", isBlockCoverage: true, ranges: [{ startOffset: usedStart, endOffset: usedEnd, count: 2 }] },
            { functionName: "unused", isBlockCoverage: true, ranges: [{ startOffset: unusedStart, endOffset: unusedEnd, count: 0 }] },
            { functionName: "stmt", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }, { startOffset: stmtStart, endOffset: stmtEnd, count: blockCounts[0]! }] },
            { functionName: "if", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }, { startOffset: ifStart, endOffset: ifEnd, count: blockCounts[1]! }] },
          ],
        },
      ],
    });
  const dumpDir = tmpdir("cov-dumps-");
  fs.writeFileSync(path.join(dumpDir, "coverage-a.json"), dump([0, 0]));
  fs.writeFileSync(path.join(dumpDir, "coverage-b.json"), dump([1, 1]));

  const rows = coverageRowsFromDumps(dumpDir, dist);
  assert.deepEqual(rows.map((r) => r.file), ["src/ghost.js", "src/tiny.js"]);
  const ghost = rows[0]!, tiny = rows[1]!;
  // Lines: the first two, the if line (module range), and — only because dump B ran it — the
  // `ran = used()` line; `unused`'s body never ran in any process. Branches: the five block
  // ranges, all covered but `unused`'s. Functions: `used` and `unused`, the module roots
  // (offset 0) excluded.
  assert.deepEqual(tiny.lines, { covered: 4, total: 5 });
  assert.deepEqual(tiny.branches, { covered: 4, total: 5 });
  assert.deepEqual(tiny.functions, { covered: 1, total: 2 });
  // A module no process loaded stays in the table at zero — an untested module must not vanish.
  assert.deepEqual(ghost.lines, { covered: 0, total: 2 });
  assert.deepEqual(ghost.branches, { covered: 0, total: 0 });

  const text = formatCoverageTable(rows);
  assert.match(text, /^deterministic coverage \(any-process merge/m);
  // Most uncovered lines first, so "the file with the most uncovered lines" is the first row.
  assert.ok(text.indexOf("src/ghost.js") < text.indexOf("src/tiny.js"));
  assert.match(text, /all files +lines 4\/7 57\.14%/);
});

test("coverageRowsFromDumps keeps blank lines from scrambling which lines a process's merge credits", () => {
  // The line queries are filtered down to non-blank lines, and makeLookup returns its results
  // indexed by each query's recorded line index — not by position in that filtered list. A
  // positional reading made every code line after a blank line inherit another line's verdict
  // and dropped the lines numbered past the query count (BUGS.md 2026-09-30): this file, which
  // one process ran end to end (the module root range spans it all with count 1), read 3/4.
  const lines = ["// header comment", "let a = 1;", "", "let b = 2;", "", "let c = 3;"];
  const src = lines.join("\n") + "\n";
  const dist = tmpdir("cov-blank-");
  fs.mkdirSync(path.join(dist, "src"), { recursive: true });
  fs.writeFileSync(path.join(dist, "src", "blanks.js"), src);
  const url = "file://" + fs.realpathSync(path.join(dist, "src", "blanks.js"));
  const dumpDir = tmpdir("cov-blank-dumps-");
  fs.writeFileSync(
    path.join(dumpDir, "coverage.json"),
    JSON.stringify({
      result: [
        {
          url,
          functions: [
            { functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }] },
          ],
        },
      ],
    }),
  );

  const rows = coverageRowsFromDumps(dumpDir, dist);
  // Every non-blank line is covered — the blank separators must not cost a line or move one's
  // verdict onto a neighbor. (Comment lines count as lines under this table's trim-extent
  // semantics, matching coverage.cjs; only blank lines drop out of the query list.)
  assert.deepEqual(rows, [{ file: "src/blanks.js", lines: { covered: 4, total: 4 }, branches: { covered: 1, total: 1 }, functions: { covered: 0, total: 0 } }]);
});

test("coverageRowsFromDumps distrusts node:test's phantom zero-count function roots", () => {
  // node:test's V8 dumps record some functions their own tests demonstrably ran as phantom fn
  // roots — isBlockCoverage: false, count: 0 — while sibling roots in the same dump carry real
  // counts (BUGS.md 2026-10-01, src/redeploy/self-reload.js). Taking that zero at face value left
  // lines and functions the tests executed marked uncovered, byte-identically across runs.
  // When the module ran in the dump's process (some fn root has count > 0), such a root must
  // not shadow its enclosing range's real count.
  const lines = ["let r = 0;", "function phantom() { return 1; }", "function real() { return 2; }", "r = real();"];
  const src = lines.join("\n") + "\n";
  const lineStart = (i: number): number => lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
  const phantomStart = lineStart(1), phantomEnd = phantomStart + lines[1]!.length;
  const realStart = lineStart(2), realEnd = realStart + lines[2]!.length;
  const dist = tmpdir("cov-phantom-");
  fs.mkdirSync(path.join(dist, "src"), { recursive: true });
  fs.writeFileSync(path.join(dist, "src", "phantom.js"), src);
  const url = "file://" + fs.realpathSync(path.join(dist, "src", "phantom.js"));
  const dumpDir = tmpdir("cov-phantom-dumps-");
  fs.writeFileSync(
    path.join(dumpDir, "coverage.json"),
    JSON.stringify({
      result: [
        {
          url,
          functions: [
            { functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }] },
            { functionName: "phantom", isBlockCoverage: false, ranges: [{ startOffset: phantomStart, endOffset: phantomEnd, count: 0 }] },
            { functionName: "real", isBlockCoverage: true, ranges: [{ startOffset: realStart, endOffset: realEnd, count: 2 }] },
          ],
        },
      ],
    }),
  );

  const rows = coverageRowsFromDumps(dumpDir, dist);
  // The phantom root's zero must not shadow the module root's count 1: every line covered, and
  // both named functions covered (the offset-0 module root stays excluded from the fn count).
  assert.deepEqual(rows, [
    { file: "src/phantom.js", lines: { covered: 4, total: 4 }, branches: { covered: 2, total: 2 }, functions: { covered: 2, total: 2 } },
  ]);
});

test("under --coverage the runner prints the deterministic table, and a caller's NODE_V8_COVERAGE passes through untouched", () => {
  // A caller's NODE_V8_COVERAGE reaches node untouched — the dumps land in the caller's dir and
  // the runner prints no table of its own: docs/code-metrics/run.sh sets the variable around
  // `npm run test:coverage` and maps those same dumps with coverage.cjs after the run, so the
  // runner must neither redirect nor consume them. Node re-propagates the variable into child
  // envs that lack it, so an explicitly set value is the one way a caller's choice sticks —
  // and this assertion holds under an outer `test:coverage` run too, where every nested runner
  // pass-through is exactly what keeps the whole tree's dumps in the outer run's dir.
  const dir = tmpdir("cov-callers-");
  const r2 = spawnSync(process.execPath, [runnerPath, "--coverage", "json-object"], {
    encoding: "utf8",
    env: { ...runnerEnv(), NODE_V8_COVERAGE: dir },
  });
  assert.equal(r2.status, 0, `stderr: ${r2.stderr}`);
  assert.doesNotMatch(r2.stdout ?? "", /deterministic coverage/);
  assert.ok(
    fs.readdirSync(dir).some((f) => f.endsWith(".json")),
    "expected raw V8 dumps in the caller's NODE_V8_COVERAGE dir",
  );
  fs.rmSync(dir, { recursive: true, force: true });

  // Owned dumps: the deterministic table follows node's own. Only exercisable when no ancestor
  // brought the variable — node re-propagates NODE_V8_COVERAGE into child envs that lack it, so
  // under an outer `test:coverage` run every nested runner passes through (asserted above), and
  // the owned path is the outer run's own.
  if (process.env.NODE_V8_COVERAGE === undefined) {
    const r = runRunner(["--coverage", "json-object"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout ?? "", /^deterministic coverage \(any-process merge/m);
    assert.match(r.stdout ?? "", /^ +\d+ +all files +lines \d+\/\d+/m);
  }
});

test("the spawned runner exits 1 and lists candidates when a filter matches nothing", () => {
  const r = runRunner(["nosuchfilter"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr ?? "", /^tumwater: no test file matches "nosuchfilter" — available:/m);
});
