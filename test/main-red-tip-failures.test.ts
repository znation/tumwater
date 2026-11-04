/** mainTipFailures and rerunAtMainTip themselves (src/baseline/main-red.ts) — the named-failure
 * arm of the gate pre-check's main-tip attribution: a twice-failed gate check that names its
 * tests asks main's tip by re-running ONLY those tests in the `_gate-main` mirror (rerunAtMainTip),
 * and only when the re-run reaches no verdict does mainTipFailures fall back to main's full fresh
 * check (mainTipVerdict with forceFresh). The nameless arm (mainTipGateVerdict) is pinned in
 * review-precheck-main-tip.test.ts and mainTipVerdict's arms in main-red.test.ts; this file pins
 * the re-run seam between them, which no test reached — a swapped green/red mapping, a broken
 * filter hand-off, or a fallback that skips the fresh check would all ship uncaught. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { noteGreenBaseline } from "../src/baseline/main-baseline.js";
import { mainTipFailures } from "../src/baseline/main-red.js";
import { defaultConfig } from "../src/config/config.js";
import { readEvents } from "../src/events/event-read.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { projManifest, pathPrepend, writeScript } from "./fakes/fake-commands.js";
import { commitIn, makeRepo, mainSha, tmpdir } from "./fixtures/repo-fixtures.js";

const ROLE = "coverage"; // the role that paid for the check, like the review gate's asking role

/** The repo the seam runs in: main's tip (the root's committed manifest) declares `build` and —
 * unless `mainRerun` is null — `test:rerun`, the auto-detected named-test re-run (rerunCommandOf,
 * build-check-detect).
 *
 * A role worktree off main carries one extra commit, so the mirror re-pointing has a tip to
 * hold. */
async function fixture(
  mainBuild: string,
  mainRerun: string | null,
): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  const scripts: Record<string, string | null> = { build: mainBuild };
  if (mainRerun !== null) scripts["test:rerun"] = mainRerun;
  fs.writeFileSync(path.join(root, "package.json"), projManifest(scripts));
  commitIn(root, "declare the check");
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  commitIn(wt, "wip change");
  return { root, wt };
}

/** A fake npm whose body dispatches on the script name: `npm run build` gets `buildBody`,
 * `npm run test:rerun -- <filters>` gets `rerunBody` (the full check and the re-run are the same
 * fake in the fallback tests, where both run). */
function fakeNpmDispatch(buildBody: string, rerunBody: string | null): () => void {
  const body =
    rerunBody === null ? buildBody : `if [ "$2" = "test:rerun" ]; then ${rerunBody}; else ${buildBody}; fi`;
  const dir = tmpdir("fake-npm-");
  writeScript(path.join(dir, "npm"), body);
  return pathPrepend(dir);
}

/** The build_check (scope, status) pairs the run left behind, oldest first: the re-run logs
 * scope "rerun", the fallback full check logs scope "baseline". */
const checkScopes = (root: string): [unknown, unknown][] =>
  readEvents(root)
    .filter((e) => e.type === "build_check")
    .map((e) => [e.scope, e.status] as [unknown, unknown]);

test("a named failure that still fails at main's tip stays red with the names that fail there", async () => {
  const argsFile = path.join(tmpdir(), "rerun-args.txt");
  const restore = fakeNpmDispatch(
    "exit 0",
    `printf '%s\\n' "$@" >> '${argsFile}'; echo "✖ X (1ms)"; echo "test at t.test.js:1:1"; exit 1`,
  );
  try {
    const { root, wt } = await fixture("exit 0", null);
    // The re-run body is declared on main's tip; the fixture's build body never runs here.
    fs.writeFileSync(
      path.join(root, "package.json"),
      projManifest({
        build: "exit 0",
        "test:rerun": `printf '%s\\n' "$@" >> '${argsFile}'; echo "✖ X (1ms)"; echo "test at t.test.js:1:1"; exit 1`,
      }),
    );
    commitIn(root, "declare the re-run");
    const verdict = await mainTipFailures(root, ROLE, wt, "main", defaultConfig(), {
      tests: ["X"],
      files: { X: "t.test.js" },
    });
    assert.deepEqual(verdict, { status: "red", sha: mainSha(root), failingTests: ["X"] });
    // The re-run is the declared test:rerun with the located filter — not the whole check:
    const args = fs.readFileSync(argsFile, "utf8");
    assert.ok(args.includes("test:rerun"), args);
    assert.ok(args.includes("t.test.js#X"), args);
    // Only the re-run ran: no fallback full check, so no baseline-scope event.
    assert.deepEqual(checkScopes(root), [["rerun", "failed"]]);
  } finally {
    restore();
  }
});

