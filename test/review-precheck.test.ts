/** The review-gate suite's build pre-check slice — the gate's integration with the
 * deterministic build check (src/build/build-check.ts): a failing check rejects with zero
 * reviewer runs, naming the failing assertion; a failure that twice spans a sleep keeps the
 * commit and reports the sleep; a repeat matching no recorded flake re-runs main fresh; a
 * red main fails twice without a strike; a no-verdict main rejects; a shutdown fails closed;
 * a configured check.command gates a repo with no npm install. Part 3l/3 retired the
 * pre-merge reviewer's dedicated cases from this file, so no case here drives a reviewer
 * run — the rejects above conclude without one. The check's own unit tests live in
 * build-check.test.ts. Extracted from review.test.ts (2026-09-29); the shared gate
 * scaffolding lives in fixtures/gate-fixtures.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reviewAheadOfMain } from "../src/review/review.js";
import { diffRuleReasons } from "../src/review/diff-rules.js";
import { aheadOfMain, headOf } from "../src/git/git.js";
import { treeDiffFiles } from "../src/git/git-diff.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { defaultConfig } from "../src/config/config.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { readEvents } from "../src/events/event-read.js";
import { noteGreenBaseline } from "../src/baseline/main-baseline.js";
import { createMainWatch, knownMainFailures } from "../src/baseline/main-watch.js";
import { shortSha } from "../src/text/format.js";
import { eventsOfType, warningMessages, warningMessagesOf } from "./fixtures/log-fixtures.js";
import { projManifest, writeScript } from "./fakes/fake-commands.js";
import { commitIn, mainSha, makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { piRanMarker, withPi } from "./fakes/fake-pi.js";
import { gateCtx, reviewGate, ROLE } from "./fixtures/gate-fixtures.js";
import { scriptedSampler, woke } from "./helpers/sleep-clock.js";

// The gate's integration with the deterministic build pre-check (src/build/build-check.ts): a
// failing build rejects with zero reviewer runs, naming the failing assertion. The check's own
// unit tests live in build-check.test.ts.

// ── Build pre-check: gate-level e2e (failing build, hanging build) ──────────────────

/** A repo whose root carries the install signature (package.json + node_modules) and a
 * worktree with a committed change; both manifests declare the same check script under
 * `scriptName` (default `build`). `toolBody`, when given, is installed as an executable at
 * the root's node_modules/.bin/buildcheck-tool — the dogfood layout where the worktree
 * resolves its toolchain from the installed root. */
async function gateBuildFixture(
  buildScript: string,
  toolBody?: string,
  scriptName = "build",
  /** What the root install's manifest declares — main's own check walks up to this, while the
   * change worktree carries its own copy of `buildScript`. Defaults to the same script; a test
   * whose change fails while main should stay green passes a passing script here, so the gate's
   * fresh main re-check (BUGS.md 2026-10-06) really passes. */
  rootScript = buildScript,
): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  if (toolBody) {
    writeScript(path.join(root, "node_modules", ".bin", "buildcheck-tool"), toolBody);
  }
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ [scriptName]: rootScript }),
  );
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ [scriptName]: buildScript }),
  );
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  commitIn(wt, "wip change");
  return { root, wt };
}


// A pre-check failure that survives its one re-run is attributed through main's own baseline
// verdict at its tip (main-red.ts's mainTipVerdict) — never handed to a model run. Main green:
// the change broke the check and is rejected deterministically. Main red: not the change's
// failure — the gate fails without a strike and the commit stays. No verdict: rejected, and the
// reasons say so. makeRepo's seed commit is byte-identical across tests run in the same second,
// and the baseline cache is keyed by SHA and process-wide, so a test that needs main red or
// unverdicted gives main a commit of its own (uniqueMain) instead of trusting whatever an
// earlier test cached for the shared seed SHA.

/** Seed main's baseline green at `root`'s tip — what every merge leaves behind for the SHA it
 * moved main to (noteGreenBaseline), so the gate's attribution is a cache hit, no run. */
function seedGreenMain(root: string): void {
  noteGreenBaseline(mainSha(root));
}

/** Give `root`'s main a commit no other test shares and return its sha: the baseline cache then
 * has no verdict for it, and the attribution check runs main's declared check for real. */
