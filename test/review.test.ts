import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reviewAheadOfMain, reviewRetryDelayMs } from "../src/review/review.js";
import { aheadOfMain } from "../src/git/git.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { defaultConfig } from "../src/config/config.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { makeRepo, sh } from "./fixtures/repo-fixtures.js";
import { piRanMarker, withPi } from "./fakes/fake-pi.js";
import { errnoError, patchFsMethod } from "./helpers/fs-faults.js";
import { gateCtx, gateFixture, reviewGate, ROLE } from "./fixtures/gate-fixtures.js";

// Regression coverage for the 2026-08-27 build break (BUGS.md): src/review/review.ts shipped with a
// syntax error and latent type errors and had zero tests, so nothing caught it; importing
// review.js still fails `npm test` if this file stops compiling again. The gate-orchestration
// section drives the real reviewAheadOfMain end-to-end against a git repo with a fake pi on
// PATH, covering the gate's deterministic reject and no-run branches (part 3l/3 retired the
// reviewer-run cases); the parser's own
// cases live in review-verdict.test.ts (exemption matching in exemptions.test.ts). The gate's
// build pre-check slice lives in review-precheck.test.ts (extracted 2026-09-29); both files
// share the scaffolding in fixtures/gate-fixtures.ts.


// ── Gate orchestration (reviewAheadOfMain) ────────────────────────────────────────────────
// Each fixture is a real git repo whose worktree sits one commit ahead of main, with a fake pi
// on PATH. A marker file OUTSIDE the worktree records whether the reviewer ran at all (so "no
// run" branches are asserted, not merely assumed).

test("the review retry delay falls back to the default on a malformed TUMWATER_REVIEW_RETRY_DELAY_MS", () => {
  // The knob is read through the plain-decimal rule, so a spelling Number() would silently
  // coerce ("0x1f0" → 496, "1e3" → 1000) or yield NaN ("abc") falls back to the 30 s default
  // instead of firing the retries back-to-back at ~0 ms; only the context override is 0 in the
  // gate tests (gateCtx sets retryDelayMs), so this env path is dead without direct coverage.
  const prior = process.env.TUMWATER_REVIEW_RETRY_DELAY_MS;
  try {
    delete process.env.TUMWATER_REVIEW_RETRY_DELAY_MS;
    assert.equal(reviewRetryDelayMs(undefined), 30_000, "absent knob uses the default");
    for (const malformed of ["abc", "0x1f0", "1e3", " 30000 "]) {
      process.env.TUMWATER_REVIEW_RETRY_DELAY_MS = malformed;
      assert.equal(reviewRetryDelayMs(undefined), 30_000, `${malformed} is not plain decimal, so it falls back`);
    }
    process.env.TUMWATER_REVIEW_RETRY_DELAY_MS = "0";
    assert.equal(reviewRetryDelayMs(undefined), 0, "0 is a valid retry delay");
    process.env.TUMWATER_REVIEW_RETRY_DELAY_MS = "30000";
    assert.equal(reviewRetryDelayMs(undefined), 30_000, "a plain decimal is honored");
    assert.equal(reviewRetryDelayMs(500), 500, "the context override wins over the env");
  } finally {
    if (prior === undefined) delete process.env.TUMWATER_REVIEW_RETRY_DELAY_MS;
    else process.env.TUMWATER_REVIEW_RETRY_DELAY_MS = prior;
  }
});


test("gate exempts a doc-only diff without running pi", async () => {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.mkdirSync(path.join(wt, "docs"), { recursive: true });
  fs.writeFileSync(path.join(wt, "docs", "notes.md"), "a doc\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "doc only");
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
      const { state, result } = await reviewGate(root, wt);
      assert.equal(result.decision, "exempt");
      assert.ok(!fs.existsSync(marker)); // no reviewer run at all
      assert.equal(state.lastApprovedHead, undefined);
  });
});