test("a re-run that passes at main's tip is green, with the tip's sha", async () => {
  const restore = fakeNpmDispatch(
    "exit 0",
    `echo "✖ X (1ms)"; exit 0`, // a failure that names X but exits green still reads as passed
  );
  try {
    const { root, wt } = await fixture("exit 0", "exit 0");
    const verdict = await mainTipFailures(root, ROLE, wt, "main", defaultConfig(), {
      tests: ["X"],
      files: { X: "t.test.js" },
    });
    assert.deepEqual(verdict, { status: "green", sha: mainSha(root) });
    assert.deepEqual(checkScopes(root), [["rerun", "passed"]]);
  } finally {
    restore();
  }
});

test("a re-run that names none of the asked tests falls back to main's fresh full check", async () => {
  const restore = fakeNpmDispatch(
    'echo "✖ Z (1ms)"; exit 1', // main's full check is red but names no test
    'echo "✖ Y (1ms)"; echo "test at y.test.js:1:1"; exit 1', // the re-run fails a different test
  );
  try {
    const { root, wt } = await fixture('echo "✖ Z (1ms)"; exit 1', null);
    fs.writeFileSync(
      path.join(root, "package.json"),
      projManifest({
        build: 'echo "✖ Z (1ms)"; exit 1',
        "test:rerun": 'echo "✖ Y (1ms)"; echo "test at y.test.js:1:1"; exit 1',
      }),
    );
    commitIn(root, "declare the re-run");
    // A green cached for this very tip (normally seeded by an earlier merge) must not answer the
    // fallback: a clock- or load-sensitive test can pass early and fail later (BUGS.md
    // 2026-10-06), which is the reason mainTipFailures's fallback asks with forceFresh.
    noteGreenBaseline(mainSha(root));
    const verdict = await mainTipFailures(root, ROLE, wt, "main", defaultConfig(), {
      tests: ["X"],
      files: { X: "t.test.js" },
    });
    // The re-run's verdict is discarded and main's full check answers: red, at the tip, naming
    // whatever its own output named — here Z, a set that excuses none of the change's X.
    assert.equal(verdict.status, "red");
    assert.equal(verdict.status === "red" && verdict.sha, mainSha(root));
    assert.deepEqual(verdict.status === "red" ? verdict.failingTests : undefined, ["Z"]);
    assert.deepEqual(checkScopes(root), [
      ["rerun", "failed"],
      ["baseline", "failed"],
    ]);
  } finally {
    restore();
  }
});

test("no declared re-run skips straight to main's fresh full check, without a re-run event", async () => {
  const restore = fakeNpmDispatch('echo "✖ Z (1ms)"; exit 1', null);
  try {
    const { root, wt } = await fixture('echo "✖ Z (1ms)"; exit 1', null);
    const verdict = await mainTipFailures(root, ROLE, wt, "main", defaultConfig(), {
      tests: ["X"],
      files: { X: "t.test.js" },
    });
    assert.equal(verdict.status, "red");
    assert.equal(verdict.status === "red" && verdict.sha, mainSha(root));
    assert.deepEqual(checkScopes(root), [["baseline", "failed"]]);
  } finally {
    restore();
  }
});
