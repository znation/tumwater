import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkBacklogHeadings, checkFixClaims, checkPlanDependencies, checkRefusedEntries, checkStaleBugs, checkStaleQueuedLandings, checkStaleQuestions, checkStalledPlans, checkStrandedPlans, checkUncommittedBacklog, checkWaitingBugs } from "../src/doctor/doctor-backlog.js";
import { enqueueMerge } from "../src/merge/merge-queue.js";
import { writeMergeMarker } from "../src/merge/merge-slot.js";
import { mergeQueueDir } from "../src/paths.js";
import { makeRepo, seedCommit, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { vanishOnReadFile } from "./helpers/fs-faults.js";

// Unit coverage for the doctor's backlog-document checks (src/doctor/doctor-backlog.ts): the three
// checks that read the tracked Markdown backlog rather than the environment. The environment
// checks' own coverage lives in test/doctor-checks.test.ts (the model-readiness checks in
// test/doctor-model-checks.test.ts); report composition, rendering, and
// the CLI wiring (`tumwater doctor` exit codes through main()) are pinned in
// test/doctor.test.ts, and the fixtures those files share live in test/fixtures/doctor-fixtures.ts.

// checkFixClaims — the standalone false-fix detector: the newest Fixed records of BUGS.md are
// re-verified against the tree with src/verdict/fix-claim.ts's parsing (the document shapes below
// follow test/fix-claim.test.ts). A record warns only when every symbol its Fix paragraph
// names is absent; the gate-strength rule (any missing symbol) belongs to md-only landings.

/** A fixture tree whose code defines `liveSymbol`, plus a BUGS.md whose Fixed section holds
 * one entry per given Fix paragraph, newest first (the template convention). */
function fixClaimsRepo(fixes: string[]): string {
  const root = tmpdir("doctor-fix-claims-");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "real.ts"), "export function liveSymbol() {}\n");
  const entries = fixes.map(
    (fix, i) => `### Entry ${i}: details (found by qa 2026-09-20, fixed 2026-09-21)\n\n**Symptom:** it broke.\n\n**Fix:** ${fix}\n`,
  );
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    `# Bugs\n\n## Open\n\n### Still broken (found by qa 2026-09-22)\n\n**Fix:** \`openOnlyPhantom\` someday.\n\n## Fixed\n\n${entries.join("\n")}`,
  );
  return root;
}

test("checkFixClaims reads ok for a record whose symbols exist — one live symbol is enough", () => {
  const r = checkFixClaims(fixClaimsRepo(["`liveSymbol()` now does it.", "`liveSymbol` and `renamedSinceThen` both changed."]));
  assert.equal(r.level, "ok", r.detail);
  assert.match(r.detail, /newest 2 Fixed record/);
});

