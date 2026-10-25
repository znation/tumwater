import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { watchedBaseline, noteGreenBaseline } from "../src/baseline/main-baseline.js";
import { mainRedHealNote, mainRedHealPrompt, mainTipVerdict } from "../src/baseline/main-red.js";
import { queuedRolePrompts } from "../src/inbox/inbox.js";
import { isEligible } from "../src/scheduling/scheduling.js";
import { defaultConfig } from "../src/config/config.js";
import { readEvents } from "../src/events/event-read.js";
import { shortSha } from "../src/text/format.js";
import { eventsOfType, mainRedHolds } from "./fixtures/log-fixtures.js";
import { baselineFixture, fakeNpm, makeRoleRunner, runsOf } from "./fixtures/runner-fixtures.js";
import { pathReplace } from "./fakes/fake-commands.js";
import { gitOnlyBinDir, mainSha, makeRepo, sh, tmpdir, worktreeAt } from "./fixtures/repo-fixtures.js";

// Unit coverage for the red-main hand-off (src/baseline/main-red.ts): the policy layer on top
// of checkMainBaseline — what the ci healer's hand-off logs (one build_check per actual run,
// under the role that paid for it; one harness-level warning per newly-discovered red SHA) and
// mainTipVerdict's verdict arms. The red-main authoring block was removed with the pre-merge
// blocks (parts 3g/3–3j/3 and 3d/3–3f/3), so no code role is blocked on a red main. The
// underlying detection, execution, and per-SHA cache machinery is covered in build-check.test.ts.

const ROLE = "coverage"; // a code-producing maintenance role

test("mainRedHealNote hands the healer the failing script, headline, and output tail, warning once", async () => {
  const counter = path.join(tmpdir(), "runs");
  const script = `echo healer-failure-line; echo a-second-tail-line; echo run >> ${counter}; exit 1`;
  const { root, wt } = baselineFixture(ROLE, script);
  const restore = fakeNpm(script);
  try {
    const note = await mainRedHealNote(root, "ci", wt);
    assert.ok(note, "a red main yields a note for the healer");
    assert.match(note, /^<main-red>/);
    assert.match(note, /<\/main-red>$/);
    assert.ok(note.includes("test"), "names the failing script");
    assert.ok(note.includes("healer-failure-line"), "carries the failureHeadline line");
    assert.ok(note.includes("a-second-tail-line"), "carries the second output line in the tail block");
    assert.match(note, /Failing check output \(2 lines\)/);

    // The check ran once, priced under the healer; the team warning fired under "harness".
    assert.equal(runsOf(counter), 1);
    const events = readEvents(root);
    const checks = events.filter((e) => e.type === "build_check");
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.source, "ci");
    assert.equal(checks[0]?.scope, "baseline");
    assert.equal(checks[0]?.status, "failed");
    const holds = mainRedHolds(root);
    assert.equal(holds.length, 1, "one team-wide main_red_hold for the red SHA");
    assert.equal(holds[0]?.source, "tumwater");

    // A second reader on the same SHA still sees the red but does NOT add a second team-wide
    // warning: the healer's check and mainTipVerdict share the once-per-SHA guard. A red is
    // provisional per worktree, so the attribution re-runs the suite on its own mirror (the
    // runs counter grows) — but the hold is logged once.
    const verdict = await mainTipVerdict(root, ROLE, "main", defaultConfig());
    assert.ok(verdict.status === "red");
    assert.equal(mainRedHolds(root).length, 1, "a second reader adds no second main_red_hold");
  } finally {
    restore();
  }
});

test("mainRedHealNote yields no note on a green main", async () => {
  const counter = path.join(tmpdir(), "runs");
  const script = `echo green-healer >> ${counter}; exit 0`;
  const { root, wt } = baselineFixture(ROLE, script);
  const restore = fakeNpm(script);
  try {
    assert.equal(await mainRedHealNote(root, "ci", wt), undefined);
    assert.equal(runsOf(counter), 1, "the green check still ran once");
    assert.equal(eventsOfType(root, "warning").length, 0);
  } finally {
    restore();
  }
});

test("mainRedHealNote yields no note when no check is declared", async () => {
  const base = tmpdir("mainred-bugfix-none-");
  const root = makeRepo(path.join(base, "project"));
  const wt = worktreeAt(root, "bugfix");
  assert.equal(await mainRedHealNote(root, "ci", wt), undefined);
  assert.deepEqual(readEvents(root), [], "nothing to verify, nothing to say");
});

test("mainRedHealNote yields no note on an environmental skip (no npm)", async () => {
  const counter = path.join(tmpdir(), "runs");
  const script = `echo skip-healer >> ${counter}; exit 1`;
  const { root, wt } = baselineFixture(ROLE, script);
  // A PATH that keeps git but drops npm — the check cannot run, so it is not evidence of red.
  const partialBin = gitOnlyBinDir("no-npm-bugfix-");
  const restorePath = pathReplace(partialBin);
  try {
    assert.equal(await mainRedHealNote(root, "ci", wt), undefined);
    assert.equal(runsOf(counter), 0, "nothing ran");
    assert.equal(eventsOfType(root, "warning").length, 0);
  } finally {
    restorePath();
  }
});

