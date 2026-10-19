import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bugfixMainRedNote, mainRedGate, mainRedHealPrompt, mainTipVerdict } from "../src/baseline/main-red.js";
import { queuedRolePrompts } from "../src/inbox/inbox.js";
import { isEligible } from "../src/scheduling/scheduling.js";
import { defaultConfig } from "../src/config/config.js";
import { readEvents } from "../src/events/event-read.js";
import { shortSha } from "../src/text/format.js";
import { eventsOfType, mainRedHolds, warningEvents } from "./fixtures/log-fixtures.js";
import { baselineFixture, fakeNpm, makeLoopRunner, runsOf } from "./fixtures/runner-fixtures.js";
import { pathReplace } from "./fakes/fake-commands.js";
import { gitOnlyBinDir, mainSha, makeRepo, sh, tmpdir, worktreeAt } from "./fixtures/repo-fixtures.js";
import { scriptedSampler, woke } from "./helpers/sleep-clock.js";

// Unit coverage for the red-main baseline gate (src/baseline/main-red.ts): the policy layer on top
// of
// checkMainBaseline — which roles it blocks, what it logs (one build_check per actual run,
// under the role that paid for it; one harness-level warning per newly-discovered red SHA),
// and its warn-and-proceed semantics for environmental skips. The underlying detection,
// execution, and per-SHA cache machinery is covered in build-check.test.ts.

const ROLE = "coverage"; // a BASELINE_BLOCKED_ROLES member (code-producing)

test("mainRedGate lets a non-blocked role through without running the check", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);
  const restore = fakeNpm(`echo run >> ${counter}; exit 0`);
  try {
    // A bookkeeping role is never gated: no check runs and nothing is logged — even though
    // main would be red for the code roles.
    const blocked = await mainRedGate(root, "steward", wt);
    assert.equal(blocked, null);
    assert.equal(runsOf(counter), 0, "the baseline check never ran");
    assert.deepEqual(readEvents(root), [], "no events for an ungated role");
  } finally {
    restore();
  }
});

test("mainRedGate proceeds on a green main and prices the run under the role", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo ok >> ${counter}; exit 0`);
  const restore = fakeNpm(`echo ok >> ${counter}; exit 0`);
  try {
    assert.equal(await mainRedGate(root, ROLE, wt), null, "green main never blocks authoring");
    assert.equal(runsOf(counter), 1, "the check ran once for the SHA");
    const events = readEvents(root);
    assert.equal(events.length, 1, "one build_check event, no warnings");
    const check = events[0];
    assert.ok(check);
    assert.equal(check.type, "build_check");
    assert.equal(check.source, ROLE, "priced under the role that paid for it");
    assert.equal(check.scope, "baseline", "distinguished from the review gate's pre-check");
    assert.equal(check.status, "passed");
    assert.equal(check.script, "test");
    assert.ok((check as { durationMs?: number }).durationMs! >= 0);
  } finally {
    restore();
  }
});

test("mainRedGate blocks a red main with the terminal outcome and a harness-level warning", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo baseline-failure; echo run >> ${counter}; exit 1`);
  const restore = fakeNpm(`echo baseline-failure; echo run >> ${counter}; exit 1`);
  try {
    const blocked = await mainRedGate(root, ROLE, wt);
    // The cause rides the outcome (BUGS.md 2026-09-28): the tick's run_end must be able to
    // name what broke, not leave the digest's main_red cells a bare count.
    const sha = mainSha(root);
    assert.deepEqual(blocked, {
      result: "main_red",
      summary: "code merges blocked until main is green",
      error: `main ${shortSha(sha)} is red (test: baseline-failure) — authoring skipped until main is green`,
    });

    const events = readEvents(root);
    const checks = events.filter((e) => e.type === "build_check");
    assert.equal(checks.length, 1);
    const check = checks[0];
    assert.ok(check);
    assert.equal(check.source, ROLE);
    assert.equal(check.status, "failed");
    assert.equal(check.script, "test");

    const holds = mainRedHolds(root);
    assert.equal(holds.length, 1, "one main_red_hold for the newly-discovered red SHA");
    const warning = holds[0];
    assert.ok(warning);
    assert.equal(warning.source, "tumwater", "team-wide, not per role");
    assert.equal(warning.sha, sha);
    assert.equal(warning.script, "test");
    assert.equal(warningEvents(events).length, 0, "no generic warning for the red SHA");
    const message = warning as { message?: string };
    assert.ok(message.message?.includes(shortSha(sha)), `warning names the red SHA: ${message.message}`);
    assert.ok(message.message?.includes("test"), "warning names the failing script");
    assert.ok(message.message?.includes("baseline-failure"), "warning carries the failure's first line");
  } finally {
    restore();
  }
});

