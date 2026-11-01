/** Which check verifies main's baseline, and when it may run (src/baseline/main-baseline.ts): no
 * declared check means nothing to verify (checkMainBaseline returns null, mainIsGreen reads
 * green), a configured check.command verifies main on a repo with no npm install anywhere, and
 * a baseline run waits for the same process-wide check permit as the scoped checks. Sibling
 * slices: main-baseline.test.ts (the per-SHA verdict cache) and main-baseline-reverify.test.ts
 * (a one-worktree red re-run by the next worktree). */
import { sleep } from "./helpers/wait.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CHECK_TIER, withCheckPermit } from "../src/concurrency/check-permit.js";
import { checkMainBaseline, mainIsGreen } from "../src/baseline/main-baseline.js";
import { defaultConfig } from "../src/config/config.js";
import { baselineFixture, runsOf } from "./fixtures/runner-fixtures.js";
import { ensureDetachedWorktree } from "../src/git/worktree.js";
import { mirrorWorktreePath } from "../src/paths.js";
import { headSha, makeRepo, sh, tmpdir, worktreeAt } from "./fixtures/repo-fixtures.js";

const ROLE = "improve";
/** The live config checkMainBaseline requires (plans/portability.md §6/7). The defaults (no
 * `check` configured) mean npm auto-detection, or nothing to verify where no install exists;
 * the configured-command tests build their own config. */
const CFG = defaultConfig();

test("checkMainBaseline returns null (no block) when no build check is declared", async () => {
  const base = tmpdir("baseline-none-");
  const root = makeRepo(path.join(base, "project"));
  const wt = worktreeAt(root, ROLE);

  const result = await checkMainBaseline(wt, CFG);
  assert.equal(result.baseline, null, "nothing to verify → nothing to block on");
  assert.equal(result.skipReason, undefined, "a missing check is not an environmental skip");
});

test("a configured check.command verifies main on a repo with no npm install anywhere", async () => {
  // plans/portability.md §6/7: a Python/Rust/Go repo has no install for the walk-up to find;
  // the red-main baseline must still run the project's declared check, from tumwater.json.
  const counter = path.join(tmpdir(), "runs-cmd-baseline");
  const root = makeRepo();
  const checkScript = path.join(root, "check.sh");
  fs.writeFileSync(checkScript, `#!/bin/sh\necho run >> ${counter}; echo 'pytest: 1 failing'; exit 1\n`);
  fs.chmodSync(checkScript, 0o755);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "check");
  const wt = worktreeAt(root, ROLE);

  const cfg = { ...defaultConfig(), check: { command: `${checkScript} -q` } };
  const runs: { outcome: { status?: string; script?: string }; durationMs: number }[] = [];
  const result = await checkMainBaseline(wt, cfg, ({ outcome, durationMs }) => runs.push({ outcome, durationMs }));
  assert.equal(result.baseline?.status, "red", "the configured command's failure yields a red verdict that names the failing script");
  assert.equal(result.baseline.status === "red" ? result.baseline.script : undefined, `${checkScript} -q`, "the red names the configured command");
  assert.equal(runsOf(counter), 1, "the command ran once");
  assert.equal(runs[0]?.outcome.status, "failed", "the hook saw the classified failure");
  assert.equal(runs[0]?.outcome.script, `${checkScript} -q`, "the event's script field names the command");
});

test("a baseline run takes the same process-wide check permit as the scoped checks", { timeout: 30_000 }, async () => {
  // checkMainBaseline runs the suite directly, not through
  // runScopedBuildCheck, so it must count against maxConcurrentChecks on its own.
  const counter = path.join(tmpdir(), "runs-permit");
  const { wt } = baselineFixture(ROLE, `echo run >> ${counter}; echo ok`);
  const one = { ...CFG, maxConcurrentChecks: 1 };
  let release!: () => void;
  const held = withCheckPermit(one, CHECK_TIER.merge, () => new Promise<void>((resolve) => (release = resolve)));
  const pending = checkMainBaseline(wt, one);
  await sleep(1_500);
  assert.equal(runsOf(counter), 0, "the suite waits while the only permit is held");
  release();
  await held;
  const result = await pending;
  assert.equal(result.baseline?.status, "green");
  assert.equal(runsOf(counter), 1, "and runs once the permit frees");
});

// mainIsGreen — the redeploy gate's boolean view of checkMainBaseline (moved to the
// main-baseline tests from test/redeployer.test.ts, which keeps only the redeployer state
// machine)

test("mainIsGreen: no declared check reads as green", async () => {
  const root = makeRepo();
  const head = headSha(root);
  const mirror = await ensureDetachedWorktree(root, mirrorWorktreePath(root), head);
  // No package.json anywhere up the tree of this temp repo: nothing to verify, nothing to block on.
  assert.equal(await mainIsGreen(mirror, CFG), true);
});

test("mainIsGreen runs a configured check.command on a repo with no npm install anywhere", async () => {
  // plans/portability.md §6/7: the green check must run on a Python/Rust/Go repo too — a
  // configured command, no package.json and no node_modules in sight.
  const counter = path.join(tmpdir(), "runs-green-cmd");
  const root = makeRepo();
  const checkScript = path.join(root, "check.sh");
  fs.writeFileSync(checkScript, `#!/bin/sh\necho run >> ${counter}\n`);
  fs.chmodSync(checkScript, 0o755);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "check");
  const head = headSha(root);
  const mirror = await ensureDetachedWorktree(root, mirrorWorktreePath(root), head);

  const cfg = { ...defaultConfig(), check: { command: `${checkScript} -q` } };
  const events: { outcome: { status?: string; script?: string }; durationMs: number }[] = [];
  assert.equal(await mainIsGreen(mirror, cfg, (run) => events.push(run)), true);
  assert.equal(fs.readFileSync(counter, "utf8").split("\n").filter((l) => l === "run").length, 1, "the configured command ran");
  assert.equal(events.length, 1, "the run is priced in the feed like an npm check's");

  // And a failing configured check reads as red, naming the command.
  fs.writeFileSync(checkScript, "#!/bin/sh\necho 'pytest: 1 failing'; exit 1\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "check now fails");
  const redHead = headSha(root);
  const redMirror = await ensureDetachedWorktree(root, mirrorWorktreePath(root), redHead);
  const red = await checkMainBaseline(redMirror, cfg);
  assert.equal(red.baseline?.status, "red");
  assert.equal(red.baseline.status === "red" ? red.baseline.script : undefined, `${checkScript} -q`);
});