test("checkFixClaims warns naming the heading and missing symbols of a record whose symbols are all absent", () => {
  const root = fixClaimsRepo([
    "`liveSymbol` is real.",
    "`runScriptGroup` now signals via `signalTree` in `src/build/build-check.ts`, bounded by `killAfter`.",
    "`anotherPhantom` landed.",
  ]);
  const r = checkFixClaims(root);
  assert.equal(r.level, "warn");
  assert.match(r.detail, /"Entry 1: details \(found by qa 2026-09-20, fixed 2026-09-21\)" as Fixed/);
  // Up to three names, falseFixReason's shape — the fourth is elided.
  assert.ok(r.detail.includes("runScriptGroup, signalTree, src/build/build-check.ts…"), r.detail);
  assert.ok(!r.detail.includes("killAfter"), r.detail);
  // A second suspect is still named, so fixing the first does not hide it.
  assert.match(r.detail, /and 1 more record\(s\): "Entry 2:/);
  assert.match(r.detail, /land the fix or keep the bug Open \/ refresh a stale record/);
  // Open entries are never verified — an Open bug has no fix to back.
  assert.ok(!r.detail.includes("openOnlyPhantom"), r.detail);
});

test("checkFixClaims verifies only the newest 10 Fixed records", () => {
  const live = Array.from({ length: 10 }, () => "`liveSymbol` fixed it.");
  const old = checkFixClaims(fixClaimsRepo([...live, "`longRenamedSymbol` fixed it."]));
  assert.equal(old.level, "ok", "a stale 11th record is outside the window");
  assert.match(old.detail, /newest 10 Fixed record/);
  const recent = checkFixClaims(fixClaimsRepo(["`longRenamedSymbol` fixed it.", ...live]));
  assert.equal(recent.level, "warn", "the same record as the newest is inside it");
  assert.match(recent.detail, /longRenamedSymbol/);
});

test("checkFixClaims reads ok with no BUGS.md and for a record naming no symbols", () => {
  assert.deepEqual(checkFixClaims(tmpdir("doctor-fix-claims-")), {
    level: "ok",
    detail: "no BUGS.md — nothing to verify",
  });
  // Pure-documentation fixes are legitimate: spans with whitespace are not symbols either.
  const r = checkFixClaims(fixClaimsRepo(["documented the behavior; `npm test` covers it."]));
  assert.equal(r.level, "ok", r.detail);
});

test("checkFixClaims warns instead of throwing when BUGS.md vanishes between the stat and the read", () => {
  // existsSync passes, then the file is gone when readFileSync lands — the rotation/race
  // tail the catch exists for (fs-faults.ts's vanishOnReadFile is that race, made
  // deterministic). Without the catch the check throws and takes the whole doctor run down.
  const root = fixClaimsRepo(["`liveSymbol` fixed it."]);
  const bugsPath = path.join(root, "BUGS.md");
  const undo = vanishOnReadFile(bugsPath);
  try {
    const r = checkFixClaims(root);
    assert.equal(r.level, "warn");
    assert.match(r.detail, /cannot read BUGS\.md — ENOENT/);
    assert.ok(!fs.existsSync(bugsPath), "the fault consumed the file");
  } finally {
    undo();
  }
});

// checkStrandedPlans — the stranded-plan detector surfaced for the operator (plans part 3/4):
// plan headings filed under the wrong PLANS.md section warn, naming the heading and section.

test("checkStrandedPlans warns naming a stranded heading and stays silent on a clean file", () => {
  const dir = tmpdir("doctor-stranded-");
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    `# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n### Timed pause support (planned 2026-09-25)\n`,
  );
  const warn = checkStrandedPlans(dir);
  assert.equal(warn.level, "warn");
  assert.match(warn.detail, /stranded under ## Done: "Timed pause support \(planned 2026-09-25\)"/);
  assert.match(warn.detail, /move it under ## Planned/);

  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    `# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n### Landed (planned 2026-09-10, done 2026-09-11)\n`,
  );
  assert.deepEqual(checkStrandedPlans(dir), {
    level: "ok",
    detail: "no plan headings filed under the wrong PLANS.md section",
  });

  // The mirror direction: a done-stamped heading still sitting under ## Planned — finished
  // work the feature loop may implement again. The remedy names the other section.
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    `# Plans\n\n## Planned\n\n### Old feature (planned 2026-09-01, done 2026-09-02)\n\n### Second stranded (planned 2026-09-03, done 2026-09-04)\n\n## Done\n\n_None yet._\n`,
  );
  const mirror = checkStrandedPlans(dir);
  assert.equal(mirror.level, "warn");
  assert.match(mirror.detail, /stranded under ## Planned: "Old feature \(planned 2026-09-01, done 2026-09-02\)"/);
  assert.match(mirror.detail, /\(and 1 more: "Second stranded \(planned 2026-09-03, done 2026-09-04\)"\)/);
  assert.match(mirror.detail, /move it under ## Done/);

  // No PLANS.md at all is a fine state too — nothing to verify.
  assert.deepEqual(checkStrandedPlans(tmpdir("doctor-stranded-none-")), {
    level: "ok",
    detail: "no PLANS.md — nothing to verify",
  });
});

test("checkStrandedPlans warns instead of throwing when PLANS.md cannot be read", () => {
  // A directory where the file belongs: existsSync passes, readFileSync lands EISDIR — the
  // class of filesystem damage a stray tool leaves behind. Without the catch the check
  // throws and takes the whole doctor run down; the contract is a warn, never a fail
  // (checkFixClaims's vanish-on-read twin above pins the same policy for BUGS.md).
  const dir = tmpdir("doctor-stranded-unreadable-");
  fs.mkdirSync(path.join(dir, "PLANS.md"));
  const r = checkStrandedPlans(dir);
  assert.equal(r.level, "warn");
  assert.match(r.detail, /^cannot read PLANS\.md — /);
});

// checkBacklogHeadings — the duplicate-heading half of the backlog-structure check surfaced
// for the operator (plans part 2/4): a `## ` heading already duplicated on main warns, naming
// the file and heading, so existing damage is visible. The wording must not overstate the
// gate: rule (a) fires only when a landing ADDS another copy (count exceeds the merge-base's),
// so a pre-existing duplicate is not blocked away by just any next edit.

test("checkBacklogHeadings warns on a duplicated heading and stays silent on a clean set", () => {
  const dir = tmpdir("doctor-headings-");
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    "## Done\n\n### A\n\n## Done\n\n### B\n\n## Planned\n\n_None yet._\n",
  );
  const warn = checkBacklogHeadings(dir);
  assert.equal(warn.level, "warn");
  assert.match(warn.detail, /PLANS\.md "## Done"/);
  assert.match(warn.detail, /appears more than once/);
  // The claim about the gate stays accurate: only an adding landing is blocked, so the
  // message tells the operator to remove the duplicate deliberately.
  assert.match(warn.detail, /blocks only a merge that adds another copy/);
  assert.doesNotMatch(warn.detail, /blocks the next edit/);

  // Clean across all three backlog files: ok, one line.
  fs.writeFileSync(path.join(dir, "PLANS.md"), "## Planned\n\n_None yet._\n\n## Done\n\n### A\n");
  fs.writeFileSync(path.join(dir, "BUGS.md"), "## Open\n\n## Fixed\n\n## Verified\n");
  fs.writeFileSync(path.join(dir, "QUESTIONS.md"), "## Open\n");
  assert.deepEqual(checkBacklogHeadings(dir), {
    level: "ok",
    detail: "no duplicated ## section headings in the backlog files",
  });

  // Absent files contribute nothing; a fenced duplicate is quoted content, not structure.
  fs.rmSync(path.join(dir, "BUGS.md"));
  fs.rmSync(path.join(dir, "QUESTIONS.md"));
  fs.writeFileSync(path.join(dir, "PLANS.md"), "## Planned\n\n```md\n## Done\n## Done\n```\n");
  assert.equal(checkBacklogHeadings(dir).level, "ok");
});

test("checkBacklogHeadings names an unreadable backlog file and still scans the readable ones", () => {
  // A directory where the file belongs: existsSync passes, readFileSync throws EISDIR. The
  // unreadable file is reported, not swallowed — its duplicate headings (if any) are now
  // invisible to every reader — and the scan continues, so one damaged file cannot mask
  // the damage in the readable ones.
  const dir = tmpdir("doctor-headings-unreadable-");
  fs.mkdirSync(path.join(dir, "PLANS.md"));
  fs.writeFileSync(path.join(dir, "BUGS.md"), "## Open\n\n## Open\n\n## Fixed\n");
  fs.writeFileSync(path.join(dir, "QUESTIONS.md"), "## Open\n");
  const r = checkBacklogHeadings(dir);
  assert.equal(r.level, "warn");
  assert.match(r.detail, /PLANS\.md \(unreadable\)/);
  assert.match(r.detail, /BUGS\.md "## Open"/);
});

test("checkRefusedEntries warns naming the first refused entry, the rest, and how to release it", () => {
  const dir = tmpdir("doctor-refusals-");
  const note = "**Refused 2026-10-12 by feature: too big**";
  fs.writeFileSync(path.join(dir, "PLANS.md"),
    `# Plans\n\n## Planned\n\n### Eligible plan\n\nbody\n\n### Parked plan (planned 2026-10-12)\n${note}\n\n## Done\n\n### Old plan\n${note}\n`);
  fs.writeFileSync(path.join(dir, "BUGS.md"), `# Bugs\n\n## Open\n\n### Parked bug\n${note}\n\n## Fixed\n\n### Old bug\n${note}\n`);
  const out = checkRefusedEntries(dir);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /PLANS\.md plan #2 "Parked plan \(planned 2026-10-12\)" is held by a Refused note \(Refused 2026-10-12 by feature: /);
  assert.ok(out.detail.includes('(and 1 more: BUGS.md bug #1 "Parked bug")'));
  assert.ok(out.detail.endsWith("release the entry with `tumwater plan --release 2`, or retract it with `tumwater plan --cancel 2`"));
});

test("checkRefusedEntries reads ok with no notes, with no files, and ignores Done and Fixed", () => {
  const ok = { level: "ok", detail: "no planned plan or open bug is held by a Refused note" };
  assert.deepEqual(checkRefusedEntries(tmpdir("doctor-refusals-none-")), ok);
  const dir = tmpdir("doctor-refusals-closed-");
  fs.writeFileSync(path.join(dir, "PLANS.md"), "## Planned\n\n### A\nbody\n\n## Done\n\n### B\n**Refused 2026-10-12 by x: y**\n");
  assert.deepEqual(checkRefusedEntries(dir), ok);
});

test("checkRefusedEntries flags a refusal whose prerequisites have left Planned", () => {
  const dir = tmpdir("doctor-refusals-stale-");
  const note = "**Refused 2026-10-12 by feature: part 1 missing**";
  const head = "### S, part 2/2: x (planned 2026-10-12; requires part 1/2 landed)";
  const write = (extra: string) => fs.writeFileSync(path.join(dir, "PLANS.md"),
    `## Planned\n\n${extra}${head}\n${note}\n\n### T, part 2/2: z (planned 2026-10-12; requires part 1/2 landed)\n${note}\n\n## Done\n`);
  write("");
  const stale = checkRefusedEntries(dir);
  assert.match(stale.detail, /S 1\/2 are no longer planned, so the refusal may be stale/);
  assert.ok(stale.detail.includes("[prerequisites no longer planned])"));
  write("### S, part 1/2: y\n\n");
  const live = checkRefusedEntries(dir);
  assert.match(live.detail, /Refused note/);
  assert.ok(!live.detail.includes("may be stale"));
});

test("checkRefusedEntries counts the planned parts that wait on a refused part", () => {
  const dir = tmpdir("doctor-refusals-waiting-");
  const note = "**Refused 2026-10-16 by feature: too big**";
  fs.writeFileSync(path.join(dir, "PLANS.md"),
    `## Planned\n\n### S, part 1/3: a\n${note}\n\n### S, part 2/3: b (requires part 1/3 landed)\n\n` +
    `### S, part 3/3: c (requires part 2/3 landed)\n\n### Solo\n${note}\n\n## Done\n`);
  const out = checkRefusedEntries(dir);
  assert.equal(out.level, "warn");
  assert.ok(out.detail.includes("; 2 planned part(s) wait on it, directly or through an earlier part"));
  assert.ok(out.detail.includes('(and 1 more: PLANS.md plan #4 "Solo")'));
});

// checkStalledPlans — plans parked by a Needs-review or Needs-replan note until the plan role
// splits or replans them: the doctor names them so the state is one-line visible, without the
// plan role or any listing changing. Mirrors the checkRefusedEntries setup — the two are the
// same shape but a different hold, and refusal notes (a separate hold) never trip it.

test("checkStalledPlans warns naming the first stalled plan, its note, and the rest", () => {
  const dir = tmpdir("doctor-stalled-");
  fs.writeFileSync(path.join(dir, "PLANS.md"),
    `# Plans\n\n## Planned\n\n### Eligible plan\n\nbody\n\n### Parked plan (planned 2026-10-14)\n**Needs review 2026-10-14 by feature: too large for one run**\n`);
  const out = checkStalledPlans(dir);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /PLANS\.md plan "Parked plan \(planned 2026-10-14\)" is held by a Needs review note \(Needs review 2026-10-14 by feature: /);
  assert.match(out.detail, /the plan role resolves it by splitting or replanning/);
});

test("checkStalledPlans warns on a Needs-replan note too", () => {
  const dir = tmpdir("doctor-stalled-replan-");
  fs.writeFileSync(path.join(dir, "PLANS.md"),
    `## Planned\n\n### Parked plan (planned 2026-10-14)\n**Needs replan 2026-10-14 by feature: rejected after 2 review rounds**\n`);
  const out = checkStalledPlans(dir);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /is held by a Needs replan note \(Needs replan 2026-10-14 by feature: /);
});

test("checkStalledPlans warns once when both kinds are present, naming the rest via andMore", () => {
  const dir = tmpdir("doctor-stalled-both-");
  fs.writeFileSync(path.join(dir, "PLANS.md"),
    `## Planned\n\n### First (planned 2026-10-14)\n**Needs review 2026-10-14 by feature: too large for one run**\n\n### Second (planned 2026-10-14)\n**Needs replan 2026-10-14 by feature: rejected after 2 review rounds**\n`);
  const out = checkStalledPlans(dir);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /"Second \(planned 2026-10-14\)"/);
});