function uniqueMain(root: string): string {
  const file = `main-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  fs.writeFileSync(path.join(root, file), "main moved\n");
  sh(root, "git", "add", file);
  sh(root, "git", "commit", "-m", "main moves on its own");
  return mainSha(root);
}

const buildCheckEvents = (root: string): string[] =>
  readEvents(root)
    .filter((e) => e.type === "build_check")
    .map((e) => `${e.scope}:${e.status}`);

test("gate pre-check rejects a failing build with zero reviewer runs", async () => {
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'src/bad.ts(3,5): error TS2345: Argument of type string is not assignable'\nexit 1\n",
    undefined,
    "echo ok",
  );
  seedGreenMain(root);

  // Any pi run at all touches the marker: none may start — not a fix run, not the reviewer.
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const { state, result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected");
    assert.ok(!fs.existsSync(marker), "no pi run: the check and main's verdict decided alone");
    assert.equal(result.run, undefined, "the reviewer never ran");
    // The failure is re-run once before it is attributed, both runs priced as gate build_check
    // events; main's fresh re-check (BUGS.md 2026-10-06) passes against the root manifest, so a
    // baseline run is priced too.
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed", "baseline:passed"]);
    assert.equal(await aheadOfMain(wt, "main"), 0); // branch reset to main
    assert.match(result.detail ?? "", /^check failed \(\`npm run build\`\): /);
    assert.equal(state.lastReview?.verdict, "reject");
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons[0] ?? "", /^check failed \(\`npm run build\`\): src\/bad\.ts\(3,5\)/); // header + first output line
    assert.ok(!reasons.some((r) => r.includes("baseline")), "a green main needs no attribution note");
    assert.equal(state.unreviewFailures, 0); // a deterministic verdict resets strikes like a model reject
    const rejected = readEvents(root).find((e) => e.type === "review_rejected");
    assert.ok(rejected, "the rejection is logged for tumwater logs");
    assert.match(String(rejected?.reasons), /TS2345/); // the compiler tail rides on the event
  });
});

test("a red pre-check on the declared test script rejects with zero pi runs", async () => {
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho '1 failing of 3 tests: assert.equal'\nexit 1\n",
    "test",
    "echo ok",
  );
  seedGreenMain(root);

  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const { state, result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected");
    assert.ok(!fs.existsSync(marker), "no pi run before the reject");
    assert.equal(await aheadOfMain(wt, "main"), 0); // branch reset to main
    assert.match(result.detail ?? "", /^check failed \(\`npm run test\`\): /);
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons[0] ?? "", /^check failed \(\`npm run test\`\): 1 failing/); // header names the script that ran
    assert.equal(state.unreviewFailures, 0); // a deterministic verdict resets strikes like a model reject
  });
});

test("gate pre-check names the failing assertion, not the stack frame the tail opens on", async () => {
  // A suite that dies on an unhandled rejection leaves a tail whose window opens mid-stack; the
  // headline must be the assertion line the suite reported, and the real diff content must
  // survive — not be skipped as noise (BUGS.md 2026-09-19).
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    [
      "#!/bin/sh",
      "cat <<'BUILD_OUT'",
      "AssertionError [ERR_ASSERTION]: 1 == 2",
      "at TestContext.<anonymous> (file:///w/dist/test/x.test.js:3:35)",
      "at Test.runInAsyncScope (node:async_hooks:226:14)",
      "at Test.run (node:internal/test_runner/test:1397:25)",
      "at Test.start (node:internal/test_runner/test:1257:17)",
      "at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17)",
      "generatedMessage: true,",
      "code: 'ERR_ASSERTION',",
      "actual: 1,",
      "expected: 2,",
      "operator: '==',",
      "diff: 'simple'",
      "}",
      "BUILD_OUT",
      "exit 1",
      "",
    ].join("\n"),
    "test",
    "echo ok",
  );
  seedGreenMain(root);

  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const { state, result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected");
    assert.ok(!fs.existsSync(marker), "no pi run before the reject");
    const reasons = state.lastReview?.reasons ?? [];
    assert.equal(reasons[0], "check failed (`npm run test`): AssertionError [ERR_ASSERTION]: 1 == 2");
    assert.ok(reasons.some((r) => r.startsWith("at ")), "the rest of the clipped tail still follows");
    assert.ok(reasons.includes("actual: 1,"), "real diff content is not skipped as noise");
  });
});

// A red MAIN must not reject every queued change for a failure none of their authors caused —
// the goal the in-slot build-fix run served, now met by attribution: the change keeps its commit
// (and the merger its pin), no strike is counted, and main-red.ts's healer hand-off
// (`mainRedHealNote`) and the bugfix handoff own the repair.
test("a pre-check that fails twice on a red main fails without a strike and keeps the commit", async () => {
  // The tool fails everywhere — on the change's tree AND on main's, which the attribution check
  // runs in its own worktree because this unique main SHA has no cached verdict.
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n",
  );
  const movedMainSha = uniqueMain(root);
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const state = freshRunnerState(ROLE);
    state.unreviewFailures = 1; // an earlier reviewer strike against this head stays exactly as it was
    const head = await headOf(wt, "HEAD");
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "failed");
    assert.equal(result.detail, `main ${shortSha(movedMainSha)} is red — not this change's failure`);
    assert.equal(result.aborted, undefined);
    assert.equal(result.discarded, undefined, "not a discard: the pin must stay");
    assert.equal(result.mainRed, true, "the merge reports main_red, not a reviewer failure");
    assert.ok(!fs.existsSync(marker), "no pi run: nothing was spent on main's failure");
    assert.equal(state.unreviewFailures, 1, "no strike: nothing judged this diff");
    assert.equal(state.lastReview?.verdict, "failed", "no rejection recorded against the author");
    assert.equal(await headOf(wt, "HEAD"), head, "the commit stays for the next re-merge");
    assert.equal(await aheadOfMain(wt, "main"), 1);
    const events = readEvents(root);
    assert.ok(!events.some((e) => e.type === "review_rejected"), "no rejection logged");
    // The change's check ran twice; main's once, in the attribution worktree, priced as a baseline
    // run.
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed", "baseline:failed"]);
    const warnings = warningMessagesOf(events);
    const holds = eventsOfType(root, "main_red_hold").map((e) => String(e.message));
    assert.ok(
      holds.some((m) => m.startsWith(`main ${shortSha(movedMainSha)} is red (build: error TS2345: boom)`)),
      `the team-wide main_red_hold fires; got: ${JSON.stringify(holds)}`,
    );
    assert.ok(
      warnings.includes(`gate check failed on ${shortSha(head)}, but main ${shortSha(movedMainSha)} is red — not this change's failure; merge kept`),
      `the role's warning names both heads; got: ${JSON.stringify(warnings)}`,
    );
  });
});

