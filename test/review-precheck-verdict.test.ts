/** The review gate deciding alone, with no reviewer run: a failing build pre-check rejects with
 * zero pi runs, naming the script that ran and the failing assertion rather than the stack frame
 * its tail opens on; a configured check.command gates a repo with no npm install; a green
 * pre-check approves; and the gate's diff rules run in order, the gate scope keeping only the
 * three a later commit cannot repair. Part 3l/3 retired the pre-merge reviewer's dedicated
 * cases, so no case here drives a reviewer run. Split from review-precheck.test.ts (a red
 * main); the other sibling slices are review-precheck-green.test.ts (a green main or none),
 * review-precheck-closed.test.ts (a pre-check with no verdict about the tree fails closed) and
 * review-precheck-watch.test.ts (the attribution when the main watch verifies main). The
 * check's own unit tests live in build-check.test.ts; the shared scaffolding lives in
 * fixtures/gate-fixtures.ts and fixtures/precheck-fixtures.ts. */
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
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { commitIn, makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { piRanMarker, withPi } from "./fakes/fake-pi.js";
import { gateCtx, reviewGate, ROLE } from "./fixtures/gate-fixtures.js";
import { buildCheckEvents, gateBuildFixture, seedGreenMain } from "./fixtures/precheck-fixtures.js";

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
    // events; the gate command then passes at main's tip (BUGS.md 2026-10-06), so a third gate
    // event is priced there.
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed", "gate:passed"]);
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

test("a green pre-check approves with no reviewer run", async () => {
  // The pre-merge gate is deterministic (part 3h/3): a passing build pre-check approves
  // directly, with no model reviewer — the marker that a fake reviewer would touch stays
  // absent and no `review_start` is logged.
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool",
    "#!/bin/sh\necho ok\nexit 0\n",
  );
  const head = await headOf(wt, "HEAD");
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "approved");
    assert.equal(result.verifiedHead, head, "the green tree's head is handed to the merge path");
    assert.equal(state.lastApprovedHead, head, "the green head is recorded as approved");
    assert.ok(!fs.existsSync(marker), "no reviewer run at all");
    assert.deepEqual(eventsOfType(root, "review_start"), [], "no model review starts");
  });
});

test("a consumed abort overrides a green pre-check: the gate fails closed, not approved", async () => {
  // BUGS.md 2026-11-08 — the abort-then-merge tests flaked under load: a blocked check's wait
  // cap could expire green before the harness's abort kill landed, and the passing pre-check
  // approved the stopped change into the merge. A fired abort is authoritative: the gate must
  // fail closed even when the check's own subprocess finished green. An already-aborted signal
  // is deliberately NOT acted on at spawn (runScriptGroup), so a check granted a free permit
  // under it still runs and passes — exercising exactly the green-verdict-under-fired-signal
  // seam, not the killed-check `aborted` skip the gate already handled.
  const { root, wt } = await gateBuildFixture("buildcheck-tool", "#!/bin/sh\necho ok\nexit 0\n");
  const head = await headOf(wt, "HEAD");
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const state = freshRunnerState(ROLE);
    const controller = new AbortController();
    controller.abort();
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), signal: controller.signal }, state);
    assert.equal(result.decision, "failed", "a fired abort fails the merge closed, not approved");
    assert.equal(result.aborted, true, "the gate names the abort");
    assert.ok(!fs.existsSync(marker), "no reviewer run");
    assert.notEqual(state.lastApprovedHead, head, "the green head is not recorded as approved");
  });
});

