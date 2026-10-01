/** The review-gate suite's build pre-check slice — the gate's integration with the
 * deterministic build check (src/build-check.ts): a healthy build must reach the model
 * reviewer, a failing one rejects with zero reviewer runs, a red main blocks twice then
 * fails without a strike, a flake re-runs once, a timed-out check proceeds unverified, a
 * green check attests its head to the landing path and names itself in the reviewer's
 * prompt, and an approval reused across a moved main survives only while the patch and the
 * check stay green. The check's own unit tests live in build-check.test.ts. Extracted from
 * review.test.ts (2026-09-29); the shared gate scaffolding lives in gate-fixtures.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reviewAheadOfMain } from "../src/review.js";
import { aheadOfMain, headOf } from "../src/git.js";
import { ensureWorktree } from "../src/worktree.js";
import { defaultConfig } from "../src/config.js";
import { freshLoopState } from "../src/loop-state.js";
import { readEvents } from "../src/event-read.js";
import { noteGreenBaseline } from "../src/main-baseline.js";
import { shortSha } from "../src/text.js";
import { eventsOfType } from "./log-fixtures.js";
import { projManifest, writeScript } from "./fake-commands.js";
import { mainSha, makeRepo, sh, tmpdir } from "./repo-fixtures.js";
import { logPromptsTo, piRanMarker, readPromptRuns, reviewerStub, withPi } from "./fake-pi.js";
import { assistantLine } from "./pi-events.js";
import { gateCtx, gateFixture, reviewGate, ROLE } from "./gate-fixtures.js";
import { scriptedSampler, woke } from "./sleep-clock.js";


// The gate's integration with the deterministic build pre-check (src/build-check.ts): a
// healthy build must reach the model reviewer. The check's own unit tests live in
// build-check.test.ts.
test("gate pre-check compiles the worktree against the root install — a healthy build reaches the reviewer", async () => {
  const root = makeRepo();
  // The install signature at the repo root (what detectBuildCheck walks up to from the
  // worktree), plus the worktree's own tracked package.json with no node_modules.
  const binDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ build: "buildcheck-tool --ok" }),
  );
  writeScript(path.join(binDir, "buildcheck-tool"), "echo ok");

  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ build: "buildcheck-tool --ok" }),
  );
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change");

  const marker = piRanMarker();
  await withPi(reviewerStub(marker), async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "approved"); // pre-fix: "rejected" by the build check
    assert.ok(fs.existsSync(marker)); // …with no reviewer run; now it reaches pi
    // Both halves of the gate price themselves in the feed: the deterministic pre-check as a
    // build_check event (scope gate), the reviewer run's wall time on its verdict event.
    const events = readEvents(root);
    const checks = events.filter((e) => e.type === "build_check");
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.scope, "gate");
    assert.equal(checks[0]!.status, "passed");
    assert.equal(checks[0]!.script, "build");
    assert.ok(Number(checks[0]!.durationMs) >= 0);
    const verdict = events.find((e) => e.type === "review_verdict");
    assert.ok(verdict && Number.isFinite(Number(verdict.durationMs)), "the approval carries the reviewer's duration");
  });
});

// The harness owns the suite counts (PLANS.md 2026-09-29): the gate's green check reads the
// runner's summary (parseTestCounts), records it on the build_check event, and attests it in
// the review prompt — so neither author nor reviewer states a total, which is where most
// record-claim rejections came from.
test("the gate's green pre-check attests the runner's counts in the event and the review prompt", async () => {
  const root = makeRepo();
  const binDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ build: "buildcheck-tool --ok" }),
  );
  writeScript(
    path.join(binDir, "buildcheck-tool"),
    'echo "ℹ tests 3"; echo "ℹ pass 3"; echo "ℹ fail 0"; echo "ℹ skipped 0"',
  );
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ build: "buildcheck-tool --ok" }),
  );
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change");

  // The fake pi dumps its prompt (pi's last argv) to a file so the attested line is asserted,
  // not merely assumed.
  const promptFile = path.join(tmpdir(), "review-prompt");
  await withPi(
    `for a in "$@"; do printf '%s' "$a" >> '${promptFile}'; done\n` +
      `${reviewerStub()}`,
    async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "approved");
    const checks = readEvents(root).filter((e) => e.type === "build_check");
    assert.equal(checks.length, 1);
    assert.deepEqual(checks[0]!.counts, { tests: 3, pass: 3, fail: 0, skipped: 0 });
    const prompt = fs.readFileSync(promptFile, "utf8");
    assert.match(
      prompt,
      /\(the project's declared check\) passed — 3 pass, 0 fail, 0 skipped of 3/,
      "the attested counts appear above the checklist",
    );
  });
});

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
): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  if (toolBody) {
    writeScript(path.join(root, "node_modules", ".bin", "buildcheck-tool"), toolBody);
  }
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ [scriptName]: buildScript }),
  );
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ [scriptName]: buildScript }),
  );
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change");
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

/** Seed main's baseline green at `root`'s tip — what every landing leaves behind for the SHA it
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
  );
  seedGreenMain(root);

  // Any pi run at all touches the marker: none may start — not a fix run, not the reviewer.
  const marker = piRanMarker();
  await withPi(reviewerStub(marker), async () => {
    const { state, result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected");
    assert.ok(!fs.existsSync(marker), "no pi run: the check and main's verdict decided alone");
    assert.equal(result.run, undefined, "the reviewer never ran");
    // The failure is re-run once before it is attributed, both runs priced as gate build_check
    // events; main's green verdict was a cache hit (the seeded landing), so no baseline run.
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed"]);
    assert.equal(await aheadOfMain(wt, "main"), 0); // branch reset to main
    assert.match(result.detail ?? "", /^build check failed \(\`npm run build\`\): /);
    assert.equal(state.lastReview?.verdict, "reject");
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons[0] ?? "", /^build check failed \(\`npm run build\`\): src\/bad\.ts\(3,5\)/); // header + first output line
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
  );
  seedGreenMain(root);

  const marker = piRanMarker();
  await withPi(reviewerStub(marker), async () => {
    const { state, result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected");
    assert.ok(!fs.existsSync(marker), "no pi run before the reject");
    assert.equal(await aheadOfMain(wt, "main"), 0); // branch reset to main
    assert.match(result.detail ?? "", /^build check failed \(\`npm run test\`\): /);
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons[0] ?? "", /^build check failed \(\`npm run test\`\): 1 failing/); // header names the script that ran
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
  );
  seedGreenMain(root);

  const marker = piRanMarker();
  await withPi(reviewerStub(marker), async () => {
    const { state, result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected");
    assert.ok(!fs.existsSync(marker), "no pi run before the reject");
    const reasons = state.lastReview?.reasons ?? [];
    assert.equal(reasons[0], "build check failed (`npm run test`): AssertionError [ERR_ASSERTION]: 1 == 2");
    assert.ok(reasons.some((r) => r.startsWith("at ")), "the rest of the clipped tail still follows");
    assert.ok(reasons.includes("actual: 1,"), "real diff content is not skipped as noise");
  });
});

// A red MAIN must not reject every queued change for a failure none of their authors caused —
// the goal the in-slot build-fix run served, now met by attribution: the change keeps its commit
// (and the lander its pin), no strike is counted, and main-red.ts's gate and the bugfix handoff
// own the repair.
test("a pre-check that fails twice on a red main fails without a strike and keeps the commit", async () => {
  // The tool fails everywhere — on the change's tree AND on main's, which the attribution check
  // runs in its own worktree because this unique main SHA has no cached verdict.
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n",
  );
  const movedMainSha = uniqueMain(root);
  const marker = piRanMarker();
  await withPi(reviewerStub(marker), async () => {
    const state = freshLoopState(ROLE);
    state.unreviewFailures = 1; // an earlier reviewer strike against this head stays exactly as it was
    const head = await headOf(wt, "HEAD");
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "failed");
    assert.equal(result.detail, `main ${shortSha(movedMainSha)} is red — not this change's failure`);
    assert.equal(result.aborted, undefined);
    assert.equal(result.discarded, undefined, "not a discard: the pin must stay");
    assert.equal(result.mainRed, true, "the landing reports main_red, not a reviewer failure");
    assert.ok(!fs.existsSync(marker), "no pi run: nothing was spent on main's failure");
    assert.equal(state.unreviewFailures, 1, "no strike: nothing judged this diff");
    assert.equal(state.lastReview?.verdict, "failed", "no rejection recorded against the author");
    assert.equal(await headOf(wt, "HEAD"), head, "the commit stays for the next re-land");
    assert.equal(await aheadOfMain(wt, "main"), 1);
    const events = readEvents(root);
    assert.ok(!events.some((e) => e.type === "review_rejected"), "no rejection logged");
    // The change's check ran twice; main's once, in the attribution worktree, priced as a baseline run.
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed", "baseline:failed"]);
    const warnings = events.filter((e) => e.type === "warning").map((e) => String(e.message));
    assert.ok(
      warnings.some((m) => m.startsWith(`main ${shortSha(movedMainSha)} is red (build: error TS2345: boom)`)),
      `the fleet-wide red-main warning fires; got: ${JSON.stringify(warnings)}`,
    );
    assert.ok(
      warnings.includes(`gate check failed on ${shortSha(head)}, but main ${shortSha(movedMainSha)} is red — not this change's failure; landing kept`),
      `the role's warning names both heads; got: ${JSON.stringify(warnings)}`,
    );
  });
});

test("a pre-check that fails twice with no verdict for main rejects, saying the baseline was unavailable", async () => {
  // A configured command that fails fast on the change's tree (it carries change.txt) and hangs
  // on main's, past its own cap: main's run is a timeout skip, which yields no verdict.
  const root = makeRepo();
  uniqueMain(root);
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(path.join(wt, "change.txt"), "change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change");
  const ctx = {
    ...gateCtx(root, wt),
    config: {
      ...defaultConfig(),
      check: { command: "if [ -f change.txt ]; then echo 'boom'; exit 1; fi; sleep 5", timeoutSeconds: 0.5 },
    },
  };
  const marker = piRanMarker();
  await withPi(reviewerStub(marker), async () => {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(ctx, state);
    assert.equal(result.decision, "rejected", "the author's failure is the safe default");
    assert.ok(!fs.existsSync(marker), "no pi run");
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons[0] ?? "", /^build check failed \(`.*`\): boom$/);
    assert.equal(
      reasons.at(-1),
      "main's baseline was unavailable (its check was skipped (timeout)), so the failure is attributed to this change",
    );
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed", "baseline:skipped"]);
  });
});

// BUGS.md 2026-09-23: the gate's failures were mostly load flakes. A failure that does not
// reproduce on one immediate re-run is a flake: the tree is verified like a first-time pass, the
// flake is named in a warning, and no pi run is spent before the reviewer.
test("a pre-check failure that passes its one re-run is a flake: no pi run before the reviewer, verified, warned", async () => {
  const flag = path.join(tmpdir(), "flaky-once");
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --flaky",
    `#!/bin/sh\nif [ -f '${flag}' ]; then exit 0; fi\ntouch '${flag}'\necho 'AssertionError [ERR_ASSERTION]: startup latency is not a hung tool call' >&2\nexit 1\n`,
  );
  const prompts = path.join(tmpdir(), "prompts.log");
  await withPi(
    `${logPromptsTo(prompts)}\n${reviewerStub()}`,
    async () => {
    const head = await headOf(wt, "HEAD");
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "approved");
    assert.ok(result.run, "the reviewer ran, exactly as after a first-time pass");
    const runs = readPromptRuns(prompts);
    assert.equal(runs.length, 1, "the reviewer is the only pi run");
    assert.equal(await aheadOfMain(wt, "main"), 1, "the author's commit alone");
    assert.equal(result.verifiedHead, head, "the re-run's green verdict verifies the tree");
    const events = readEvents(root);
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:passed"], "both attempts are priced");
    const flaky = events.filter((e) => e.type === "warning").map((e) => String(e.message));
    assert.deepEqual(flaky, [
      "gate check failed then passed on retry — flaky: AssertionError [ERR_ASSERTION]: startup latency is not a hung tool call",
    ]);
    // The reviewer is told the check passed, the same claim a first-time pass makes.
    assert.match(runs[0] ?? "", /`npm run build` \(the project's declared check\) passed/);
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
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change");
  const ctx = {
    ...gateCtx(root, wt),
    config: { ...defaultConfig(), check: { command: "echo 'pytest: 3 failing'; exit 1" } },
  };

  // Main is green (seeded), so the repeat failure is the change's: rejected with no pi run.
  const marker = path.join(tmpdir(), "pi-ran-command-check");
  await withPi(reviewerStub(marker), async () => {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(ctx, state);
    assert.equal(result.decision, "rejected", "the configured check's failure gates the merge");
    assert.equal(result.run, undefined, "the reviewer never ran: the check decided alone");
    assert.ok(!fs.existsSync(marker), "no pi run");
    assert.equal(state.lastReview?.verdict, "reject");
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons[0] ?? "", /^build check failed \(\`echo 'pytest: 3 failing'; exit 1\`\): pytest: 3 failing$/);
    const rejected = readEvents(root).find((e) => e.type === "review_rejected");
    assert.ok(rejected, "the rejection is logged");
  });

  // And a green configured check passes the gate: the run is priced with the command in the
  // build_check event's script field, exactly like an npm check's run. A fresh change — the
  // reject above reset the branch to main, and an empty diff is exempt, not approved.
  fs.appendFileSync(path.join(wt, "seed.txt"), "second change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change 2");
  const greenCtx = {
    ...gateCtx(root, wt),
    config: { ...defaultConfig(), check: { command: "true" } },
  };
  await withPi(`printf '%s\n' '${assistantLine("VERDICT: approve\n1. checked the diff", { tokens: 17, output: 17, cost: 0.02 })}'`, async () => {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(greenCtx, state);
    assert.equal(result.decision, "approved");
    const events = readEvents(root);
    const check = events.filter((e) => e.type === "build_check" && e.scope === "gate").at(-1);
    assert.equal((check as { script?: string } | undefined)?.script, "true");
    assert.equal((check as { status?: string } | undefined)?.status, "passed");
  });
});

test("a shutdown during a failing pre-check fails closed before main is consulted, keeping the commit", async () => {
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n",
  );
  uniqueMain(root);
  const marker = piRanMarker();
  await withPi(reviewerStub(marker), async () => {
    const controller = new AbortController();
    controller.abort(); // harness shutdown already in progress
    const { state, result } = await reviewGate(root, wt, { signal: controller.signal });
    assert.equal(result.decision, "failed");
    assert.ok(result.aborted);
    assert.ok(!fs.existsSync(marker), "no pi run");
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed"], "main's check never ran");
    assert.equal(await aheadOfMain(wt, "main"), 1); // the work commit stays; re-landed next tick
    assert.equal(state.lastReview, undefined); // no bookkeeping on abort
  });
});

test("gate pre-check timeout warns and still proceeds to the model review", async () => {
  const { root, wt } = await gateBuildFixture("sleep 5"); // hangs past the shortened cap
  const marker = piRanMarker();
  await withPi(reviewerStub(marker), async () => {
    const { result } = await reviewGate(root, wt, { buildCheckTimeoutMs: 400 });
    assert.equal(result.decision, "approved"); // a timeout is environmental — not fail-closed
    assert.equal(result.verifiedHead, undefined); // no suite ran green — nothing to hand the landing path
    assert.ok(fs.existsSync(marker), "the reviewer still ran after the warning");
    const warning = readEvents(root).find((e) => e.type === "warning");
    assert.match(String(warning?.message), /build check timed out after 0\.4s; proceeding to model review/);
  });
});

// The gate hands its green pre-check verdict to the landing path via GateResult.verifiedHead:
// src/landing-merge.ts seeds the red-main baseline with the SHA that actually becomes main (the
// rebased head, which may differ from this one — landing-merge.test.ts covers the seeding and the
// post-rebase re-verify). A skipped pre-check makes no fresh observation: verifiedHead stays
// absent even when the model approves (asserted in the timeout test above).
test("a green pre-check hands its verified head to the landing path", async () => {
  const { root, wt } = await gateBuildFixture("buildcheck-tool --ok", "#!/bin/sh\nexit 0\n");
  await withPi(reviewerStub(), async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "approved"); // pre-check passed AND the reviewer approved
    assert.equal(result.verifiedHead, await headOf(wt, "HEAD")); // exactly the tree the pre-check ran green on
  });
});

// Land-queue speed 2a: a review judges a diff, not a sha. A vet rebases the pin onto main
// before its gate, so an approved change re-drained after main moved arrives at a new sha with
// the same patch — the approval is reused (no second reviewer run), the build pre-check is not.

/** Move main past the fixture's worktree with a commit to a file the change never touches,
 * then rebase the worktree onto it — the clean rebase a vet's syncPinToMain does. Returns
 * the rebased head. Only other.txt is staged: the root's package.json and node_modules are the
 * fixture's untracked install. */