test("mainRedGate warns once per red SHA: a repeat tick on the same HEAD re-blocks silently", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);
  const restore = fakeNpm(`echo run >> ${counter}; exit 1`);
  try {
    assert.equal((await mainRedGate(root, ROLE, wt))?.result, "main_red");
    // A second blocked role waking on the same SHA (or the same role's next tick) must not
    // re-run the suite or re-log the team-wide warning.
    const again = await mainRedGate(root, "feature", wt);
    assert.equal(again?.result, "main_red");
    assert.equal(runsOf(counter), 1, "the verdict is cached per SHA — no second run");
    const holds = mainRedHolds(root);
    assert.equal(holds.length, 1, "one main_red_hold for the red SHA, not one per blocked tick");
    // The red discovery by a non-bugfix path queues exactly one healer prompt naming the
    // short SHA; the second blocked role on the same SHA adds no second prompt.
    const prompts = queuedRolePrompts(root, "bugfix");
    assert.equal(prompts.length, 1, "one healer prompt per newly-verified red SHA");
    assert.ok(prompts[0]?.includes(shortSha(mainSha(root))), `prompt names the red SHA: ${prompts[0]}`);
  } finally {
    restore();
  }
});

test("mainRedGate blocks a user-defined loop on red main like the code roles", async () => {
  // A custom's charter may produce code, so it is blocked exactly like feature/improve
  // (plans/user-defined-loops.md). Customs come from tumwater.json, not the catalog — declare
  // one in the fixture repo before the gate reads the live config.
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);
  fs.writeFileSync(
    path.join(root, "tumwater.json"),
    JSON.stringify({ customRoles: [{ name: "docs-auditor", task: "Keep the docs current." }] }),
  );
  const restore = fakeNpm(`echo run >> ${counter}; exit 1`);
  try {
    assert.equal(
      (await mainRedGate(root, "docs-auditor", wt))?.result,
      "main_red",
      "a custom loop's fresh tick on red main is blocked like feature's",
    );
    // The check ran once under the role that paid for it — same pricing as a built-in.
    assert.equal(runsOf(counter), 1);
    const checks = eventsOfType(root, "build_check");
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.source, "docs-auditor");
    // A role that is neither in the catalog nor in customRoles still passes through ungated.
    assert.equal(await mainRedGate(root, "not-a-role", wt), null);
  } finally {
    restore();
  }
});

test("mainRedGate warns under the role and proceeds when npm is missing", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);

  // A PATH that keeps git (the helper keys by HEAD) but drops npm — the real-world shape of a
  // machine without node. The skip must warn and proceed, never block authoring.
  const partialBin = gitOnlyBinDir("no-npm-");
  const restorePath = pathReplace(partialBin);
  try {
    assert.equal(await mainRedGate(root, ROLE, wt), null, "an environmental skip never blocks");
    assert.equal(runsOf(counter), 0, "nothing ran — npm could not even start");

    const events = readEvents(root);
    const checks = events.filter((e) => e.type === "build_check");
    assert.equal(checks.length, 1);
    const check = checks[0];
    assert.ok(check);
    assert.equal(check.status, "skipped");
    assert.equal(check.source, ROLE);
    const warnings = warningEvents(events);
    assert.equal(warnings.length, 1);
    const warning = warnings[0];
    assert.ok(warning);
    assert.equal(warning.source, ROLE, "the skip is warned under the role that hit it");
    assert.ok(
      (warning as { message?: string }).message?.includes("no npm on PATH"),
      `skip reason in warning: ${(warning as { message?: string }).message}`,
    );
  } finally {
    restorePath();
  }
});