// mainTipVerdict's never-throws contract (src/baseline/main-red.ts): an unreadable main must
// read as `unavailable` with a why, and never reject the verify pipeline with an exception — a
// corrupt or dangling ref is a broken repo, and the failure belongs in the rejection's reasons.
test("mainTipVerdict reports unavailable, without throwing, when main's ref dangles", async () => {
  const root = makeRepo();
  // Point main at a well-formed sha whose object does not exist: `git rev-parse` still
  // resolves it (a ref read needs no object database), but the gate's worktree add cannot
  // check it out and throws.
  fs.mkdirSync(path.join(root, ".tumwater", "worktrees"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${"deadbeef".repeat(5)}\n`);
  const verdict = await mainTipVerdict(root, ROLE, "main", defaultConfig());
  assert.equal(verdict.status, "unavailable");
  assert.ok(verdict.status === "unavailable" && verdict.why.includes('invalid reference'), verdict.status === "unavailable" ? verdict.why : "");
});

// mainTipVerdict's own verdict arms, pinned at the seam the review gate and the merge pipeline's
// attribution read. attribute-red-check.test.ts reaches green/red/no-check through the attribution
// step; these pin the function directly — including the two degradation arms no other test can
// reach: a skip (npm off PATH) and a main ref that resolves to nothing. The skip-vs-unverified
// precedence matters: a skipped check is an environmental miss, not evidence about main, and the
// why must say which (BUGS.md 2026-09-30, the attribution family that treated a slept run as the
// change's own verdict).

test("mainTipVerdict reports green at main's tip, priced under the asking role", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture(ROLE, `echo tip-green >> ${counter}; exit 0`);
  const restore = fakeNpm(`echo tip-green >> ${counter}; exit 0`);
  try {
    const verdict = await mainTipVerdict(root, ROLE, "main", defaultConfig());
    assert.deepEqual(verdict, { status: "green", sha: mainSha(root) });
    assert.equal(runsOf(counter), 1, "the tip's check ran once");
    const checks = eventsOfType(root, "build_check");
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.source, ROLE, "the run is priced under the role that asked");
    assert.equal(checks[0]?.scope, "baseline");
    assert.equal(checks[0]?.status, "passed");
  } finally {
    restore();
  }
});

test("mainTipVerdict reports red with the team-wide warning, once per SHA", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture(ROLE, `echo tip-failure; echo run >> ${counter}; exit 1`);
  const restore = fakeNpm(`echo tip-failure; echo run >> ${counter}; exit 1`);
  try {
    const verdict = await mainTipVerdict(root, ROLE, "main", defaultConfig());
    assert.ok(verdict.status === "red");
    assert.equal(verdict.status === "red" ? verdict.sha : "", mainSha(root));
    const sha = mainSha(root);
    const holds = mainRedHolds(root);
    assert.equal(holds.length, 1, "one main_red_hold for the newly-discovered red SHA");
    const message = holds[0] as { message?: string } | undefined;
    assert.match(message?.message ?? "", new RegExp(shortSha(sha)));
    assert.match(message?.message ?? "", /tip-failure/);

    // A second ask at the same tip reads the cached red: no second run, no second warning —
    // the same once-per-SHA guard the healer hand-off shares.
    const again = await mainTipVerdict(root, "feature", "main", defaultConfig());
    assert.ok(again.status === "red");
    assert.equal(runsOf(counter), 1, "the verdict is cached per SHA");
    assert.equal(mainRedHolds(root).length, 1);
  } finally {
    restore();
  }
});

test("mainTipVerdict reports the skip reason when the tip's check cannot run", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture(ROLE, `echo run >> ${counter}; exit 0`);
  // A PATH that keeps git (the worktree add needs it) but drops npm: the check cannot run,
  // so no verdict about main exists and the why must name the skip, not "no check".
  const partialBin = gitOnlyBinDir("no-npm-tipverdict-");
  const restorePath = pathReplace(partialBin);
  try {
    const verdict = await mainTipVerdict(root, ROLE, "main", defaultConfig());
    assert.ok(verdict.status === "unavailable");
    assert.match(verdict.status === "unavailable" ? verdict.why : "", /^its check was skipped \(no-npm\)$/);
    assert.equal(runsOf(counter), 0, "nothing ran — npm could not even start");
    // The skip is still logged (a skipped run is an outcome, priced under the asking role) —
    // it is just not a verdict about main.
    const checks = eventsOfType(root, "build_check");
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.status, "skipped");
    assert.equal(checks[0]?.source, ROLE);
  } finally {
    restorePath();
  }
});

test("mainTipVerdict reports unavailable when the named branch does not exist", async () => {
  const root = makeRepo();
  // A ref `git rev-parse` cannot resolve (no such branch): gitTry returns null, the gate's worktree
  // is never touched, and the why is the unreadable-main arm — distinct from the throw path the
  // dangling-ref test pins (an unresolvable ref is a caller or config bug, not a broken repo, but
  // neither may reject the verify pipeline with an exception).
  const verdict = await mainTipVerdict(root, ROLE, "no-such-branch", defaultConfig());
  assert.deepEqual(verdict, { status: "unavailable", why: "no-such-branch is unreadable" });
  assert.deepEqual(readEvents(root), [], "nothing ran, nothing to say");
});

test("mainTipVerdict runs the suite over a green inherited across doc commits, and reports its red", async () => {
  // A doc edit that breaks a test reading the docs (the shape test/backlog-structure.test.ts has
  // with the real PLANS.md): mainRedHealNote may carry main's green over it, but attribution
  // must not, or the change under judgment would be rejected for main's own failure.
  const counter = path.join(tmpdir(), "runs");
  const script = `echo run >> ${counter}; if [ -f BROKEN.md ]; then echo docs-broke-it; exit 1; fi`;
  const { root, wt } = baselineFixture(ROLE, script);
  const restore = fakeNpm(script);
  try {
    assert.equal(await mainRedHealNote(root, ROLE, wt), undefined, "the code commit is green");
    fs.writeFileSync(path.join(root, "BROKEN.md"), "x\n");
    sh(root, "git", "add", "BROKEN.md");
    sh(root, "git", "commit", "-m", "doc that breaks a docs test");
    sh(wt, "git", "reset", "--hard", "main");
    assert.equal(await mainRedHealNote(root, ROLE, wt), undefined, "the healer reads the green over the doc commit");
    assert.equal(runsOf(counter), 1, "without a run");
    const verdict = await mainTipVerdict(root, ROLE, "main", defaultConfig());
    assert.deepEqual(verdict, { status: "red", sha: mainSha(root) });
    assert.equal(runsOf(counter), 2, "attribution ran the suite on the tip itself");
  } finally {
    restore();
  }
});

// The healer handoff (PLANS.md 2026-10-19): a verified-red main discovered by any path other
// than ci's own run queues one ci prompt, so the healer becomes due on the next poll
// instead of waiting out its own interval or deferral. ci finding its own red (via
// mainRedHealNote) is the heal and queues nothing; green paths leave ci's inbox empty.

test("ci's own red-main note queues nothing and still returns the note and warning", async () => {
  const counter = path.join(tmpdir(), "runs");
  const script = `echo self-healer-failure; echo run >> ${counter}; exit 1`;
  const { root, wt } = baselineFixture(ROLE, script);
  const restore = fakeNpm(script);
  try {
    const note = await mainRedHealNote(root, "ci", wt);
    assert.ok(note, "the healer's own note still hands it the failure");
    assert.equal(queuedRolePrompts(root, "ci").length, 0, "ci finding its own red queues no second run");
    assert.equal(mainRedHolds(root).length, 1, "the team-wide warning still logs once");
  } finally {
    restore();
  }
});

test("mainRedHealPrompt returns one self-limiting line naming the short SHA", () => {
  const sha = "0123456789abcdef";
  const prompt = mainRedHealPrompt(sha);
  assert.ok(prompt.includes(shortSha(sha)), `prompt names the short SHA: ${prompt}`);
  assert.equal((prompt.match(/\n/g) ?? []).length, 0, "one line, no newlines");
  assert.match(prompt, /Verify main is green now/);
  assert.match(prompt, /if it is still red, reproduce the failure and land the fix/);
});

test("a queued healer prompt makes a ci runner due on the next poll despite a future clock", () => {
  // A fresh ci runner with a future nextRunAt, and a no_change
  // last result is not due on its own — but a non-empty inbox makes it due for reason "inbox"
  // before any interval, backoff, or deferral check (isEligible, scheduling.ts).
  const r = makeRoleRunner(makeRepo(), "ci");
  const now = Date.now();
  r.state.nextRunAt = now + 60 * 60 * 1000; // an hour out — not due on the clock
  r.state.lastRunEndedAt = now - 1000;
  r.state.lastResult = "no_change";
  r.state.recentOutcomes = "nnnn"; // a streak of empty runs, so yield scaling stretches the gap
  assert.deepEqual(isEligible(r, now, "abc", 1, {}), {
    run: true,
    reason: "inbox",
  });
});

test("watchedBaseline answers from the nearest first-parent ancestor holding a verdict, and null when none does", async () => {
  const { wt } = baselineFixture(ROLE, "exit 0");
  const commit = (name: string): string => {
    fs.writeFileSync(path.join(wt, `${name}.txt`), `${name} ${wt}\n`);
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-m", name);
    return sh(wt, "git", "rev-parse", "HEAD");
  };
  const checked = commit("watched-a");
  const middle = commit("watched-b");
  const tip = commit("watched-c");
  assert.equal(await watchedBaseline(wt), null, "no verdict anywhere below the tip reads as none");
  noteGreenBaseline(checked);
  assert.deepEqual(await watchedBaseline(wt), { status: "green", sha: checked }, "the walk skips unchecked commits");
  assert.deepEqual(await watchedBaseline(wt, middle), { status: "green", sha: checked });
  noteGreenBaseline(tip);
  assert.deepEqual(await watchedBaseline(wt), { status: "green", sha: tip }, "the tip's own verdict wins over an ancestor's");
});