async function moveMainAndRebase(root: string, wt: string): Promise<string> {
  fs.writeFileSync(path.join(root, "other.txt"), "someone else's change\n");
  sh(root, "git", "add", "other.txt");
  sh(root, "git", "commit", "-m", "main moves");
  sh(wt, "git", "rebase", "-q", "main");
  return headOf(wt, "HEAD");
}

test("an approved change cleanly rebased onto a moved main reuses its approval: no reviewer run, one check", async () => {
  const { root, wt } = await gateBuildFixture("buildcheck-tool --ok", "#!/bin/sh\nexit 0\n");
  const runs = path.join(tmpdir(), "pi-runs");
  await withPi(`echo run >> '${runs}'\nprintf '%s\n' '${assistantLine("VERDICT: approve\n1. solid")}'`, async () => {
    const state = freshLoopState(ROLE);
    const approvedHead = await headOf(wt, "HEAD");
    assert.equal((await reviewAheadOfMain(gateCtx(root, wt), state)).decision, "approved");
    assert.ok(state.lastApprovedPatchId, "the approval is keyed by its patch-id too");
    const checksBefore = eventsOfType(root, "build_check").length;

    const rebased = await moveMainAndRebase(root, wt);
    assert.notEqual(rebased, approvedHead, "the rebase rewrote the sha: the exact-sha short-circuit misses");
    const result = await reviewAheadOfMain(gateCtx(root, wt, 2), state);
    assert.equal(result.decision, "approved");
    assert.equal(result.run, undefined, "no reviewer run was spent");
    assert.equal(fs.readFileSync(runs, "utf8").trim().split("\n").length, 1, "one reviewer run across both gates");
    // The model review is reused; the check that the new tree still builds is not.
    const checks = eventsOfType(root, "build_check").slice(checksBefore);
    assert.deepEqual(checks.map((e) => `${e.scope}:${e.status}`), ["gate:passed"]);
    // The landing path trusts exactly this tree (its in-lock rebase is then a no-op), so the
    // pre-check is the only check the re-landing pays.
    assert.equal(result.verifiedHead, rebased);
    assert.equal(state.lastApprovedHead, rebased, "a retry of the rebased head is an exact-sha hit");
    assert.equal(
      eventsOfType(root, "review_start").length,
      1,
      "the reused approval never shows as reviewing",
    );
  });
});