/** A deterministic gate rejection: commit `content` as `file` in a fresh repo, run the gate
 * under a pi shim that would create `piRanMarker()` if the reviewer ran, and assert the
 * rejection carried every `detailMatch` while pi never ran. The conflict-marker and
 * misfiled-plan tests share this shape because their rejections must be decided before any
 * reviewer run. */
async function assertRejectedWithoutReview(
  file: string,
  content: string,
  message: string,
  ...detailMatches: RegExp[]
): Promise<void> {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(path.join(wt, file), content);
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", message);
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected");
    for (const detail of detailMatches) assert.match(result.detail!, detail);
    assert.ok(!fs.existsSync(marker), "deterministic rejection — no reviewer run at all");
  });
}

test("gate rejects a change that still holds conflict markers, with no pi run", async () => {
  // A change handed back to its author with the markers left in place (PLANS.md "Robust
  // conflict landing, part 2/2") reaches the gate if the author's stage fix-up turn did not
  // clear them. An md-only diff skips the reviewer by design, so only a deterministic check
  // can stop raw `<<<<<<<` lines from being merged to main.
  await assertRejectedWithoutReview(
    "notes.md",
    "before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\nafter\n",
    "doc change with markers left in",
    /conflict markers remain in: notes\.md/,
  );
});

test("gate rejects a change whose changed file cannot be read for conflict markers, with no pi run", async () => {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(path.join(wt, "notes.md"), "no markers here\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "doc change");
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const undo = patchFsMethod("readFileSync", (orig) => (...args) => {
      if (String(args[0]).startsWith(wt) && String(args[0]).endsWith("/notes.md")) throw errnoError("EMFILE");
      return orig(...args);
    });
    try {
      const { result } = await reviewGate(root, wt);
      assert.equal(result.decision, "rejected");
      assert.match(result.detail!, /could not be read to check for conflict markers: notes\.md/);
    } finally {
      undo();
    }
    assert.ok(!fs.existsSync(marker), "deterministic rejection — no reviewer run at all");
  });
});

test("gate rejects conflict markers in a non-ASCII-named file (git C-quotes the diff path)", async () => {
  // `git diff --name-only` C-quotes non-ASCII paths by default; if aheadOfMainFiles hands the
  // gate that quoted text, hasConflictMarkers reads a path that does not exist and returns
  // false, so a marker-bearing non-ASCII file slips through the same way a plain-named one did.
  await assertRejectedWithoutReview(
    "héllo.md",
    "before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\nafter\n",
    "non-ASCII doc change with markers left in",
    /conflict markers remain in: héllo\.md/,
  );
});

test("gate rejects an md-only diff that files a new plan directly under ## Done, with no pi run", async () => {
  // The 2026-09-25 shape (PLANS.md 9eaae5ac, plans part 4/4): a plan written straight into
  // the done section. The heading-set check cannot see it — one ## Done, heading set unchanged
  // — so the new-plan-under-Done rule is what rejects it, deterministically, before any
  // reviewer run.
  await assertRejectedWithoutReview(
    "PLANS.md",
    "## Planned\n\n## Done\n\n### Feature B (planned 2026-09-26)\n\n**Goal.** New work.\n",
    "misfiled plan",
    /PLANS\.md files "Feature B \(planned 2026-09-26\)"/,
    /file it under "## Planned"/,
  );
});

test("gate is a no-op when review.enabled is false", async () => {
  const { root, wt } = await gateFixture(); // code change — would be reviewed if enabled
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
      const config = defaultConfig();
      config.review.enabled = false;
      const { result } = await reviewGate(root, wt, { config });
      assert.equal(result.decision, "exempt");
      assert.ok(!fs.existsSync(marker));
  });
});

