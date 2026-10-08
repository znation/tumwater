import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { tmpdir, writeBacklogFile } from "./fixtures/repo-fixtures.js";
import { strict as assert } from "node:assert";

test("a test process that used tmpdir() leaves no temp dir behind at exit", () => {
  const fixturesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "repo-fixtures.js");
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { tmpdir, makeRepo } from ${JSON.stringify(pathToFileURL(fixturesPath).href)};
    const dir = tmpdir();
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "leftover.txt"), "x");
    console.log(JSON.stringify({ dir, repo }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(child.error, undefined, `child failed to run: ${child.error}`);
  assert.equal(child.status, 0, `child exited ${child.status}: ${child.stderr}`);

  const { dir, repo } = JSON.parse(child.stdout.trim()) as { dir: string; repo: string };
  // Both dirs are unique, nested under one per-run root directly under the OS temp dir.
  assert.notEqual(dir, repo);
  const runRoot = path.dirname(dir);
  assert.equal(path.dirname(repo), runRoot, "tmpdir() and makeRepo() share one per-run root");
  assert.ok(
    runRoot.startsWith(path.join(os.tmpdir(), "tumwater-test-run-")),
    `run root ${runRoot} sits under the OS temp dir`,
  );
  // The exit teardown removed the whole run root — before the fix neither dir was ever removed.
  assert.equal(fs.existsSync(dir), false, `tmpdir() result survived process exit: ${dir}`);
  assert.equal(fs.existsSync(repo), false, `makeRepo() result survived process exit: ${repo}`);
  assert.equal(fs.existsSync(runRoot), false, `per-run root survived process exit: ${runRoot}`);
});

test("every test file creates temp dirs through tmpdir(), never a raw mkdtempSync under os.tmpdir()", () => {
  // The suite runs compiled from dist/test, so the source test files sit two levels up; run from
  // test/ itself they sit beside this module. Scanning dist/test for .test.ts found none, which
  // made the guard vacuous.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const testDir = fs.existsSync(path.join(here, "repo-fixtures.test.ts")) ? here : path.resolve(here, "..", "..", "test");
  // Built by joining so this guard's own source does not contain the pattern it forbids.
  const needle = ["mkdtempSync(path.join(", "os.tmpdir()"].join("");
  const offenders: string[] = [];
  for (const name of fs.readdirSync(testDir)) {
    if (!name.endsWith(".test.ts")) continue;
    const text = fs.readFileSync(path.join(testDir, name), "utf8");
    if (text.includes(needle)) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    `temp dirs created outside the per-run root leak into the system temp dir; use tmpdir() from fixtures/repo-fixtures.ts in: ${offenders.join(", ")}`);
});

test("writeBacklogFile renders the canonical backlog skeleton per file", () => {
  const root = tmpdir();
  writeBacklogFile(root, "PLANS.md", [
    { heading: "## Planned", body: "### A plan\n\nBody line." },
    { heading: "## Done" },
  ]);
  // Title, blank, heading, blank, body, blank, next heading — the exact bytes the hand-rolled
  // fixtures pinned before the helper existed.
  assert.equal(
    fs.readFileSync(path.join(root, "PLANS.md"), "utf8"),
    "# Plans\n\n## Planned\n\n### A plan\n\nBody line.\n\n## Done\n\n_None yet._\n",
  );
  // A section with no body renders the canonical placeholder; each file gets its own title.
  writeBacklogFile(root, "BUGS.md", [{ heading: "## Open" }]);
  assert.equal(
    fs.readFileSync(path.join(root, "BUGS.md"), "utf8"),
    "# Bugs\n\n## Open\n\n_None yet._\n",
  );
  // A body's edge blanks are trimmed away — the parsers trim them right back, and the
  // skeleton's own blank lines are the helper's job, not the body's.
  writeBacklogFile(root, "QUESTIONS.md", [{ heading: "## Answered", body: "\n### Q1\n\n" }]);
  assert.equal(
    fs.readFileSync(path.join(root, "QUESTIONS.md"), "utf8"),
    "# Questions\n\n## Answered\n\n### Q1\n",
  );
});