test("a rebase that changes the patch is re-reviewed", async () => {
  const { root, wt } = await gateBuildFixture("buildcheck-tool --ok", "#!/bin/sh\nexit 0\n");
  const runs = path.join(tmpdir(), "pi-runs");
  await withPi(`echo run >> '${runs}'\n${reviewerStub()}`, async () => {
    const state = freshLoopState(ROLE);
    assert.equal((await reviewAheadOfMain(gateCtx(root, wt), state)).decision, "approved");
    const approvedPatch = state.lastApprovedPatchId;
    await moveMainAndRebase(root, wt);
    // What a conflict resolution does: the rebased commit carries a hunk the reviewer never saw.
    fs.appendFileSync(path.join(wt, "seed.txt"), "resolved differently\n");
    sh(wt, "git", "commit", "-a", "--amend", "--no-edit");
    const result = await reviewAheadOfMain(gateCtx(root, wt, 2), state);
    assert.equal(result.decision, "approved");
    assert.ok(result.run, "the changed patch got its own reviewer run");
    assert.equal(fs.readFileSync(runs, "utf8").trim().split("\n").length, 2);
    assert.notEqual(state.lastApprovedPatchId, approvedPatch, "the new approval names the new patch");
  });
});

test("a reused approval still rejects a tree whose pre-check now fails", async () => {
  // The same patch, but main moved under it and the rebased tree no longer builds: the
  // approval covers the diff's review, never the check.
  const red = path.join(tmpdir(), "red");
  const { root, wt } = await gateBuildFixture(`test ! -f '${red}'`);
  await withPi(reviewerStub(), async () => {
    const state = freshLoopState(ROLE);
    assert.equal((await reviewAheadOfMain(gateCtx(root, wt), state)).decision, "approved");
    await moveMainAndRebase(root, wt);
    fs.writeFileSync(red, "");
    // Main's own verdict at its new tip is green (what its landing left behind), so the
    // repeat failure is the change's own and the gate rejects it.
    seedGreenMain(root);
    const result = await reviewAheadOfMain(gateCtx(root, wt, 2), state);
    assert.equal(result.decision, "rejected");
    assert.match(result.detail ?? "", /^build check failed/);
    assert.equal(await aheadOfMain(wt, "main"), 0, "branch reset to main");
  });
});