test("checkStalledPlans reads ok with no notes, and ignores Done, Refused, and bodyless headings", () => {
  const ok = { level: "ok", detail: "no planned plan is held by a Needs-review or Needs-replan note" };
  assert.deepEqual(checkStalledPlans(tmpdir("doctor-stalled-none-")), ok);
  const dir = tmpdir("doctor-stalled-closed-");
  const note = "**Needs review 2026-10-14 by feature: too large for one run**";
  const refused = "**Refused 2026-10-12 by feature: too big**";
  fs.writeFileSync(path.join(dir, "PLANS.md"),
    `## Planned\n\n### Bodyless heading\n\n### Refused (planned 2026-10-12)\n${refused}\n\n## Done\n\n### Old plan\n${note}\n`);
  assert.deepEqual(checkStalledPlans(dir), ok);
});

// checkStaleQuestions — open questions that have waited too long for a human answer. The
// age (whole days from the heading's `(asked by …)` stamp) is the same formula the `--list`
// age suffix uses, so it is computed via backlog.ts's ageInDays, never hard-coded — the exact
// value drifts with the time of day. Mirrors the checkStalledPlans setup: a warn, and a
// missing QUESTIONS.md (or one with no stamps) reads ok.

/** A whole calendar day `n` days before `now`, as a `YYYY-MM-DD` filing stamp. */
function daysAgoStamp(n: number, now: number = Date.now()): string {
  const d = new Date(now - n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The whole days a `YYYY-MM-DD` stamp is old — the same formula the entry-age suffix uses. */
function stampAge(stamp: string): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(stamp)) / 86400000));
}