// The baseline's timeout warning names the bound the run was armed with — a configured
// command's own timeoutSeconds — not the npm default: pre-fix it always said "300s" (BUGS.md
// 2026-09-21, the warning that named a bound the check did not run under). The event carries
// the armed bound too, beside how late the deadline fired.
test("mainRedGate's timeout warning names the bound the baseline check actually ran under", async () => {
  const { root, wt } = baselineFixture(ROLE, "echo baseline-timeout-bound; exit 0");
  fs.writeFileSync(
    path.join(root, "tumwater.json"),
    JSON.stringify({ check: { command: "sleep 30", timeoutSeconds: 0.5 } }),
  );
  assert.equal(await mainRedGate(root, ROLE, wt), null, "a timed-out baseline never blocks authoring");
  const events = readEvents(root);
  const check = events.find((e) => e.type === "build_check");
  assert.equal(check?.status, "skipped");
  assert.equal(check?.timeoutMs, 500, "the event names the armed bound");
  assert.equal(typeof check?.deadlineLateMs, "number");
  const warning = events.find((e) => e.type === "warning");
  assert.equal(
    warning?.message,
    "main baseline check timed out after 0.5s; proceeding with authoring unverified",
  );
});

test("bugfixMainRedNote hands the healer the failing script, headline, and output tail, warning once", async () => {
  const counter = path.join(tmpdir(), "runs");
  const script = `echo healer-failure-line; echo a-second-tail-line; echo run >> ${counter}; exit 1`;
  const { root, wt } = baselineFixture(ROLE, script);
  const restore = fakeNpm(script);
  try {
    const note = await bugfixMainRedNote(root, "bugfix", wt);
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
    assert.equal(checks[0]?.source, "bugfix");
    assert.equal(checks[0]?.scope, "baseline");
    assert.equal(checks[0]?.status, "failed");
    const holds = mainRedHolds(root);
    assert.equal(holds.length, 1, "one team-wide main_red_hold for the red SHA");
    assert.equal(holds[0]?.source, "tumwater");

    // A blocked role on the same SHA still reads the cached red and does NOT add a second
    // warning: the healer's check and the gate share the once-per-SHA guard.
    const blocked = await mainRedGate(root, "feature", wt);
    assert.equal(blocked?.result, "main_red");
    assert.equal(runsOf(counter), 1, "the cached verdict was reused — no second run");
    assert.equal(
      mainRedHolds(root).length,
      1,
      "the healer's check did not add a second main_red_hold",
    );
  } finally {
    restore();
  }
});

test("bugfixMainRedNote yields no note on a green main", async () => {
  const counter = path.join(tmpdir(), "runs");
  const script = `echo green-healer >> ${counter}; exit 0`;
  const { root, wt } = baselineFixture(ROLE, script);
  const restore = fakeNpm(script);
  try {
    assert.equal(await bugfixMainRedNote(root, "bugfix", wt), undefined);
    assert.equal(runsOf(counter), 1, "the green check still ran once");
    assert.equal(eventsOfType(root, "warning").length, 0);
  } finally {
    restore();
  }
});

test("bugfixMainRedNote yields no note when no check is declared", async () => {
  const base = tmpdir("mainred-bugfix-none-");
  const root = makeRepo(path.join(base, "project"));
  const wt = worktreeAt(root, "bugfix");
  assert.equal(await bugfixMainRedNote(root, "bugfix", wt), undefined);
  assert.deepEqual(readEvents(root), [], "nothing to verify, nothing to say");
});

test("bugfixMainRedNote yields no note on an environmental skip (no npm)", async () => {
  const counter = path.join(tmpdir(), "runs");
  const script = `echo skip-healer >> ${counter}; exit 1`;
  const { root, wt } = baselineFixture(ROLE, script);
  // A PATH that keeps git but drops npm — the check cannot run, so it is not evidence of red.
  const partialBin = gitOnlyBinDir("no-npm-bugfix-");
  const restorePath = pathReplace(partialBin);
  try {
    assert.equal(await bugfixMainRedNote(root, "bugfix", wt), undefined);
    assert.equal(runsOf(counter), 0, "nothing ran");
    assert.equal(eventsOfType(root, "warning").length, 0);
  } finally {
    restorePath();
  }
});

