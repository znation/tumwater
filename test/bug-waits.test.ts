/** The bugfix role's waits for a recurrence (src/backlog/backlog-bug-waits.ts): a bug parked by a
 * `**Needs review <date> by bugfix: …**` note is held as waiting for a recurrence, not for a
 * review; a flake of its test recorded by the quarantine lifts the wait; a wait that stays quiet
 * for BUGFIX_WAIT_QUIET_DAYS closes the bug. On 2026-11-03 five such bugs sat
 * `[blocked: needs review]` for 8–18 days because only selfcheck could lift one, and its digest
 * never shows a flake the main watch's re-run settled. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bugfixWaitDate, entryHold, holdMark, withoutNeedsReviewNotes } from "../src/backlog/backlog-eligibility.js";
import { closeQuietBugWaitsOnMain, closeQuietWaitsText } from "../src/backlog/backlog-bug-waits.js";
import { fileQuarantineBugsOnMain, recordRecurrence } from "../src/backlog/backlog-file-bugs.js";
import { parseEntryDetails, validationGapTag } from "../src/backlog/backlog-md.js";
import { createMainWatch } from "../src/baseline/main-watch.js";
import { defaultConfig } from "../src/config/config.js";
import { fixSymbols } from "../src/verdict/fix-claim.js";
import { loadQuarantine, markQuarantineFiled, quarantineTests } from "../src/review/known-flakes.js";
import { BUGFIX_WAIT_QUIET_DAYS } from "../src/roles/role-guidance.js";
import { makeRepo, seedCommit, sh } from "./fixtures/repo-fixtures.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A bugfix wait note dated `date`, wrapped across two lines the way a bugfix run wrote one. */
const wrappedWait = (date: string): string =>
  `**Needs review ${date} by bugfix: the test now reports whether the fake pi's\n\`piRan\` marker exists.**`;

/** A BUGS.md with one quarantine entry for `test`, its body ending with `notes`. */
function bugsWith(test: string, notes: string): string {
  return (
    `# Bugs\n\n## Open\n\n### \`${test}\` failed, then passed on the same tree (quarantined by tumwater 2026-10-24)\n\n` +
    `The check failed on this test and then passed on a re-run of the same tree.\n\n` +
    `**Progress 2026-10-24 by bugfix:** not reproduced.\n\n${notes}\n\n` +
    `### Another bug (found by qa 2026-11-01)\n\nStill open.\n\n## Fixed\n`
  );
}

/** A repo whose BUGS.md is `bugs`, committed, with `.tumwater/` (the locks' and quarantine's
 * parent) kept out of git status. */
