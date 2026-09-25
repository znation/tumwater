import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { orderByDuration, selectTestFiles, suiteGitEnv } from "../src/test-runner.js";
import { tmpdir } from "./util.js";

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