test("a pre-check that fails twice with no verdict for main rejects, saying the baseline was unavailable", async () => {
  // The configured command fails fast when change.txt is present and otherwise exits nonzero
  // matching a toolchain signature: on the change's tree the run is `boom`, and on main's clean
  // attribution worktree it dies on `/xcrun: error/`, so main's run is an environmental skip with
  // no verdict. Deterministic — no `sleep` raced against a timeout — so the two wall-clock races
  // this test once had (a deadline firing >DEADLINE_LATE_TOLERANCE_MS late on a loaded box, or a
  // stalled event loop letting `sleep 5` finish first) cannot flip it. BUGS.md 2026-10-26.
  const root = makeRepo();
  uniqueMain(root);
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(path.join(wt, "change.txt"), "change\n");
  commitIn(wt, "wip change");
  const ctx = {
    ...gateCtx(root, wt),
    config: {
      ...defaultConfig(),
      check: {
        command:
          "if [ -f change.txt ]; then echo 'boom'; exit 1; fi; echo 'xcrun: error: unable to find utility'; exit 1",
      },
    },
  };
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain(ctx, state);
    assert.equal(result.decision, "rejected", "the author's failure is the safe default");
    assert.ok(!fs.existsSync(marker), "no pi run");
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons[0] ?? "", /^check failed \(`.*`\): boom$/);
    assert.equal(
      reasons.at(-1),
      "main's baseline was unavailable (its check was skipped (toolchain)), so the failure is attributed to this change",
    );
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed", "baseline:skipped"]);
  });
});


// BUGS.md 2026-10-06: main's cached green can go stale for a clock- or load-sensitive test,
// and the attribution then rejected an unrelated change. A repeated failure matching no
// recorded flake must run main's check fresh, bypassing the cached green: here main fails the
// same check but its SHA was seeded green, so the pre-fix gate rejected the change while main
// was really red.
test("a repeat failure with no recorded flake re-runs main fresh instead of trusting its cached green", async () => {
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n",
  );
  seedGreenMain(root); // an earlier merge verified this SHA green; the test now fails on it
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const state = freshRunnerState(ROLE);
    state.unreviewFailures = 1; // an earlier reviewer strike stays exactly as it was
    const head = await headOf(wt, "HEAD");
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "failed");
    assert.equal(result.mainRed, true, "the fresh run finds main red, not this change's failure");
    assert.equal(result.discarded, undefined, "not a discard: the pin must stay");
    assert.equal(state.unreviewFailures, 1, "no strike: nothing judged this diff");
    assert.equal(await headOf(wt, "HEAD"), head, "the commit stays for the next re-merge");
    assert.ok(!fs.existsSync(marker), "no pi run: main's fresh verdict decided alone");
    assert.deepEqual(
      buildCheckEvents(root),
      ["gate:failed", "gate:failed", "baseline:failed"],
      "the cached green is bypassed and main's check runs",
    );
  });
});