test("checkStaleQuestions warns naming a question whose stamp is at least 7 days old", () => {
  const dir = tmpdir("doctor-stale-questions-");
  const stamp = daysAgoStamp(8);
  const days = stampAge(stamp);
  fs.writeFileSync(path.join(dir, "QUESTIONS.md"),
    `# Questions\n\n## Open\n\n### Retire old logs (asked by director ${stamp})\n\nbody\n`);
  const out = checkStaleQuestions(dir);
  assert.equal(out.level, "warn");
  assert.ok(out.detail.startsWith(`QUESTIONS.md question "Retire old logs (asked by director ${stamp})"`), out.detail);
  assert.ok(out.detail.includes(`has waited ${days} d for an answer`), out.detail);
});

test("checkStaleQuestions warns once on several stale questions, naming the rest via andMore", () => {
  const dir = tmpdir("doctor-stale-questions-multi-");
  fs.writeFileSync(path.join(dir, "QUESTIONS.md"),
    `## Open\n\n### First (asked by director ${daysAgoStamp(9)})\n\n### Second (asked by director ${daysAgoStamp(8)})\n`);
  const out = checkStaleQuestions(dir);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /has waited \d+ d for an answer/);
  assert.ok(out.detail.includes('(and 1 more: "Second (asked by director '), out.detail);
});