// The reviewer's prompt names the harness's own green pre-check so the model reviewer does not
// spend its run re-running `npm test` — and stays silent about it when no check ran (no declared
// script, or a skipped run), so the reviewer is never told a suite passed that never executed.
test("a green pre-check is named in the reviewer's prompt; no check means no such claim", async () => {
  const { root, wt } = await gateBuildFixture("buildcheck-tool --ok", "#!/bin/sh\nexit 0\n", "test");
  const prompts = path.join(tmpdir(), "prompts.log");
  // The fake pi records its argv (the prompt is the last argument) before answering.
  await withPi(
    `${logPromptsTo(prompts)}\n${reviewerStub()}`,
    async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "approved");
    const run = fs.readFileSync(prompts, "utf8");
    assert.match(run, /The harness already ran the project's own check on this exact tree and it passed:/);
    assert.match(run, /`npm run test` \(the project's declared check\) passed/);
  });

  // A worktree with no declared check script: the pre-check never runs, so the prompt must not
  // claim a passing suite.
  const bare = await gateFixture();
  const barePrompts = path.join(tmpdir(), "prompts.log");
  await withPi(
    `${logPromptsTo(barePrompts)}\n${reviewerStub()}`,
    async () => {
    const { result } = await reviewGate(bare.root, bare.wt);
    assert.equal(result.decision, "approved");
    const run = fs.readFileSync(barePrompts, "utf8");
    assert.ok(!run.includes("The harness already ran"), "no pre-check claim when nothing ran");
  });
});

// The suite-rerun tripwire (BUGS.md 2026-09-23): a reviewer told the harness's pre-check passed
// that runs the full suite anyway — in a scratch copy under /tmp, like organize's and improve's
// reviews that day — is named in the event feed, while a filtered run (one test file) is not.
// After a timed-out pre-check no verified result exists: the prompt carries no no-re-run rule,
// and the same tool calls draw no warning.
test("a reviewer that re-runs the suite behind a green pre-check is warned about; after a timed-out pre-check it is not", async () => {
  const toolCalls = [
    { toolCallId: "c1", command: "cd /tmp/revrun && npm test 2>&1 | tail -15" },
    { toolCallId: "c2", command: "npm test gui 2>&1 | tail -5" },
  ]
    .flatMap(({ toolCallId, command }) => [
      { type: "tool_execution_start", toolCallId, toolName: "bash", args: { command } },
      { type: "tool_execution_end", toolCallId, result: {}, isError: false },
    ])
    .map((event) => `printf '%s\n' '${JSON.stringify(event)}'`)
    .join("\n");
  const reviewerScript = (prompts: string) =>
    `printf '%s\n' "$@" >> "${prompts}"\n${toolCalls}\n${reviewerStub()}`;
  const rerunWarnings = (root: string) =>
    readEvents(root)
      .filter((e) => e.type === "warning")
      .map((e) => String(e.message))
      .filter((m) => m.startsWith("reviewer re-ran the suite"));

  const green = await gateBuildFixture("buildcheck-tool --ok", "#!/bin/sh\nexit 0\n", "test");
  const greenPrompts = path.join(tmpdir(), "prompts.log");
  await withPi(reviewerScript(greenPrompts), async () => {
    const { result } = await reviewGate(green.root, green.wt);
    assert.equal(result.decision, "approved", "the tripwire warns; it never changes the verdict");
    assert.match(fs.readFileSync(greenPrompts, "utf8"), /^- Do not re-run the check named above/m);
    assert.deepEqual(rerunWarnings(green.root), [
      "reviewer re-ran the suite the harness's pre-check already verified: cd /tmp/revrun && npm test 2>&1 | tail -15",
    ]);
  });

  const timed = await gateBuildFixture("sleep 5"); // hangs past the shortened cap
  const timedPrompts = path.join(tmpdir(), "prompts.log");
  await withPi(reviewerScript(timedPrompts), async () => {
    const { result } = await reviewGate(timed.root, timed.wt, { buildCheckTimeoutMs: 400 });
    assert.equal(result.decision, "approved");
    assert.equal(result.verifiedHead, undefined, "the pre-check timed out — no verified result");
    assert.ok(!fs.readFileSync(timedPrompts, "utf8").includes("Do not re-run"), "no verified result, no rule");
    assert.deepEqual(rerunWarnings(timed.root), [], "running the suite is the reviewer's job here");
  });
});

// BUGS.md 2026-09-30: a pre-check whose every attempt spanned a host sleep made no verdict
// about the tree. The gate attributes nothing — no main consultation, no strike, no
// rejection — the commit stays for a re-land, and the warning names the sleep.
test("a pre-check that sleeps and fails on every attempt keeps the commit and reports the sleep", async () => {
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n",
  );
  const state = freshLoopState(ROLE);
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
  assert.equal(await headOf(wt, "HEAD"), head, "the commit stays for the next re-land");
  assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed", "gate:failed", "gate:failed"], "each attempt is priced");
  const warnings = readEvents(root).filter((e) => e.type === "warning").map((e) => String(e.message));
  assert.ok(
    warnings.some((m) => m.includes("gate check ran while the host slept 119s mid-run; the tree is unverified")),
    `the warning names the sleep; got: ${JSON.stringify(warnings)}`,
  );
  assert.ok(!warnings.some((m) => m.includes("flaky")), "a sleep is never mislabeled a flaky test");
  assert.ok(!warnings.some((m) => m.startsWith("build check failed")), "no test-failure headline");
});