test("a configured check.command gates a merge in a repo with no npm install at all", async () => {
  // plans/portability.md §6/7: no package.json and no node_modules anywhere — today's walk-up
  // detection finds nothing and every gate silently turns off; a configured command must run
  // at the review gate instead, failing the diff deterministically with the command's tail.
  const root = makeRepo();
  seedGreenMain(root);
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  commitIn(wt, "wip change");
  const ctx = {
    ...gateCtx(root, wt),
    // Fails only where the change lands the marker, so main's fresh re-check (BUGS.md
    // 2026-10-06) still passes in its own worktree.
    config: { ...defaultConfig(), check: { command: "if [ -f ./change-marker ]; then echo 'pytest: 3 failing'; exit 1; fi; echo ok" } },
  };
  fs.writeFileSync(path.join(wt, "change-marker"), "");

  // Main is green (seeded), so the repeat failure is the change's: rejected with no pi run.
  const marker = path.join(tmpdir(), "pi-ran-command-check");
  await withPi(`touch '${marker}'`, async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain(ctx, state);
    assert.equal(result.decision, "rejected", "the configured check's failure gates the merge");
    assert.equal(result.run, undefined, "the reviewer never ran: the check decided alone");
    assert.ok(!fs.existsSync(marker), "no pi run");
    assert.equal(state.lastReview?.verdict, "reject");
    const reasons = state.lastReview?.reasons ?? [];
    assert.ok(reasons[0]?.includes("if [ -f ./change-marker ]"), "the configured command is named");
    assert.match(reasons[0] ?? "", /pytest: 3 failing$/);
    const rejected = readEvents(root).find((e) => e.type === "review_rejected");
    assert.ok(rejected, "the rejection is logged");
  });
});

test("a shutdown during a failing pre-check fails closed before main is consulted, keeping the commit", async () => {
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n",
  );
  uniqueMain(root);
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const controller = new AbortController();
    controller.abort(); // harness shutdown already in progress
    const { state, result } = await reviewGate(root, wt, { signal: controller.signal });
    assert.equal(result.decision, "failed");
    assert.ok(result.aborted);
    assert.ok(!fs.existsSync(marker), "no pi run");
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed"], "main's check never ran");
    assert.equal(await aheadOfMain(wt, "main"), 1); // the work commit stays; re-merged next run
    assert.equal(state.lastReview, undefined); // no bookkeeping on abort
  });
});












// BUGS.md 2026-09-30: a pre-check whose every attempt spanned a host sleep made no verdict
// about the tree. The gate attributes nothing — no main consultation, no strike, no
// rejection — the commit stays for a re-merge, and the warning names the sleep.
test("a pre-check that sleeps and fails on every attempt keeps the commit and reports the sleep", async () => {
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n",
  );
  const state = freshRunnerState(ROLE);
  state.unreviewFailures = 1; // an earlier reviewer strike stays exactly as it was
  const head = await headOf(wt, "HEAD");
  // runScopedBuildCheck retries a slept failure internally, so two attempts, four samples —
  // each attempt opens awake and closes after a 119 s sleep.
  // runScopedBuildCheck retries a slept failure internally, and the gate's own flake re-run
  // then runs the same scoped check again — four attempts, eight samples, each opening awake
  // and closing after a 119 s sleep.
  const sampler = scriptedSampler([
    woke(1_000), woke(121_000, 2_000),
    woke(121_000), woke(241_000, 122_000),
    woke(241_000), woke(361_000, 242_000),
    woke(361_000), woke(481_000, 362_000),
  ]);
  const result = await reviewAheadOfMain({ ...gateCtx(root, wt), sampleSleep: sampler }, state);
  assert.equal(result.decision, "failed");
  assert.equal(result.unverified, true, "the failure is unverified, not the change's");
  assert.equal(result.mainRed, undefined, "main was never consulted — the check made no verdict");
  assert.equal(result.discarded, undefined, "not a discard: the pin must stay");
  assert.equal(state.unreviewFailures, 1, "no strike: nothing judged this diff");
  assert.equal(state.lastReview, undefined, "no rejection recorded against the author");
  assert.equal(await headOf(wt, "HEAD"), head, "the commit stays for the next re-merge");
  assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed", "gate:failed", "gate:failed"], "each attempt is priced");
  const warnings = warningMessages(root);
  assert.ok(
    warnings.some((m) => m.includes("gate check ran while the host slept 119s mid-run; the tree is unverified")),
    `the warning names the sleep; got: ${JSON.stringify(warnings)}`,
  );
  assert.ok(!warnings.some((m) => m.includes("flaky")), "a sleep is never mislabeled a flaky test");
  assert.ok(!warnings.some((m) => m.startsWith("check failed")), "no test-failure headline");
});