test("checkStaleQuestions ignores undated and fresh headings, and a missing or sectionless QUESTIONS.md", () => {
  const ok = { level: "ok", detail: "no open question has waited more than 7 days for an answer" };
  assert.deepEqual(checkStaleQuestions(tmpdir("doctor-stale-questions-none-")), { level: "ok", detail: "no QUESTIONS.md — nothing to verify" });
  const dir = tmpdir("doctor-stale-questions-fresh-");
  fs.writeFileSync(path.join(dir, "QUESTIONS.md"),
    `## Open\n\n### Undated heading\n\n### Fresh (asked by director ${daysAgoStamp(0)})\n`);
  assert.deepEqual(checkStaleQuestions(dir), ok);
  const closed = tmpdir("doctor-stale-questions-closed-");
  fs.writeFileSync(path.join(closed, "QUESTIONS.md"), `## Answered\n\n### Old (asked by director 2026-01-01)\n`);
  assert.deepEqual(checkStaleQuestions(closed), ok);
});

test("checkStaleBugs warns on an open bug stamped 3 or more days ago", () => {
  const dir = tmpdir("doctor-stale-bugs-");
  const stamp = daysAgoStamp(4);
  fs.writeFileSync(path.join(dir, "BUGS.md"), `## Open\n\n### Broken thing (found by bugfix ${stamp})\n\nbody\n`);
  const out = checkStaleBugs(dir);
  assert.equal(out.level, "warn");
  assert.ok(out.detail.startsWith('BUGS.md bug #1 "'), out.detail);
  assert.ok(out.detail.includes(`has waited ${stampAge(stamp)} d for a fix`), out.detail);
  assert.ok(out.detail.includes("tumwater bug --cancel 1"), out.detail);
});