test("mainRedGate proceeds silently when no build check is declared", async () => {
  const base = tmpdir("mainred-none-");
  const root = makeRepo(path.join(base, "project"));
  const wt = worktreeAt(root, ROLE);

  // Nothing to verify → nothing to block on, and no warning: a missing check is not an
  // environmental skip.
  assert.equal(await mainRedGate(root, ROLE, wt), null);
  assert.deepEqual(readEvents(root), [], "no events when there is no declared check");
});

// The gate's never-throws contract (src/baseline/main-red.ts): an unreadable main must read as
// `unavailable` with a why, never reject the verify pipeline with an exception — a corrupt or
// dangling ref is a broken repo, and the failure belongs in the rejection's reasons.
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

// BUGS.md 2026-09-30: a FAILED baseline run the host slept through is no verdict about main —
// the gate warns under the role, naming the sleep, and proceeds with authoring; nothing is
// cached, so the next consult re-runs and a clean attempt settles the SHA.
test("mainRedGate proceeds unverified when the baseline run spanned a host sleep", async () => {
  const { root, wt } = baselineFixture(ROLE, "echo baseline-failure; exit 1");
  // The first attempt sleeps and owes one clean retry; the retry sleeps too, so it stands.
  const slept = scriptedSampler([
    woke(1_000),
    woke(121_000, 2_000),
    woke(121_000),
    woke(241_000, 122_000),
  ]);
  assert.equal(await mainRedGate(root, ROLE, wt, slept), null, "a slept baseline run never blocks authoring");
  const events = readEvents(root);
  assert.equal(events.filter((e) => e.type === "build_check").length, 2, "both attempts are priced");
  const check = events.filter((e) => e.type === "build_check").at(-1);
  assert.equal(check?.status, "failed");
  assert.equal(check?.sleptMs, 119_000, "the event carries the measured sleep");
  const warning = events.find((e) => e.type === "warning" && e.source === ROLE);
  assert.match(
    String(warning?.message ?? ""),
    /main baseline check ran while the host slept 119s mid-run; proceeding with authoring unverified/,
  );

  // Nothing was cached from the slept run: the next gate re-runs, and the clean attempt's
  // red is a real red — main_red, as always.
  const clean = scriptedSampler([woke(1_000), woke(1_500)]);
  assert.equal((await mainRedGate(root, ROLE, wt, clean))?.result, "main_red");
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
    // the same once-per-SHA guard the authoring gate shares.
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
  // with the real PLANS.md): the red-main gate may carry main's green over it, but attribution
  // must not, or the change under judgment would be rejected for main's own failure.
  const counter = path.join(tmpdir(), "runs");
  const script = `echo run >> ${counter}; if [ -f BROKEN.md ]; then echo docs-broke-it; exit 1; fi`;
  const { root, wt } = baselineFixture(ROLE, script);
  const restore = fakeNpm(script);
  try {
    assert.equal(await mainRedGate(root, ROLE, wt), null, "the code commit is green");
    fs.writeFileSync(path.join(root, "BROKEN.md"), "x\n");
    sh(root, "git", "add", "BROKEN.md");
    sh(root, "git", "commit", "-m", "doc that breaks a docs test");
    sh(wt, "git", "reset", "--hard", "main");
    assert.equal(await mainRedGate(root, ROLE, wt), null, "the gate carries the green over the doc commit");
    assert.equal(runsOf(counter), 1, "without a run");
    const verdict = await mainTipVerdict(root, ROLE, "main", defaultConfig());
    assert.deepEqual(verdict, { status: "red", sha: mainSha(root) });
    assert.equal(runsOf(counter), 2, "attribution ran the suite on the tip itself");
    assert.equal((await mainRedGate(root, ROLE, wt))?.result, "main_red", "the observed red now blocks authoring");
  } finally {
    restore();
  }
});