function repoWithBugs(bugs: string): string {
  const root = makeRepo();
  seedCommit(root, "BUGS.md", bugs, "seed bugs");
  fs.mkdirSync(path.join(root, ".tumwater"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
  fs.appendFileSync(path.join(root, ".git", "info", "exclude"), ".tumwater/\n");
  return root;
}

test("a bugfix wait is held as waiting for a recurrence, and any other Needs-review note keeps it needs review", () => {
  const wait = { title: "A flaky test", body: `Body.\n\n${wrappedWait("2026-10-24")}` };
  assert.equal(entryHold(wait, []), "awaiting-recurrence");
  assert.equal(holdMark(entryHold(wait, [])), " [blocked: waiting for a recurrence]");
  assert.equal(bugfixWaitDate(`${wait.body}\n\n**Needs review 2026-10-26 by bugfix: later.**`), "2026-10-26");
  const director = { title: "Parked", body: `${wait.body}\n\n**Needs review 2026-10-27 by director: decide X.**` };
  assert.equal(entryHold(director, []), "needs-review");
  assert.equal(entryHold({ title: "Too big", body: "**Needs review 2026-10-27 by feature: too large for one run**" }, []), "needs-review");
  assert.equal(bugfixWaitDate("**Needs review 2026-10-27 by feature: too large for one run**"), null);
});

test("a release lifts a Needs review note wrapped across lines whole, leaving one blank line", () => {
  const lines = ["Body.", "", ...wrappedWait("2026-10-24").split("\n"), "", "Tail."];
  assert.deepEqual(withoutNeedsReviewNotes(lines), ["Body.", "", "Tail."]);
});

test("recordRecurrence lifts a bugfix wait, wrapped lines included, and records the flake with its output under the entry", () => {
  const md = bugsWith("flaky one", wrappedWait("2026-10-24"));
  const heading = "`flaky one` failed, then passed on the same tree (quarantined by tumwater 2026-10-24)";
  const next = recordRecurrence(md, heading, "flaky one", "2026-11-04", "✖ flaky one\n  boom");
  assert.ok(next !== null);
  const [entry, other] = parseEntryDetails(next, "Open");
  assert.equal(entry?.title, heading);
  assert.doesNotMatch(entry!.body, /Needs review|piRan/);
  assert.match(entry!.body, /\*\*Failed again 2026-11-04 \(tumwater\):\*\* `flaky one` failed, then passed/);
  assert.match(entry!.body, /~~~~\n✖ flaky one\n {2}boom\n~~~~$/);
  assert.equal(entryHold(entry!, []), null, "the bugfix role takes it again");
  assert.deepEqual(other, { title: "Another bug (found by qa 2026-11-01)", body: "Still open." });
  assert.match(next, /~~~~\n\n### Another bug/, "one blank line still separates the entries");
});

test("recordRecurrence leaves a bug that waits for nothing, or is gone, untouched", () => {
  const md = bugsWith("flaky one", "**Progress 2026-10-25 by bugfix:** working on it.");
  const heading = "`flaky one` failed, then passed on the same tree (quarantined by tumwater 2026-10-24)";
  assert.equal(recordRecurrence(md, heading, "flaky one", "2026-11-04"), null);
  assert.equal(recordRecurrence(md, "no such bug", "flaky one", "2026-11-04"), null);
});

test("a flake of a test whose waiting bug is open is recorded under it on main, and a heading that quotes the test counts", async () => {
  const quoted = "startParentDeathWatch takes a SIGKILLed grandchild down";
  const bugs =
    bugsWith("flaky one", "**Needs review 2026-10-26 by bugfix: the message names the case.**").replace(
      "## Fixed",
      `### \`test/supervisor.test.ts\` "${quoted}" flaked again (found by operator session 2026-10-16)\n\n` +
        `**Needs review 2026-10-26 by bugfix: signals sent.**\n\n## Fixed`,
    );
  const root = repoWithBugs(bugs);
  const commits = Number(sh(root, "git", "rev-list", "--count", "HEAD"));
  const filed = await fileQuarantineBugsOnMain(root, [{ test: "flaky one", tail: "✖ flaky one" }, { test: quoted }]);
  assert.equal(filed.status, "filed");
  assert.equal(sh(root, "git", "log", "-1", "--format=%s"), "tumwater(operator): Record 2 recurrences of waiting bugs in BUGS.md");
  assert.equal(Number(sh(root, "git", "rev-list", "--count", "HEAD")), commits + 1);
  const open = parseEntryDetails(fs.readFileSync(path.join(root, "BUGS.md"), "utf8"), "Open");
  assert.equal(open.length, 3, "nothing new is filed");
  assert.deepEqual(open.map((e) => entryHold(e, [])), [null, null, null]);
  assert.equal(filed.status === "filed" ? filed.bugs.get(quoted) : "", open[2]!.title);
});

test("quarantine: a flake of a filed test is marked recurred, and the main watch records it under its waiting bug", async () => {
  const heading = "`flaky one` failed, then passed on the same tree (quarantined by tumwater 2026-10-24)";
  const root = repoWithBugs(bugsWith("flaky one", wrappedWait("2026-10-26")));
  quarantineTests(root, ["flaky one"], "first");
  markQuarantineFiled(root, new Map([["flaky one", heading]]));
  assert.equal(loadQuarantine(root)[0]?.recurred, undefined);
  quarantineTests(root, ["flaky one"], "✖ flaky one again");
  assert.deepEqual(
    loadQuarantine(root).map(({ count, bug, tail, recurred }) => ({ count, bug, tail, recurred })),
    [{ count: 2, bug: heading, tail: "✖ flaky one again", recurred: true }],
  );
  const watch = createMainWatch(root, "main");
  watch.poll("", false, defaultConfig());
  await watch.idle();
  const entry = parseEntryDetails(fs.readFileSync(path.join(root, "BUGS.md"), "utf8"), "Open")[0]!;
  assert.match(entry.body, /\*\*Failed again \d{4}-\d{2}-\d{2} \(tumwater\):\*\*[^]*✖ flaky one again/);
  assert.equal(entryHold(entry, []), null);
  assert.deepEqual(
    loadQuarantine(root).map(({ bug, tail, recurred }) => ({ bug, tail, recurred })),
    [{ bug: heading, tail: undefined, recurred: undefined }],
  );
  assert.equal(sh(root, "git", "status", "--porcelain"), "");
});

test("closeQuietWaitsText closes only a bugfix wait past the quiet days, into the archive with a Fix and a validation-gap line", () => {
  const now = Date.parse("2026-11-03T12:00:00");
  const old = new Date(now - BUGFIX_WAIT_QUIET_DAYS * DAY_MS).toISOString().slice(0, 10);
  const young = new Date(now - (BUGFIX_WAIT_QUIET_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const bugs = bugsWith("flaky one", wrappedWait(old)).replace(
    "## Fixed",
    `### Young wait (found by qa 2026-11-01)\n\n**Needs review ${young} by bugfix: soon.**\n\n` +
      `### Director park (found by qa 2026-10-01)\n\n**Needs review ${old} by director: decide.**\n\n## Fixed`,
  );
  const archive = "# Fixed bugs\n\nIntro.\n\n## Fixed\n\n### Older (found 2026-10-01) — fixed 2026-10-02 by the bugfix role\n\nOld.\n";
  const closed = closeQuietWaitsText(bugs, archive, parseEntryDetails(bugs, "Open"), now);
  assert.ok(closed !== null);
  const heading = "`flaky one` failed, then passed on the same tree (quarantined by tumwater 2026-10-24)";
  assert.deepEqual(closed.titles, [heading]);
  assert.deepEqual(
    parseEntryDetails(closed.bugs, "Open").map((e) => e.title),
    ["Another bug (found by qa 2026-11-01)", "Young wait (found by qa 2026-11-01)", "Director park (found by qa 2026-10-01)"],
  );
  const [fixed, older] = parseEntryDetails(closed.archive, "Fixed");
  assert.equal(fixed?.title, `${heading} — closed 2026-11-03 by tumwater`);
  assert.match(fixed!.body, /^The check failed on this test[^]*`piRan` marker exists\.\*\*\n\n\*\*Fix:\*\* closed by tumwater/);
  assert.match(fixed!.body, new RegExp(`saw none in ${BUGFIX_WAIT_QUIET_DAYS} days`));
  assert.equal(validationGapTag(fixed!.body), "no-repro");
  assert.deepEqual(fixSymbols(fixed!.body), [], "the Fix paragraph names no code for the false-fix rule to check");
  assert.equal(older?.title, "Older (found 2026-10-01) — fixed 2026-10-02 by the bugfix role");
  assert.equal(closeQuietWaitsText(bugs, archive, parseEntryDetails(bugs, "Open"), now - DAY_MS), null);
});

test("closeQuietBugWaitsOnMain commits the close on main, does nothing while every wait is young, and skips a dirty BUGS.md", async () => {
  const root = repoWithBugs(bugsWith("flaky one", "**Needs review 2026-10-26 by bugfix: the message names the case.**"));
  const commits = Number(sh(root, "git", "rev-list", "--count", "HEAD"));
  assert.deepEqual(await closeQuietBugWaitsOnMain(root, { now: Date.parse("2026-11-01T12:00:00") }), { status: "nothing" });
  const file = path.join(root, "BUGS.md");
  fs.appendFileSync(file, "\n");
  const skipped = await closeQuietBugWaitsOnMain(root, { now: Date.parse("2026-11-03T12:00:00") });
  assert.deepEqual(skipped, { status: "skipped", reason: "BUGS.md has uncommitted changes" });
  sh(root, "git", "checkout", "--", "BUGS.md");
  const outcome = await closeQuietBugWaitsOnMain(root, { now: Date.parse("2026-11-03T12:00:00") });
  assert.equal(outcome.status, "closed");
  assert.equal(
    sh(root, "git", "log", "-1", "--format=%s"),
    `tumwater(operator): Close 1 bug whose bugfix wait saw no recurrence in ${BUGFIX_WAIT_QUIET_DAYS} days`,
  );
  assert.equal(Number(sh(root, "git", "rev-list", "--count", "HEAD")), commits + 1);
  assert.equal(sh(root, "git", "status", "--porcelain"), "");
  assert.deepEqual(parseEntryDetails(fs.readFileSync(file, "utf8"), "Open").map((e) => e.title), ["Another bug (found by qa 2026-11-01)"]);
  const fixed = parseEntryDetails(fs.readFileSync(path.join(root, "BUGS-FIXED.md"), "utf8"), "Fixed");
  assert.match(fixed[0]?.title ?? "", /quarantined by tumwater 2026-10-24\) — closed 2026-11-03 by tumwater$/);
});