test("a consumed abort overrides an excused pre-check too: a skipped check is not approved", async () => {
  // The same seam as the green case above, on the path that never reaches the passed branch: a
  // broken toolchain skips the check with no verdict about the tree, which the gate would
  // otherwise approve. A fired abort must stop the change here too, not only over a green.
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool",
    "#!/bin/sh\necho 'xcrun: error: unable to find utility' >&2\nexit 1\n",
  );
  const head = await headOf(wt, "HEAD");
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const state = freshRunnerState(ROLE);
    const controller = new AbortController();
    controller.abort();
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), signal: controller.signal }, state);
    assert.equal(result.decision, "failed", "a fired abort fails the merge closed, not approved");
    assert.equal(result.aborted, true, "the gate names the abort");
    assert.ok(!fs.existsSync(marker), "no reviewer run");
    assert.notEqual(state.lastApprovedHead, head, "the skipped head is not recorded as approved");
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
    const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false, "watch");
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
      const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false, "watch");
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
    const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false, "watch");
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
    const reasons = await diffRuleReasons(wt, briefBase, await changedFiles(wt, briefBase), "", false, "watch");
    assert.match(reasons[0] ?? "", /changes the brief between the tumwater:prompt markers/);
  }
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "PRINCIPLES.md"), "One principle.\n");
    commitIn(wt, "edits PRINCIPLES");
    const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), "", false, "watch");
    assert.deepEqual(reasons, [], "an unknown role is no basis for condemning a PRINCIPLES edit");
  }

  // backlog structure
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "BUGS.md"), "# Bugs\n\n## Open\n\nentry one\n\n## Open\n\nentry two\n");
    commitIn(wt, "duplicates a section");
    const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false, "watch");
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
    const reasons = await diffRuleReasons(wt, base, mdOnly, ROLE, true, "watch");
    assert.match(reasons[0] ?? "", /noSuchSymbolOnTree/);
    fs.writeFileSync(path.join(wt, "app.ts"), "export {};\n");
    commitIn(wt, "adds code beside the claim");
    const reasons2 = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false, "watch");
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
      const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false, "watch");
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
    const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false, "watch");
    assert.deepEqual(reasons, []);
  }
});

// Part 3m/3 narrowed the gate to the three findings a later commit cannot repair (a brief-block
// edit, a protected edit and a leaked credential); the other three — a conflict marker, a false
// fix claim and a broken backlog structure — are repairable by a later commit, so they stop
// refusing a diff pre-merge and the main watch reports them on main's tip instead.
test("the gate scope runs only the three unrepairable rules", async () => {
  const changedFiles = async (wt: string, base: string): Promise<string[]> =>
    (await treeDiffFiles(wt, base, await headOf(wt, "HEAD"))) ?? [];

  // a conflict marker and a false-fix claim on an exempt diff: the gate passes them ([]) while
  // the watch reports the conflict marker (which precedes the false-fix rule in watch order)
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "app.ts"), "const a = 1;\n<<<<<<< HEAD\n");
    fs.writeFileSync(
      path.join(wt, "BUGS.md"),
      "# Bugs\n\n## Open\n\n_None yet._\n\n## Fixed\n\n### Phantom bug (found 2026-10-01; fixed 2026-10-18)\n\n**Fix:** `noSuchSymbolOnTree` was added.\n",
    );
    commitIn(wt, "leaves a conflict marker and claims a phantom fix");
    const files = await changedFiles(wt, base);
    assert.deepEqual(
      await diffRuleReasons(wt, base, files, ROLE, true, "gate"),
      [],
      "the gate lets a conflict marker and a false-fix claim land for the watch to report",
    );
    assert.match(
      (await diffRuleReasons(wt, base, files, ROLE, true, "watch"))[0] ?? "",
      /conflict markers remain in: app\.ts/,
      "the watch still reports the conflict marker",
    );
  }

  // a brief-block edit and a secret leak are found under both scopes
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const brief = "# T\n\n<!-- tumwater:prompt:start -->\nthe prompt\n<!-- tumwater:prompt:end -->\n\n## Status\n\nold\n";
    fs.writeFileSync(path.join(wt, "README.md"), brief);
    commitIn(wt, "adds a brief");
    const briefBase = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "README.md"), brief.replace("the prompt", "other"));
    commitIn(wt, "changes the brief");
    for (const scope of ["gate", "watch"] as const) {
      const reasons = await diffRuleReasons(wt, briefBase, await changedFiles(wt, briefBase), ROLE, true, scope);
      assert.match(reasons[0] ?? "", /changes the brief between the tumwater:prompt markers/, scope);
    }
    process.env.TUMWATER_TEST_SECRET = "gate-scope-secret-7777777";
    try {
      const root2 = makeRepo();
      const wt2 = await ensureWorktree(root2, ROLE, "main");
      const base2 = await headOf(wt2, "HEAD");
      fs.writeFileSync(path.join(wt2, "dump.txt"), "leak gate-scope-secret-7777777\n");
      commitIn(wt2, "leaks a secret");
      for (const scope of ["gate", "watch"] as const) {
        const reasons = await diffRuleReasons(wt2, base2, await changedFiles(wt2, base2), ROLE, false, scope);
        assert.match(reasons[0] ?? "", /contains the value of \$TUMWATER_TEST_SECRET/, scope);
      }
    } finally {
      delete process.env.TUMWATER_TEST_SECRET;
    }
  }
});