// The pass-after-sleep wording: when the run that failed spanned a sleep and the re-run
// passed, the tree is fine and the sleep is the story — not a flaky test (BUGS.md 2026-09-30).
test("a slept pre-check failure that passes its re-run verifies the tree and names the sleep, not a flaky test", async () => {
  const flag = path.join(tmpdir(), "slept-twice");
  // Fails (with a sleep each time) until the second marker exists; the third attempt — the
  // gate's flake re-run — passes clean.
  const build = `if [ -f '${flag}-2' ]; then exit 0; fi; if [ -f '${flag}-1' ]; then touch '${flag}-2'; exit 1; fi; touch '${flag}-1'; exit 1`;
  const { root, wt } = await gateBuildFixture(build);
  const prompts = path.join(tmpdir(), "prompts.log");
  await withPi(
    `${logPromptsTo(prompts)}\n${reviewerStub()}`,
    async () => {
      const head = await headOf(wt, "HEAD");
      const { result } = await reviewGate(root, wt, {
        sampleSleep: scriptedSampler([
          woke(1_000), woke(121_000, 2_000), // attempt 1: slept, failed
          woke(121_000), woke(241_000, 122_000), // internal retry: slept too, failed
          woke(241_000), woke(241_500), // the gate's re-run: clean pass
        ]),
      });
      assert.equal(result.decision, "approved", "the clean re-run's pass verifies the tree");
      assert.equal(result.verifiedHead, head, "verified like a first-time pass");
      assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed", "gate:passed"]);
      const warnings = readEvents(root).filter((e) => e.type === "warning").map((e) => String(e.message));
      assert.deepEqual(warnings, [
        "gate check ran while the host slept 119s mid-run; then passed on retry",
      ]);
    },
  );
});