test("checkStaleBugs warns once on several stale bugs, naming the first's position", () => {
  const dir = tmpdir("doctor-stale-bugs-multi-");
  fs.writeFileSync(path.join(dir, "BUGS.md"),
    `## Open\n\n### Fresh (reported ${daysAgoStamp(0)})\n\n### Old one (found by bugfix ${daysAgoStamp(5)})\n\n### Old two (found by bugfix ${daysAgoStamp(6)})\n`);
  const out = checkStaleBugs(dir);
  assert.equal(out.level, "warn");
  assert.ok(out.detail.startsWith('BUGS.md bug #2 "'), out.detail);
  assert.ok(out.detail.includes('(and 1 more: #3 "'), out.detail);
});

test("checkStaleBugs ignores refused, undated, fresh and fixed bugs, and a missing BUGS.md", () => {
  const ok = { level: "ok", detail: "no open bug has waited more than 3 days for a fix" };
  assert.deepEqual(checkStaleBugs(tmpdir("doctor-stale-bugs-none-")), { level: "ok", detail: "no BUGS.md — nothing to verify" });
  const dir = tmpdir("doctor-stale-bugs-ok-");
  fs.writeFileSync(path.join(dir, "BUGS.md"),
    `## Open\n\n### Refused (found by bugfix ${daysAgoStamp(9)})\n\n**Refused 2026-10-10 by bugfix: not a bug**\n\n### Undated heading\n\n### Fresh (found by bugfix ${daysAgoStamp(0)})\n\n## Fixed\n\n### Old (found by bugfix ${daysAgoStamp(20)})\n`);
  assert.deepEqual(checkStaleBugs(dir), ok);
});

// checkStaleQueuedLandings — a change that has sat in the durable land queue too long without
// starting is the one queued-change health fact with no hook of its own: the header badge counts
// it and `tumwater queue` ages it, but nothing calls it out. This warns on the oldest queued
// landing that is NOT in-flight and has waited past the 6-hour threshold; a marker showing the
// role in-flight suppresses it, and an absent/unreadable marker or empty queue reads ok.

function advice(role: string, summary: string): { role: string; summary: string; enqueuedAt: number; sha: string; run: number } {
  return { role, summary, enqueuedAt: Date.now(), sha: "abc1234", run: 1 };
}

function queueRoot(): string {
  const root = tmpdir("doctor-stale-landing-");
  fs.mkdirSync(mergeQueueDir(root), { recursive: true });
  return root;
}

test("checkStaleQueuedLandings reads ok for an empty queue and one whose entries are all fresh", () => {
  const now = Date.now();
  assert.equal(checkStaleQueuedLandings(queueRoot(), now).level, "ok");
  const root = queueRoot();
  enqueueMerge(root, advice("improve", "tidy parser"));
  assert.equal(checkStaleQueuedLandings(root, now).level, "ok");
  // An entry exactly at the threshold boundary (not strictly past it) is not stale yet.
  enqueueMerge(root, { ...advice("clean", "split module"), enqueuedAt: now - 6 * 60 * 60 * 1000 });
  assert.equal(checkStaleQueuedLandings(root, now).level, "ok");
});

test("checkStaleQueuedLandings warns naming the oldest stale role, its summary, and its age", () => {
  const now = Date.now();
  const root = queueRoot();
  enqueueMerge(root, { ...advice("organize", "move the helpers"), enqueuedAt: now - 7 * 60 * 60 * 1000 });
  const out = checkStaleQueuedLandings(root, now);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /organize/);
  assert.match(out.detail, /move the helpers/);
  assert.match(out.detail, /has waited 7h to start/);
});