// The healer handoff (PLANS.md 2026-10-19): a verified-red main discovered by any path other
// than bugfix's own tick queues one bugfix prompt, so the healer becomes due on the next poll
// instead of waiting out its own interval or deferral. bugfix finding its own red (via
// bugfixMainRedNote) is the heal and queues nothing; green, non-blocked, and bugfix-own paths
// all leave bugfix's inbox empty.

test("bugfix's own red-main note queues nothing and still returns the note and warning", async () => {
  const counter = path.join(tmpdir(), "runs");
  const script = `echo self-healer-failure; echo run >> ${counter}; exit 1`;
  const { root, wt } = baselineFixture(ROLE, script);
  const restore = fakeNpm(script);
  try {
    const note = await bugfixMainRedNote(root, "bugfix", wt);
    assert.ok(note, "the healer's own note still hands it the failure");
    assert.equal(queuedRolePrompts(root, "bugfix").length, 0, "bugfix finding its own red queues no second run");
    assert.equal(mainRedHolds(root).length, 1, "the team-wide warning still logs once");
  } finally {
    restore();
  }
});

test("green main and a non-blocked role leave bugfix's inbox empty", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo ok >> ${counter}; exit 0`);
  const restore = fakeNpm(`echo ok >> ${counter}; exit 0`);
  try {
    assert.equal(await mainRedGate(root, ROLE, wt), null, "green main never blocks");
    assert.equal(queuedRolePrompts(root, "bugfix").length, 0, "no red, no healer prompt");
    assert.equal(await mainRedGate(root, "steward", wt), null, "non-blocked role passes through");
    assert.equal(queuedRolePrompts(root, "bugfix").length, 0, "a non-blocked role never queues the healer");
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

test("a queued healer prompt makes a bugfix runner due on the next poll despite a future clock", () => {
  // A fresh bugfix runner with an empty BUGS.md backlog, a future nextRunAt, and a no_change
  // last result is not due on its own — but a non-empty inbox makes it due for reason "inbox"
  // before any interval, backoff, or deferral check (isEligible, scheduling.ts).
  const r = makeLoopRunner(makeRepo(), "bugfix");
  const now = Date.now();
  r.state.nextRunAt = now + 60 * 60 * 1000; // an hour out — not due on the clock
  r.state.lastRunEndedAt = now - 1000;
  r.state.lastResult = "no_change";
  r.state.recentOutcomes = "nnnn"; // a streak of empty ticks, so yield scaling stretches the gap
  assert.deepEqual(isEligible(r, now, "abc", 1, {}), {
    run: true,
    reason: "inbox",
  });
});

test("mainRedGate lets a role run on a red main that names its failing tests, once per failing set", async () => {
  const script = `echo '✖ known-red-alpha (1.2ms)'; echo '✖ known-red-beta (0.4ms)'; exit 1`;
  const { root, wt } = baselineFixture(ROLE, script);
  const restore = fakeNpm(script);
  try {
    let known: string[] | undefined;
    const blocked = await mainRedGate(root, ROLE, wt, undefined, (t) => (known = t));
    assert.equal(blocked, null, "named failures do not end the run main_red");
    assert.deepEqual(known, ["known-red-alpha", "known-red-beta"]);
    const holds = mainRedHolds(root);
    assert.equal(holds.length, 1);
    const message = (holds[0] as { message?: string }).message ?? "";
    assert.ok(message.includes("(2 failing tests); changes that add no new failures still merge"), message);
    assert.equal(queuedRolePrompts(root, "bugfix").length, 1, "the healer is told once");

    // A second red commit with the same failing set sends no second heal prompt.
    sh(root, "git", "commit", "--allow-empty", "-q", "-m", "second-red");
    sh(wt, "git", "reset", "--hard", "main");
    assert.equal(await mainRedGate(root, ROLE, wt, undefined, () => {}), null);
    assert.equal(mainRedHolds(root).length, 2, "the new red SHA is still logged");
    assert.equal(queuedRolePrompts(root, "bugfix").length, 1, "same failing set: one heal prompt");
  } finally {
    restore();
  }
});