// A gate failure that names only tests main already fails (the main watch's newest red verdict)
// goes on to review with no fresh run on main; any other failing test keeps the attribution path.

const KNOWN_FAILURE_TOOL =
  "#!/bin/sh\necho '✖ X (1ms)'\n[ -f y.txt ] && echo '✖ Y (1ms)'\nexit 1\n";

/** A gate fixture whose check fails test X on main and on the change; `alsoY` makes the change
 * fail Y too. The main watch has recorded main's red verdict, so X is a known failure. */
async function knownRedFixture(alsoY: boolean): Promise<{ root: string; wt: string }> {
  const { root, wt } = await gateBuildFixture("buildcheck-tool", KNOWN_FAILURE_TOOL);
  uniqueMain(root);
  const watch = createMainWatch(root, "main");
  watch.poll(mainSha(root), false, defaultConfig());
  await watch.idle();
  if (alsoY) {
    fs.writeFileSync(path.join(wt, "y.txt"), "y\n");
    commitIn(wt, "add y");
  }
  return { root, wt };
}


test("a gate failure of a known failure plus another test is handled as before", async () => {
  const { root, wt } = await knownRedFixture(true);
  await withPi('true', async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "failed");
    assert.equal(result.mainRed, true);
    assert.ok(!warningMessages(root).some((m) => m.includes("known failures")));
  });
});

// A branch behind a fix: its base was red with X (the watch recorded it), main's tip is green now.

const FIXED_ON_MAIN_TOOL =
  "#!/bin/sh\nout=0\n[ -f x-broken.txt ] && { echo '✖ X (1ms)'; out=1; }\n[ -f y.txt ] && { echo '✖ Y (1ms)'; out=1; }\nexit $out\n";

/** The base commit has `x-broken.txt` (check fails X) and the change branches from it; main then
 * removes it and the watch records the tip green. `alsoY` makes the change fail Y too. */
async function fixedOnMainFixture(alsoY: boolean): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  writeScript(path.join(root, "node_modules", ".bin", "buildcheck-tool"), FIXED_ON_MAIN_TOOL);
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ build: "buildcheck-tool" }));
  fs.writeFileSync(path.join(root, "x-broken.txt"), "x\n");
  sh(root, "git", "add", "x-broken.txt", "package.json");
  sh(root, "git", "commit", "-m", "main breaks X");
  uniqueMain(root);
  const watch = createMainWatch(root, "main");
  watch.poll(mainSha(root), false, defaultConfig());
  await watch.idle();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(path.join(wt, "package.json"), projManifest({ build: "buildcheck-tool" }));
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  if (alsoY) fs.writeFileSync(path.join(wt, "y.txt"), "y\n");
  commitIn(wt, "wip change");
  sh(root, "git", "rm", "x-broken.txt");
  sh(root, "git", "commit", "-m", "main fixes X");
  watch.poll(mainSha(root), false, defaultConfig());
  await watch.idle();
  assert.deepEqual(knownMainFailures(root), [], "the newest verdict is green");
  return { root, wt };
}


test("a gate failure beyond the base's red failures is still rejected on a green main", async () => {
  const { root, wt } = await fixedOnMainFixture(true);
  await withPi('true', async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected");
    assert.match(String(eventsOfType(root, "review_rejected")[0]?.reasons), /Y/);
    assert.ok(!warningMessages(root).some((m) => m.includes("already failed")));
  });
});



