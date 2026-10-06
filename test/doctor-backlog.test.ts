import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkBacklogHeadings, checkFixClaims, checkStrandedPlans } from "../src/doctor/doctor-backlog.js";
import { tmpdir } from "./repo-fixtures.js";
import { vanishOnReadFile } from "./fs-faults.js";

// Unit coverage for the doctor's backlog-document checks (src/doctor/doctor-backlog.ts): the three
// checks that read the tracked Markdown backlog rather than the environment. The environment
// checks' own coverage lives in test/doctor-checks.test.ts; report composition, rendering, and
// the CLI wiring (`tumwater doctor` exit codes through main()) are pinned in
// test/doctor.test.ts, and the fixtures those files share live in test/doctor-fixtures.ts.

// checkFixClaims — the standalone false-fix detector: the newest Fixed records of BUGS.md are
// re-verified against the tree with src/fix-claim.ts's parsing (the document shapes below
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
  assert.match(warn.detail, /blocks only a landing that adds another copy/);
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