test("gate skips the run when this exact HEAD was already approved", async () => {
  const { root, wt, head } = await gateFixture();
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
      const state = freshRunnerState(ROLE);
      state.lastApprovedHead = head; // e.g. a merge_blocked retry of the same commit
      const result = await reviewAheadOfMain(gateCtx(root, wt), state);
      assert.equal(result.decision, "approved");
      assert.ok(!fs.existsSync(marker)); // no second reviewer run for the same HEAD
  });
});

test("gate runs no reviewer on a shutdown, leaving the commit and no reject bookkeeping", async () => {
  // The abort path itself (a pre-check stopped by the verify's signal fails closed as
  // aborted) is covered in review-precheck.test.ts; this case holds the gate-orchestration
  // invariants that survive a shutdown: no reviewer run starts, the commit stays, and no
  // rejection bookkeeping is written.
  const { root, wt } = await gateFixture();
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const controller = new AbortController();
    controller.abort(); // harness shutdown already in progress
    const { state, result } = await reviewGate(root, wt, { signal: controller.signal });
    assert.notEqual(result.decision, "rejected", "a shutdown is not judged against the author");
    assert.ok(!fs.existsSync(marker), "no reviewer run at all on a shutdown");
    assert.equal(await aheadOfMain(wt, "main"), 1); // the commit stays; the resumed run re-reviewes it
    assert.equal(state.lastReview, undefined); // no reject bookkeeping on the shutdown
    assert.equal(state.unreviewFailures, undefined);
  });
});

/** A repo whose main carries `base` files, plus the ROLE worktree with `edit` committed on top. */
async function protectedEditRepo(base: Record<string, string>, edit: Record<string, string>) {
  const root = makeRepo();
  for (const [f, c] of Object.entries(base)) fs.writeFileSync(path.join(root, f), c);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "base");
  const wt = await ensureWorktree(root, ROLE, "main");
  for (const [f, c] of Object.entries(edit)) fs.writeFileSync(path.join(wt, f), c);
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "edit");
  return { root, wt };
}

const PROMPT_README = (body: string) =>
  `# T\n\n<!-- tumwater:prompt:start -->\n${body}\n<!-- tumwater:prompt:end -->\n`;

test("gate rejects an md-only edit to the brief text block with no pi run", async () => {
  const { root, wt } = await protectedEditRepo(
    { "README.md": PROMPT_README("original") },
    { "README.md": PROMPT_README("rewritten") },
  );
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected");
    assert.match(result.detail!, /README\.md changes the brief/);
    assert.ok(!fs.existsSync(marker), "deterministic rejection — no reviewer run at all");
  });
});

test("gate rejects an md-only PRINCIPLES.md edit except from the steward", async () => {
  const { root, wt } = await protectedEditRepo({ "PRINCIPLES.md": "# P\n" }, { "PRINCIPLES.md": "# P\n- new\n" });
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected");
    assert.match(result.detail!, /PRINCIPLES\.md is edited by the improve role/);
    assert.ok(!fs.existsSync(marker));
    const steward = await reviewGate(root, wt, { role: "steward" });
    assert.equal(steward.result.decision, "exempt");
  });
});

test("gate rejects an md-only change that writes a secret env value, with no pi run", async () => {
  const value = "tw-secret-value-0123456789";
  const { root, wt } = await protectedEditRepo({ "NOTES.md": "# N\n" }, { "NOTES.md": `# N\n${value}\n` });
  const marker = piRanMarker();
  process.env.TUMWATER_TEST_FAKE_TOKEN = value;
  try {
    await withPi(`touch '${marker}'`, async () => {
      const { result } = await reviewGate(root, wt);
      assert.equal(result.decision, "rejected");
      assert.match(result.detail!, /`NOTES\.md` contains the value of \$TUMWATER_TEST_FAKE_TOKEN/);
      assert.ok(!result.detail!.includes(value));
      assert.ok(!fs.existsSync(marker), "deterministic rejection — no reviewer run at all");
    });
  } finally {
    delete process.env.TUMWATER_TEST_FAKE_TOKEN;
  }
});
