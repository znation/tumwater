import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseFailingTests } from "../src/build/build-check-report.js";
import { parsePolicyOffenders } from "../src/build/policy-offenders.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { repoRoot } from "./helpers/repo-root.js";

// A repo-wide policy scan (BUGS.md 2026-11-05) must name its offender as a failing test, not
// only its aggregate test. When main is red on a scan, a change that adds ITS OWN offender makes
// the same aggregate test fail, so `onlyKnownMainFailures` compared test names and excused the
// change as main's known failure. The scan's offender becomes a distinct failing test so the
// comparison can tell main's offender from the change's. This regression runs the real compiled
// comment-width scan against a scratch tree that holds one over-wide comment and asserts the
// failing output names that offender's file:line (which the aggregate test alone never did).

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
// The worktree root that holds dist/, found the same way whether this file runs from the compiled
// suite (dist/test) or the source suite (test).
const REPO_ROOT = repoRoot(TEST_DIR);

test("a policy scan names its offender as a failing test, not only its aggregate", () => {
  const temp = tmpdir("scan-offender-");
  const srcDir = path.join(temp, "src");
  const buildDir = path.join(srcDir, "build");
  const testDir = path.join(temp, "test");
  const helpers = path.join(testDir, "helpers");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(helpers, { recursive: true });
  fs.writeFileSync(path.join(temp, "package.json"), "{}");
  // A `//` comment line well past the 100-column policy, on the offending file's line 1.
  fs.writeFileSync(path.join(srcDir, "a.ts"), "// " + "y".repeat(200) + "\nconst ok = 1;\n");
  fs.copyFileSync(path.join(REPO_ROOT, "dist", "test", "comment-width.test.js"), path.join(testDir, "comment-width.test.js"));
  fs.copyFileSync(path.join(REPO_ROOT, "dist", "test", "helpers", "repo-root.js"), path.join(helpers, "repo-root.js"));
  // The scan imports the machine-readable offender helper from src/build/policy-offenders.js; the
  // scratch tree must carry it too, or the copied scan fails to load (BUGS.md 2026-11-08).
  fs.copyFileSync(path.join(REPO_ROOT, "dist", "src", "build", "policy-offenders.js"), path.join(buildDir, "policy-offenders.js"));
  try {
    // The gate runs this file inside `node --test`, which marks child processes with
    // NODE_TEST_CONTEXT=child-v8; a nested `node --test` that inherits it is treated as a
    // recursive run and skips the scan, so clear it for the child or it reports no failures.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ["--test", path.join(testDir, "comment-width.test.js")], {
      encoding: "utf8",
      timeout: 30_000,
      env,
    });
    const names = parseFailingTests(`${run.stdout ?? ""}\n${run.stderr ?? ""}`);
    // The scan must name the offending file:line as a failing test, so a new offender on a red
    // main is distinguishable from main's own offenders instead of hiding behind the aggregate.
    // The name is repo-relative, not an absolute worktree path: a change's gate compares these
    // names with main's, which runs in a different worktree where an absolute path never matches.
    assert.ok(
      names.includes("violation src/a.ts:1 (cols)"),
      `expected the over-wide comment's repo-relative file:line among failing tests; got: ${JSON.stringify(names)}`,
    );
    // And it must emit the machine-readable offender line, so runBuildCheck's failingOffenders
    // carries this offender (policy-offenders.ts): the map keyed by this scan's exact title.
    const offenders = parsePolicyOffenders(`${run.stdout ?? ""}\n${run.stderr ?? ""}`)[
      "every comment line in src/ and test/ fits in 100 columns and opens no block inside a block"
    ];
    assert.ok(
      offenders?.some((o) => o.endsWith("src/a.ts:1 (cols)")),
      `expected the over-wide comment's file:line on a policy-offender line; got: ${JSON.stringify(offenders)}`,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