test("checkStaleQueuedLandings warns once, resting via andMore, and never flags an in-flight role", () => {
  const now = Date.now();
  const root = queueRoot();
  enqueueMerge(root, { ...advice("clean", "split module"), enqueuedAt: now - 8 * 60 * 60 * 1000 });
  enqueueMerge(root, { ...advice("organize", "move helpers"), enqueuedAt: now - 7 * 60 * 60 * 1000 });
  // The freshest is the in-flight one: the marker shows `improve` being merged, so it must
  // not be flagged even though it too is older than the threshold.
  writeMergeMarker(root, {
    role: "improve", sha: "abc1234", summary: "tidy parser", startedAt: now - 1000, stage: "merging",
    changes: [{ role: "improve", sha: "abc1234", summary: "tidy parser", status: "merging", startedAt: now - 1000 }],
  });
  enqueueMerge(root, { ...advice("improve", "tidy parser"), enqueuedAt: now - 5 * 60 * 60 * 1000 });
  const out = checkStaleQueuedLandings(root, now);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /clean/);
  assert.ok(!out.detail.includes("improve"), "the in-flight role is not flagged");
  assert.match(out.detail, /and 1 more: organize/);
});

// checkUncommittedBacklog — operator edits left uncommitted in the primary checkout.

function backlogRepo(): string {
  const root = makeRepo();
  seedCommit(root, "PLANS.md", "# Plans\n", "plans");
  seedCommit(root, "BUGS.md", "# Bugs\n", "bugs");
  seedCommit(root, "QUESTIONS.md", "# Questions\n", "questions");
  return root;
}

test("checkUncommittedBacklog reads ok on a clean checkout", async () => {
  const r = await checkUncommittedBacklog(backlogRepo(), undefined);
  assert.equal(r.level, "ok", r.detail);
});

test("checkUncommittedBacklog warns naming each modified backlog file", async () => {
  const root = backlogRepo();
  fs.appendFileSync(path.join(root, "QUESTIONS.md"), "edit\n");
  const one = await checkUncommittedBacklog(root, undefined);
  assert.equal(one.level, "warn");
  assert.match(one.detail, /QUESTIONS\.md has uncommitted changes/);
  fs.appendFileSync(path.join(root, "PLANS.md"), "edit\n");
  const r = await checkUncommittedBacklog(root, undefined);
  assert.equal(r.level, "warn");
  assert.match(r.detail, /PLANS\.md, QUESTIONS\.md have uncommitted changes/);
  assert.match(r.detail, /merge_blocked/);
});

test("checkUncommittedBacklog ignores untracked and unwatched files", async () => {
  const root = backlogRepo();
  seedCommit(root, "other.txt", "x\n", "other");
  fs.writeFileSync(path.join(root, "other.txt"), "changed\n");
  fs.writeFileSync(path.join(root, "new.md"), "new\n");
  const r = await checkUncommittedBacklog(root, undefined);
  assert.equal(r.level, "ok", r.detail);
});

test("checkUncommittedBacklog skips a primary that is not on the base branch", async () => {
  const root = backlogRepo();
  sh(root, "git", "checkout", "-b", "other");
  fs.appendFileSync(path.join(root, "BUGS.md"), "edit\n");
  const r = await checkUncommittedBacklog(root, { baseBranch: "main" } as never);
  assert.equal(r.level, "ok");
  assert.match(r.detail, /not on/);
});

test("checkUncommittedBacklog counts the brief file", async () => {
  const root = backlogRepo();
  seedCommit(root, "README.md", "# x\n<!-- tumwater:prompt:start -->\nidea\n<!-- tumwater:prompt:end -->\n", "readme");
  fs.appendFileSync(path.join(root, "README.md"), "edit\n");
  const r = await checkUncommittedBacklog(root, undefined);
  assert.equal(r.level, "warn");
  assert.match(r.detail, /README\.md has uncommitted/);
});

// checkPlanDependencies: cycles, dangling refs and unparsed requires clauses.

function plansWith(planned: string, done = ""): string {
  const dir = tmpdir("doctor-plandeps-");
  fs.writeFileSync(path.join(dir, "PLANS.md"), `# Plans\n\n## Planned\n\n${planned}\n## Done\n\n${done}`);
  return dir;
}

test("checkPlanDependencies is ok on a clean pair and when PLANS.md is absent", () => {
  const dir = plansWith("### S, part 2/2: b (requires part 1/2 landed)\n\nbody\n", "### S, part 1/2: a (done 2026-10-01)\n");
  assert.equal(checkPlanDependencies(dir).level, "ok");
  assert.equal(checkPlanDependencies(tmpdir("doctor-plandeps-none-")).level, "ok");
});