test("diffRuleReasons returns the gate's rules in order", async () => {
  const changedFiles = async (wt: string, base: string): Promise<string[]> =>
    (await treeDiffFiles(wt, base, await headOf(wt, "HEAD"))) ?? [];

  // conflict marker
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "app.ts"), "const a = 1;\n<<<<<<< HEAD\n");
    commitIn(wt, "leaves a conflict marker");
    const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false);
    assert.match(reasons[0] ?? "", /conflict markers remain in: app\.ts/);
  }

  // secret leak (a secret-named env value not present at the base)
  {
    process.env.TUMWATER_TEST_SECRET = "leaky-secret-value-9876543210";
    try {
      const root = makeRepo();
      const wt = await ensureWorktree(root, ROLE, "main");
      const base = await headOf(wt, "HEAD");
      fs.writeFileSync(path.join(wt, "dump.txt"), "the value is leaky-secret-value-9876543210\n");
      commitIn(wt, "leaks a secret");
      const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false);
      assert.match(reasons[0] ?? "", /contains the value of \$TUMWATER_TEST_SECRET/);
    } finally {
      delete process.env.TUMWATER_TEST_SECRET;
    }
  }

  // protected edit
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "PRINCIPLES.md"), "One principle.\n");
    commitIn(wt, "edits PRINCIPLES");
    const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false);
    assert.match(reasons[0] ?? "", /PRINCIPLES\.md is edited by the \w+ role/);
  }

  // an empty role (the watch cannot name the merging role) still runs the role-independent
  // brief-block rule, but not the PRINCIPLES rule that needs an attribution
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const brief = "# T\n\n<!-- tumwater:prompt:start -->\nthe prompt\n<!-- tumwater:prompt:end -->\n\n## Status\n\nold\n";
    fs.writeFileSync(path.join(wt, "README.md"), brief);
    commitIn(wt, "adds a brief");
    const briefBase = await headOf(wt, "HEAD"); // the brief block now sits at the base
    fs.writeFileSync(path.join(wt, "README.md"), brief.replace("the prompt", "other"));
    commitIn(wt, "changes the brief");
    const reasons = await diffRuleReasons(wt, briefBase, await changedFiles(wt, briefBase), "", false);
    assert.match(reasons[0] ?? "", /changes the brief between the tumwater:prompt markers/);
  }
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "PRINCIPLES.md"), "One principle.\n");
    commitIn(wt, "edits PRINCIPLES");
    const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), "", false);
    assert.deepEqual(reasons, [], "an unknown role is no basis for condemning a PRINCIPLES edit");
  }

  // backlog structure
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "BUGS.md"), "# Bugs\n\n## Open\n\nentry one\n\n## Open\n\nentry two\n");
    commitIn(wt, "duplicates a section");
    const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false);
    assert.match(reasons[0] ?? "", /adds another "## Open" heading/);
  }

  // an md-only diff runs the false-fix rule; a code diff does not
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(
      path.join(wt, "BUGS.md"),
      "# Bugs\n\n## Open\n\n_None yet._\n\n## Fixed\n\n### Phantom bug (found 2026-10-01; fixed 2026-10-18)\n\n**Fix:** `noSuchSymbolOnTree` was added.\n",
    );
    commitIn(wt, "claims a phantom fix");
    const mdOnly = await changedFiles(wt, base);
    const reasons = await diffRuleReasons(wt, base, mdOnly, ROLE, true);
    assert.match(reasons[0] ?? "", /noSuchSymbolOnTree/);
    fs.writeFileSync(path.join(wt, "app.ts"), "export {};\n");
    commitIn(wt, "adds code beside the claim");
    const reasons2 = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false);
    assert.ok(!reasons2.some((r) => r.includes("noSuchSymbolOnTree")), "a code diff does not run the false-fix rule");
  }

  // short-circuit: when an earlier rule already rejects, a later rule never runs
  {
    process.env.TUMWATER_TEST_SECRET = "short-circuit-secret-5555";
    try {
      const root = makeRepo();
      const wt = await ensureWorktree(root, ROLE, "main");
      const base = await headOf(wt, "HEAD");
      fs.writeFileSync(path.join(wt, "app.ts"), "const a = 1;\n<<<<<<< HEAD\nconst leak = \"short-circuit-secret-5555\";\n");
      commitIn(wt, "leaves a conflict marker and leaks a secret");
      const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false);
      assert.match(reasons[0] ?? "", /conflict markers remain in: app\.ts/);
      assert.equal(reasons.length, 1, "the secret rule never runs once the marker already rejects");
    } finally {
      delete process.env.TUMWATER_TEST_SECRET;
    }
  }

  // a clean diff returns []
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "note.txt"), "hello\n");
    commitIn(wt, "a clean change");
    const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false);
    assert.deepEqual(reasons, []);
  }
});