test("checkPlanDependencies warns on a dangling ref", () => {
  const out = checkPlanDependencies(plansWith("### S, part 2/2: b (requires T 1/2 landed)\n\nbody\n"));
  assert.equal(out.level, "warn");
  assert.match(out.detail, /requires T 1\/2, which no PLANS\.md heading carries — the hold is void, so the plan is claimable now/);
});

test("checkPlanDependencies warns on a misworded dependency", () => {
  const out = checkPlanDependencies(plansWith("### S, part 1/2: a\n\nbody\n\n### S, part 2/2: b (blocked by part 1/2 above)\n\nbody\n"));
  assert.equal(out.level, "warn");
  assert.match(out.detail, /names S 1\/2 as a prerequisite/);
});

test("checkPlanDependencies warns on an unparsed clause", () => {
  const out = checkPlanDependencies(plansWith("### Plain plan (requires part 1/2 landed)\n\nbody\n"));
  assert.equal(out.level, "warn");
  assert.match(out.detail, /clause that names no part the allocator can read/);
});

test("checkPlanDependencies names a cycle first and counts the other kinds", () => {
  const out = checkPlanDependencies(plansWith(
    "### S, part 1/2: a (requires part 2/2 landed)\n\nx\n\n### S, part 2/2: b (requires part 1/2, T 1/1 landed)\n\nx\n",
  ));
  assert.equal(out.level, "warn");
  assert.match(out.detail, /plan dependency cycle: S 1\/2 → S 2\/2 → S 1\/2 — every part on it stays blocked forever/);
  assert.match(out.detail, /\(also 1 dangling ref\(s\), 0 unparsed clause\(s\), 0 misworded dependency\(ies\)\)/);
});

const WAIT = "**Waiting for the next failure 2026-10-16 by bugfix: the message names the pid**";

test("checkStaleBugs skips a bug held by a Waiting for the next failure note", () => {
  const dir = tmpdir("doctor-stale-bugs-waiting-");
  fs.writeFileSync(path.join(dir, "BUGS.md"), `## Open\n\n### Held (found by bugfix ${daysAgoStamp(9)})\n\n${WAIT}\n`);
  assert.deepEqual(checkStaleBugs(dir), { level: "ok", detail: "no open bug has waited more than 3 days for a fix" });
});

test("checkWaitingBugs names a waiting bug with its note and release command, as ok", () => {
  const dir = tmpdir("doctor-waiting-bugs-");
  fs.writeFileSync(path.join(dir, "BUGS.md"), `## Open\n\n### Plain (found by bugfix ${daysAgoStamp(0)})\n\n### Held (found by bugfix ${daysAgoStamp(1)})\n\n${WAIT}\n`);
  const out = checkWaitingBugs(dir);
  assert.equal(out.level, "ok");
  assert.ok(out.detail.startsWith('BUGS.md bug #2 "'), out.detail);
  assert.ok(out.detail.includes("the message names the pid"), out.detail);
  assert.ok(out.detail.includes("tumwater bug --release 2"), out.detail);
});

test("checkWaitingBugs names the first of several and counts the rest", () => {
  const dir = tmpdir("doctor-waiting-bugs-multi-");
  fs.writeFileSync(path.join(dir, "BUGS.md"), `## Open\n\n### One\n\n${WAIT}\n\n### Two\n\n${WAIT}\n`);
  const out = checkWaitingBugs(dir);
  assert.ok(out.detail.startsWith('BUGS.md bug #1 "'), out.detail);
  assert.ok(out.detail.includes('(and 1 more: #2 "'), out.detail);
});

test("checkWaitingBugs is quiet without an Open waiting bug, and without BUGS.md", () => {
  const none = { level: "ok", detail: "no open bug is waiting for its next failure" };
  assert.deepEqual(checkWaitingBugs(tmpdir("doctor-waiting-bugs-none-")), { level: "ok", detail: "no BUGS.md — nothing to verify" });
  const dir = tmpdir("doctor-waiting-bugs-quiet-");
  fs.writeFileSync(path.join(dir, "BUGS.md"),
    `## Open\n\n### Both\n\n**Refused 2026-10-10 by bugfix: no**\n${WAIT}\n\n## Fixed\n\n### Old\n\n${WAIT}\n`);
  assert.deepEqual(checkWaitingBugs(dir), none);
});
