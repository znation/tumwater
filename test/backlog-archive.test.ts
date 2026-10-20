import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  archiveFinishedOnMain,
  archiveFinishedText,
  archiveNewFinishedEntries,
  fileQuarantineBugsOnMain,
  archiveTemplate,
  liveFinishedHistory,
} from "../src/backlog/backlog-archive.js";
import { finishedArchiveOf } from "../src/backlog/backlog-md.js";
import { donePlanEntries, donePlans, fixedBugEntries } from "../src/backlog/backlog.js";
import { conflictedFiles, rebaseOntoMainLeaveConflicts } from "../src/merge/merge-git.js";
import { resolveBacklogInsertConflicts, resolveInsertOnlyText } from "../src/merge/backlog-conflicts.js";
import { falseFixReason } from "../src/verdict/fix-claim.js";
import { backlogStructureReason } from "../src/backlog/backlog-structure.js";
import { checkLiveFinished } from "../src/doctor/doctor-backlog.js";
import { makeRepo, seedCommit, sh, initializedRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { errnoError, failRenameSyncOn, patchFsMethod } from "./helpers/fs-faults.js";

// The backlog archive (plans/backlog-archive.md): finished entries move from the live files'
// `## Done` / `## Fixed` to PLANS-DONE.md / BUGS-FIXED.md — a commit-time sweep of the entries a
// change added, and a bulk archive committed on main — and every reader reads both.

const PLANS = finishedArchiveOf("PLANS.md");
const BUGS = finishedArchiveOf("BUGS.md");

/** Create `.tumwater/` (the merge lock's parent) and keep it, and `patterns`, out of git status. */
function ignoreInRepo(root: string, ...patterns: string[]): void {
  fs.mkdirSync(path.join(root, ".tumwater"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
  fs.appendFileSync(path.join(root, ".git", "info", "exclude"), patterns.map((p) => `${p}\n`).join(""));
}

const plans = (done: string): string => `# Plans\n\nIntro.\n\n## Planned\n\n### Open plan (planned 2026-10-01)\n\nBody.\n\n## Done\n\n${done}`;

test("the commit-time sweep moves only the entries the change added, newest first, into a new archive", () => {
  const live = plans("### New B (planned 2026-10-02, done 2026-10-18)\n\nB.\n\n### New A (planned 2026-10-01, done 2026-10-18)\n\nA.\n");
  const move = archiveFinishedText(live, null, PLANS, { baseKeys: new Set() });
  assert.ok(move);
  assert.deepEqual(move.titles, ["New B (planned 2026-10-02, done 2026-10-18)", "New A (planned 2026-10-01, done 2026-10-18)"]);
  assert.equal(move.live, plans("").replace(/\n\n$/, "\n"), "the live section keeps its bare heading");
  assert.ok(move.archive.startsWith(archiveTemplate(PLANS)), "a new archive starts from the template");
  assert.match(move.archive, /## Done\n\n### New B[^]*\n\nB\.\n\n### New A[^]*\n\nA\.\n$/);
});

test("the sweep prepends to an existing archive and leaves entries the base already had", () => {
  const archive = `${archiveTemplate(PLANS)}\n### Old (planned 2026-09-01, done 2026-09-02)\n\nOld.\n`;
  const live = plans("### Fresh (planned 2026-10-01, done 2026-10-18)\n\nF.\n\n### Kept (planned 2026-09-30, done 2026-10-17)\n\nK.\n");
  const move = archiveFinishedText(live, archive, PLANS, {
    baseKeys: new Set(["Kept (planned 2026-09-30, done 2026-10-17)"]),
  });
  assert.ok(move);
  assert.deepEqual(move.titles, ["Fresh (planned 2026-10-01, done 2026-10-18)"]);
  assert.match(move.live, /## Done\n\n### Kept[^]*\n\nK\.\n$/);
  assert.doesNotMatch(move.live, /Fresh/);
  assert.match(move.archive, /## Done\n\n### Fresh[^]*\n\nF\.\n\n### Old[^]*\n\nOld\.\n$/);
});

test("the sweep moves nothing while legacy entries sit in the live section and no archive exists", () => {
  const live = plans("### Fresh (planned 2026-10-01, done 2026-10-18)\n\nF.\n\n### Legacy (planned 2026-09-01, done 2026-09-02)\n\nL.\n");
  assert.equal(archiveFinishedText(live, null, PLANS, { baseKeys: new Set(["Legacy (planned 2026-09-01, done 2026-09-02)"]) }), null);
  assert.equal(archiveFinishedText(plans("_None yet._\n"), null, PLANS, { baseKeys: new Set() }), null, "a placeholder is not an entry");
});

test("the sweep keeps a placeholder in the live section and a following section's heading intact", () => {
  const live = "## Open\n\n_None yet._\n\n## Fixed\n\n_None yet._\n\n### Bug (found 2026-10-01; fixed 2026-10-18)\n\nFix.\n\n## Verified\n\n- note\n";
  const move = archiveFinishedText(live, null, BUGS, { baseKeys: new Set() });
  assert.ok(move);
  assert.equal(move.live, "## Open\n\n_None yet._\n\n## Fixed\n\n_None yet._\n\n## Verified\n\n- note\n");
  assert.match(move.archive, /# Fixed bugs[^]*## Fixed\n\n### Bug[^]*Fix\.\n$/);
});

test("the bulk archive moves the whole body, one-line records included, or all but the newest kept entries", () => {
  const body = "### D1 (planned 2026-10-02, done 2026-10-03)\n\nOne.\n\n### D2 (planned 2026-10-01, done 2026-10-02)\n\nTwo.\n- Old record (planned 2026-09-01, done 2026-09-02; commit abc12345)\n";
  const all = archiveFinishedText(plans(body), null, PLANS, { keep: 0 });
  assert.ok(all);
  assert.deepEqual(all.titles.length, 2);
  assert.match(all.live, /## Done\n$/);
  assert.match(all.archive, /## Done\n\n### D1[^]*### D2[^]*- Old record[^]*\n$/);
  const kept = archiveFinishedText(plans(body), null, PLANS, { keep: 1 });
  assert.ok(kept);
  assert.deepEqual(kept.titles, ["D2 (planned 2026-10-01, done 2026-10-02)"]);
  assert.match(kept.live, /## Done\n\n### D1 [^]*One\.\n$/);
  assert.doesNotMatch(kept.archive, /### D1/);
  assert.match(kept.archive, /### D2[^]*- Old record/);
  assert.equal(archiveFinishedText(plans("### Only (planned 2026-10-01, done 2026-10-02)\n"), null, PLANS, { keep: 1 }), null);
});

// An entry whose heading the archive already holds is never archived twice (2026-10-19: a conflict
// hand-back of a change written before the archive re-pasted the old history under the live
// headings, and the sweep prepended all 383 + 310 entries to the archives again).

const oldEntry = "### Old (planned 2026-09-01, done 2026-09-02)\n\nOld.\n";
const keptEntry = "### Kept (planned 2026-09-03, done 2026-09-04)\n\nKept.\n";
const newEntry = "### New (planned 2026-10-01, done 2026-10-19)\n\nNew.\n";
const keptEdited = keptEntry.replace("Kept.", "Kept, edited.");
const archiveOf = (body: string): string => `${archiveTemplate(PLANS)}\n${body}`;

test("the sweep drops an added entry the archive holds verbatim and leaves an edited copy in the live section", () => {
  const archive = archiveOf(`${oldEntry}\n${keptEntry}`);
  // Trailing whitespace on a line is no difference.
  const live = plans(`${newEntry}\n${oldEntry.replace("Old.", "Old.  ")}\n${keptEdited}`);
  const move = archiveFinishedText(live, archive, PLANS, { baseKeys: new Set() });
  assert.ok(move);
  assert.deepEqual(move.titles, ["New (planned 2026-10-01, done 2026-10-19)"]);
  assert.deepEqual(move.dropped, ["Old (planned 2026-09-01, done 2026-09-02)"]);
  assert.equal(move.live, plans(keptEdited), "the edited copy stays where the author put it");
  assert.equal(move.archive, archiveOf(`${newEntry}\n${oldEntry}\n${keptEntry}`), "each heading once, the new one on top");
});

test("a sweep that only finds re-pasted entries empties the live section and leaves the archive as it was", () => {
  const archive = archiveOf(`${oldEntry}\n${keptEntry}`);
  const move = archiveFinishedText(plans(`${oldEntry}\n${keptEntry}`), archive, PLANS, { baseKeys: new Set() });
  assert.ok(move);
  assert.deepEqual(move.titles, []);
  assert.equal(move.dropped.length, 2);
  assert.match(move.live, /## Done\n$/);
  assert.equal(move.archive, archive);
  assert.equal(archiveFinishedText(plans(keptEdited), archive, PLANS, { baseKeys: new Set() }), null, "an edited copy alone moves nothing");
});

test("the bulk archive skips entries the archive already holds, whatever it keeps", () => {
  const archive = archiveOf(`${oldEntry}\n${keptEntry}`);
  const body = `${newEntry}\n${oldEntry}\n${keptEdited}- One-line record (planned 2026-08-01, done 2026-08-02)\n`;
  const all = archiveFinishedText(plans(body), archive, PLANS, { keep: 0 });
  assert.ok(all);
  assert.deepEqual(all.titles, ["New (planned 2026-10-01, done 2026-10-19)"]);
  assert.deepEqual(all.dropped, ["Old (planned 2026-09-01, done 2026-09-02)"]);
  // The record line is part of the edited entry's body, so it stays with it.
  assert.equal(all.live, plans(`${keptEdited}- One-line record (planned 2026-08-01, done 2026-08-02)\n`));
  assert.equal(all.archive, archiveOf(`${newEntry}\n${oldEntry}\n${keptEntry}`));
  const kept = archiveFinishedText(plans(body), archive, PLANS, { keep: 1 });
  assert.ok(kept);
  assert.deepEqual(kept.titles, []);
  assert.deepEqual(kept.dropped, ["Old (planned 2026-09-01, done 2026-09-02)"]);
  assert.equal(kept.live, plans(`${newEntry}\n${keptEdited}- One-line record (planned 2026-08-01, done 2026-08-02)\n`));
  assert.equal(kept.archive, archive);
});

test("a change that re-pastes archived history under ## Done archives only its new entry, and passes the structure check", async () => {
  const root = makeRepo();
  const history = Array.from({ length: 3 }, (_, i) => `### D${i} (planned 2026-09-0${i + 1}, done 2026-09-1${i})\n\nBody ${i}.\n`).join("\n");
  seedCommit(root, "PLANS.md", plans(""), "seed plans");
  seedCommit(root, "PLANS-DONE.md", archiveOf(history), "seed archive");
  sh(root, "git", "checkout", "-q", "-b", "work");
  // The hand-back's shape: the whole old history pasted back under the live heading, the
  // change's own finished entry on top.
  fs.writeFileSync(path.join(root, "PLANS.md"), plans(`${newEntry}\n${history}`));
  const moved = await archiveNewFinishedEntries(root, "main");
  assert.deepEqual(moved, [
    {
      file: "PLANS.md",
      archive: "PLANS-DONE.md",
      titles: ["New (planned 2026-10-01, done 2026-10-19)"],
      dropped: ["D0 (planned 2026-09-01, done 2026-09-10)", "D1 (planned 2026-09-02, done 2026-09-11)", "D2 (planned 2026-09-03, done 2026-09-12)"],
    },
  ]);
  assert.match(fs.readFileSync(path.join(root, "PLANS.md"), "utf8"), /## Done\n$/);
  assert.equal(fs.readFileSync(path.join(root, "PLANS-DONE.md"), "utf8"), archiveOf(`${newEntry}\n${history}`));
  assert.equal(await backlogStructureReason(root, "main", ["PLANS.md", "PLANS-DONE.md"]), undefined);
  // What the sweep wrote before the guard — every pasted entry prepended again — is rejected.
  fs.writeFileSync(path.join(root, "PLANS-DONE.md"), archiveOf(`${newEntry}\n${history}\n${history}`));
  assert.match(
    (await backlogStructureReason(root, "main", ["PLANS.md", "PLANS-DONE.md"])) ?? "",
    /^PLANS-DONE\.md adds 3 "### " headings it already carries \(first: "D0 \(planned 2026-09-01, done 2026-09-10\)"\)/,
  );
});

test("archiveFinishedOnMain drops a hand commit's re-pasted entries instead of archiving them twice", async () => {
  const root = makeRepo();
  seedCommit(root, "PLANS-DONE.md", archiveOf(`${oldEntry}\n${keptEntry}`), "seed archive");
  seedCommit(root, "PLANS.md", plans(`${newEntry}\n${oldEntry}`), "a hand commit re-pastes Old");
  ignoreInRepo(root, ".tumwater/");
  assert.deepEqual(liveFinishedHistory(root).map((l) => [l.file, l.entries]), [["PLANS.md", 2]]);
  const done = await archiveFinishedOnMain(root);
  assert.equal(done.status, "archived");
  assert.match(
    sh(root, "git", "log", "-1", "--format=%s"),
    /^tumwater\(operator\): Archive 1 finished entry to PLANS-DONE\.md; drop 1 already-archived entry$/,
  );
  assert.equal(fs.readFileSync(path.join(root, "PLANS-DONE.md"), "utf8"), archiveOf(`${newEntry}\n${oldEntry}\n${keptEntry}`));
  assert.match(fs.readFileSync(path.join(root, "PLANS.md"), "utf8"), /## Done\n$/);
  // A re-paste alone is dropped with its own subject, the archive untouched.
  seedCommit(root, "PLANS.md", plans(keptEntry), "a hand commit re-pastes Kept");
  assert.equal((await archiveFinishedOnMain(root)).status, "archived");
  assert.match(sh(root, "git", "log", "-1", "--format=%s"), /^tumwater\(operator\): Drop 1 already-archived entry from PLANS\.md$/);
  assert.equal(sh(root, "git", "diff", "--name-only", "HEAD~1", "HEAD"), "PLANS.md");
});

test("archiveNewFinishedEntries writes the move in a worktree against its merge-base", async () => {
  const root = makeRepo();
  seedCommit(root, "PLANS.md", plans("_None yet._\n").replace("## Done\n\n_None yet._\n", "## Done\n"), "seed plans");
  sh(root, "git", "checkout", "-q", "-b", "work");
  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    "# Plans\n\nIntro.\n\n## Planned\n\n_None yet._\n\n## Done\n\n### Open plan (planned 2026-10-01, done 2026-10-18)\n\nBody.\n",
  );
  const moved = await archiveNewFinishedEntries(root, "main");
  assert.deepEqual(moved, [
    { file: "PLANS.md", archive: "PLANS-DONE.md", titles: ["Open plan (planned 2026-10-01, done 2026-10-18)"], dropped: [] },
  ]);
  assert.equal(fs.readFileSync(path.join(root, "PLANS.md"), "utf8"), "# Plans\n\nIntro.\n\n## Planned\n\n_None yet._\n\n## Done\n");
  assert.match(fs.readFileSync(path.join(root, "PLANS-DONE.md"), "utf8"), /## Done\n\n### Open plan[^]*Body\.\n$/);
  assert.deepEqual(await archiveNewFinishedEntries(root, "main"), [], "a second sweep finds nothing new");
});

test("readers list the live section's finished entries first, then the archive's", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "PLANS.md"), plans("### Live (planned 2026-10-01, done 2026-10-18)\n\nL.\n"));
  fs.writeFileSync(path.join(root, "PLANS-DONE.md"), `${archiveTemplate(PLANS)}\n### Archived (planned 2026-09-01, done 2026-09-02)\n\nA.\n`);
  fs.writeFileSync(path.join(root, "BUGS-FIXED.md"), `${archiveTemplate(BUGS)}\n### Bug (found 2026-10-01; fixed 2026-10-02)\n\nF.\n`);
  assert.deepEqual(donePlans(root), ["Live (planned 2026-10-01, done 2026-10-18)", "Archived (planned 2026-09-01, done 2026-09-02)"]);
  assert.equal(donePlanEntries(root)[1]!.body, "A.");
  assert.deepEqual(fixedBugEntries(root).map((e) => e.title), ["Bug (found 2026-10-01; fixed 2026-10-02)"]);
});

test("archiveFinishedOnMain commits the bulk move on the base branch, and refuses dirty files", async () => {
  const root = makeRepo();
  seedCommit(root, "PLANS.md", plans("### D1 (planned 2026-10-02, done 2026-10-03)\n\nOne.\n"), "seed plans");
  seedCommit(root, "BUGS.md", "# Bugs\n\n## Open\n\n_None yet._\n\n## Fixed\n\n### B1 (found 2026-10-01; fixed 2026-10-02)\n\nFix.\n", "seed bugs");
  ignoreInRepo(root, ".tumwater/");
  assert.equal(checkLiveFinished(root).level, "warn");
  assert.deepEqual(liveFinishedHistory(root).map((l) => [l.file, l.entries]), [["PLANS.md", 1], ["BUGS.md", 1]]);

  fs.appendFileSync(path.join(root, "BUGS.md"), "\nstray edit\n");
  const refused = await archiveFinishedOnMain(root);
  assert.equal(refused.status, "skipped");
  assert.match(refused.status === "skipped" ? refused.reason : "", /BUGS\.md has uncommitted changes/);
  assert.equal(fs.existsSync(path.join(root, "PLANS-DONE.md")), false, "a refusal writes nothing");
  sh(root, "git", "checkout", "--", "BUGS.md");

  const done = await archiveFinishedOnMain(root);
  assert.equal(done.status, "archived");
  assert.equal(sh(root, "git", "status", "--porcelain"), "", "everything it wrote is committed");
  assert.match(sh(root, "git", "log", "-1", "--format=%s"), /^tumwater\(operator\): Archive 2 finished entries to PLANS-DONE\.md and BUGS-FIXED\.md$/);
  assert.match(fs.readFileSync(path.join(root, "PLANS.md"), "utf8"), /## Done\n$/);
  assert.match(fs.readFileSync(path.join(root, "BUGS-FIXED.md"), "utf8"), /### B1[^]*Fix\.\n$/);
  assert.equal(checkLiveFinished(root).level, "ok");
  assert.deepEqual(await archiveFinishedOnMain(root), { status: "nothing" });
});

test("tumwater archive dispatches through the CLI to archive finished entries and commit, then finds nothing", async () => {
  // cli.ts's `case \"archive\"` glue (arg rejection, ready-repo gate, cmdArchive dispatch) was
  // reached only through the archiveFinishedOnMain unit tests, never by a spawned `tumwater`
  // command; a dispatch regression (a wrong import or gate) would pass those yet break the CLI.
  const root = await initializedRepo();
  ignoreInRepo(root, ".tumwater/");
  fs.writeFileSync(path.join(root, "PLANS.md"), plans("### D1 (planned 2026-10-02, done 2026-10-03)\n\nOne.\n"));
  fs.writeFileSync(path.join(root, "BUGS.md"), "# Bugs\n\n## Open\n\n_None yet._\n\n## Fixed\n\n### B1 (found 2026-10-01; fixed 2026-10-02)\n\nFix.\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed finished entries");

  const moved = await cli(root, "archive");
  assert.equal(moved.code, 0, moved.stderr);
  assert.match(moved.stdout, /PLANS\.md → .*PLANS-DONE\.md: 1 entry/);
  assert.match(moved.stdout, /BUGS\.md → .*BUGS-FIXED\.md: 1 entry/);
  assert.match(sh(root, "git", "log", "-1", "--format=%s"), /^tumwater\(operator\): Archive 2 finished entries/);

  const again = await cli(root, "archive");
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /nothing to archive/);
});

test("a change committed before the archive rebases onto it: its new entry stays, the history it sat above does not return", async () => {
  // The migration shape (plans/backlog-archive.md): a branch pasted an entry at the top of a
  // long live ## Done, and main has since moved that history to the archive.
  const root = makeRepo();
  const history = Array.from({ length: 3 }, (_, i) => `### D${i} (planned 2026-09-0${i + 1}, done 2026-09-1${i})\n\nBody ${i}.\n`).join("\n");
  seedCommit(root, "PLANS.md", plans(history), "seed plans");
  sh(root, "git", "worktree", "add", "-q", "-b", "work", path.join(root, "wt"));
  const wt = path.join(root, "wt");
  seedCommit(wt, "PLANS.md", plans(`### X (planned 2026-10-01, done 2026-10-18)\n\nNew.\n\n${history}`), "finish X");
  ignoreInRepo(root, ".tumwater/", "wt/");
  assert.equal((await archiveFinishedOnMain(root)).status, "archived");

  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");
  assert.deepEqual(await resolveBacklogInsertConflicts(wt, await conflictedFiles(wt)), []);
  const resolved = fs.readFileSync(path.join(wt, "PLANS.md"), "utf8");
  assert.match(resolved, /## Done\n\n### X [^]*New\.\n/);
  assert.doesNotMatch(resolved, /### D\d/, "the archived history is not restored");
  assert.doesNotMatch(resolved, /^(<{7}|>{7})/m);
});

test("the settler keeps a change's new entries above a finished section main rewrote, and only there", () => {
  const hunk = (ours: string[], base: string[], theirs: string[]): string =>
    ["<<<<<<< HEAD", ...ours, "||||||| parent of abc", ...base, "=======", ...theirs, ">>>>>>> abc"].join("\n");
  const base = ["### D1 (done 2026-09-01)", "", "Old."];
  const doc = `## Done\n\n${hunk([], base, ["### X (done 2026-10-18)", "", "New.", "", ...base])}\n`;
  assert.equal(resolveInsertOnlyText(doc), "## Done\n\n### X (done 2026-10-18)\n\nNew.\n\n");
  // Against a main side that rewrote those lines rather than archiving them, the change's
  // entries stack on main's rewrite, and the same hunk under an open section is the resolver's.
  // (Main's deletion settles in any section — test/backlog-conflicts.test.ts.)
  const rewritten = `## Done\n\n${hunk(["### D1 (done 2026-09-01)", "", "Reworded."], base, ["### X (done 2026-10-18)", "", "New.", "", ...base])}\n`;
  assert.equal(resolveInsertOnlyText(rewritten), "## Done\n\n### X (done 2026-10-18)\n\nNew.\n\n### D1 (done 2026-09-01)\n\nReworded.\n");
  assert.equal(resolveInsertOnlyText(rewritten.replace("## Done", "## Planned")), null);
  // A change side that edits the base lines rather than only adding above them is not this shape.
  assert.equal(resolveInsertOnlyText(`## Done\n\n${hunk([], base, ["### X", "", "### D1 (done 2026-09-01)", "", "Edited."])}\n`), null);
  // Lines that are not whole entries are not this shape either.
  assert.equal(resolveInsertOnlyText(`## Done\n\n${hunk([], base, ["stray prose", ...base])}\n`), null);
});

test("the false-fix check reads the archive: an intact archived entry is no claim, a new phantom one is", async () => {
  const root = makeRepo();
  const fixed = "### Old bug (found 2026-09-01; fixed 2026-09-02)\n\n**Fix:** `phantomSymbolNowhere` was added.\n";
  seedCommit(root, "BUGS.md", `# Bugs\n\n## Open\n\n_None yet._\n\n## Fixed\n\n${fixed}`, "seed bugs");
  sh(root, "git", "checkout", "-q", "-b", "work");
  // The bulk archive's shape: the entry moves to BUGS-FIXED.md with its body intact.
  fs.writeFileSync(path.join(root, "BUGS.md"), "# Bugs\n\n## Open\n\n_None yet._\n\n## Fixed\n");
  fs.writeFileSync(path.join(root, "BUGS-FIXED.md"), `${archiveTemplate(BUGS)}\n${fixed}`);
  const files = ["BUGS.md", "BUGS-FIXED.md"];
  assert.equal(await falseFixReason(root, "main", files), undefined);
  // A fix claimed straight into the archive faces the symbol check like one under ## Fixed.
  fs.writeFileSync(
    path.join(root, "BUGS-FIXED.md"),
    `${archiveTemplate(BUGS)}\n### New bug (found 2026-10-01; fixed 2026-10-18)\n\n**Fix:** \`anotherPhantomName\` handles it.\n\n${fixed}`,
  );
  assert.match((await falseFixReason(root, "main", ["BUGS-FIXED.md"])) ?? "", /"New bug[^"]*" to Fixed.*anotherPhantomName/);
});

test("the structure check rejects a new plan with no done date filed into PLANS-DONE.md, and passes an archived move", async () => {
  const root = makeRepo();
  seedCommit(root, "PLANS.md", plans(""), "seed plans");
  sh(root, "git", "checkout", "-q", "-b", "work");
  fs.writeFileSync(path.join(root, "PLANS.md"), "# Plans\n\nIntro.\n\n## Planned\n\n_None yet._\n\n## Done\n");
  fs.writeFileSync(path.join(root, "PLANS-DONE.md"), `${archiveTemplate(PLANS)}\n### Open plan (planned 2026-10-01, done 2026-10-18)\n\nBody.\n`);
  assert.equal(await backlogStructureReason(root, "main", ["PLANS.md", "PLANS-DONE.md"]), undefined);
  fs.writeFileSync(
    path.join(root, "PLANS-DONE.md"),
    `${archiveTemplate(PLANS)}\n### Brand new (planned 2026-10-18)\n\nX.\n\n### Open plan (planned 2026-10-01, done 2026-10-18)\n\nBody.\n`,
  );
  assert.match(
    (await backlogStructureReason(root, "main", ["PLANS.md", "PLANS-DONE.md"])) ?? "",
    /PLANS-DONE\.md files "Brand new \(planned 2026-10-18\)" directly under "## Done" with no done date.*"## Planned" in PLANS\.md/,
  );
});

test("archiveFinishedOnMain restores the checkout when a file write fails, and archives on the next call", async () => {
  const root = makeRepo();
  seedCommit(root, "PLANS.md", plans("### D1 (planned 2026-10-02, done 2026-10-03)\n\nOne.\n"), "seed plans");
  seedCommit(root, "BUGS.md", "# Bugs\n\n## Open\n\n_None yet._\n\n## Fixed\n\n### B1 (found 2026-10-01; fixed 2026-10-02)\n\nFix.\n", "seed bugs");
  ignoreInRepo(root, ".tumwater/");
  const commits = sh(root, "git", "rev-list", "--count", "HEAD");
  const restore = failRenameSyncOn(path.join(root, "BUGS.md"), "disk full");
  let failed;
  try {
    failed = await archiveFinishedOnMain(root);
  } finally {
    restore();
  }
  assert.equal(failed.status, "skipped");
  assert.match(failed.status === "skipped" ? failed.reason : "", /disk full/);
  assert.equal(sh(root, "git", "status", "--porcelain"), "");
  assert.equal(fs.existsSync(path.join(root, "PLANS-DONE.md")), false);
  assert.equal(fs.existsSync(path.join(root, "BUGS-FIXED.md")), false);
  assert.match(fs.readFileSync(path.join(root, "PLANS.md"), "utf8"), /### D1/);
  assert.equal(sh(root, "git", "rev-list", "--count", "HEAD"), commits);

  assert.equal((await archiveFinishedOnMain(root)).status, "archived");
  assert.equal(sh(root, "git", "status", "--porcelain"), "");
});

test("fileQuarantineBugsOnMain restores BUGS.md when a second entry's write fails, and files both on the next call", async () => {
  const root = makeRepo();
  const seeded = "# Bugs\n\n## Open\n\n## Fixed\n";
  seedCommit(root, "BUGS.md", seeded, "seed");
  ignoreInRepo(root, ".tumwater/");
  const commits = sh(root, "git", "rev-list", "--count", "HEAD");
  const prefix = `${path.join(root, "BUGS.md")}.tmp-`;
  let writes = 0;
  const undo = patchFsMethod("renameSync", (orig) => (a, b) => {
    if (typeof a === "string" && a.startsWith(prefix) && ++writes === 2) throw new Error("disk full");
    return orig(a, b);
  });
  let failed;
  try {
    failed = await fileQuarantineBugsOnMain(root, [{ test: "flaky one" }, { test: "flaky two" }]);
  } finally {
    undo();
  }
  assert.equal(failed.status, "skipped");
  assert.match(failed.status === "skipped" ? failed.reason : "", /disk full/);
  assert.equal(sh(root, "git", "status", "--porcelain"), "");
  assert.equal(fs.readFileSync(path.join(root, "BUGS.md"), "utf8"), seeded);
  assert.equal(sh(root, "git", "rev-list", "--count", "HEAD"), commits);

  const filed = await fileQuarantineBugsOnMain(root, [{ test: "flaky one" }, { test: "flaky two" }]);
  assert.equal(filed.status, "filed");
  assert.deepEqual(filed.status === "filed" ? [...filed.bugs.keys()] : [], ["flaky one", "flaky two"]);
  const text = fs.readFileSync(path.join(root, "BUGS.md"), "utf8");
  assert.equal(text.split("failed, then passed on the same tree (quarantined by tumwater").length - 1, 2);
  assert.equal(Number(sh(root, "git", "rev-list", "--count", "HEAD")), Number(commits) + 1);
  assert.equal(sh(root, "git", "status", "--porcelain"), "");
});

/** Make `fs.readFileSync` of exactly `file` throw EMFILE until the returned undo runs. */
function emfileOnRead(file: string): () => void {
  return patchFsMethod("readFileSync", (orig) => (p, ...rest) => {
    if (p === file) throw errnoError("EMFILE");
    return orig(p, ...rest);
  });
}

test("fileQuarantineBugsOnMain skips and leaves BUGS.md in place when BUGS.md cannot be read", async () => {
  const root = makeRepo();
  const seeded = "# Bugs\n\n## Open\n\n## Fixed\n";
  seedCommit(root, "BUGS.md", seeded, "seed");
  ignoreInRepo(root, ".tumwater/");
  const commits = sh(root, "git", "rev-list", "--count", "HEAD");
  const undo = emfileOnRead(path.join(root, "BUGS.md"));
  let skipped;
  try {
    skipped = await fileQuarantineBugsOnMain(root, [{ test: "flaky one" }]);
  } finally {
    undo();
  }
  assert.equal(skipped.status, "skipped");
  assert.match(skipped.status === "skipped" ? skipped.reason : "", /BUGS\.md could not be read: EMFILE/);
  assert.equal(fs.readFileSync(path.join(root, "BUGS.md"), "utf8"), seeded);
  assert.equal(sh(root, "git", "status", "--porcelain"), "");
  assert.equal(sh(root, "git", "rev-list", "--count", "HEAD"), commits);
  assert.equal((await fileQuarantineBugsOnMain(root, [{ test: "flaky one" }])).status, "filed");
});

test("archiveFinishedOnMain skips and leaves the archive intact when an archive file cannot be read", async () => {
  const root = makeRepo();
  seedCommit(root, "PLANS.md", plans("### D1 (planned 2026-10-02, done 2026-10-03)\n\nOne.\n"), "seed plans");
  const archive = "# Plans done\n\n## Done\n\n### Old (planned 2026-09-01, done 2026-09-02)\n\nOld body.\n";
  seedCommit(root, "PLANS-DONE.md", archive, "seed archive");
  ignoreInRepo(root, ".tumwater/");
  const plansBefore = fs.readFileSync(path.join(root, "PLANS.md"), "utf8");
  const commits = sh(root, "git", "rev-list", "--count", "HEAD");
  const undo = emfileOnRead(path.join(root, "PLANS-DONE.md"));
  let skipped;
  try {
    skipped = await archiveFinishedOnMain(root);
  } finally {
    undo();
  }
  assert.equal(skipped.status, "skipped");
  assert.match(skipped.status === "skipped" ? skipped.reason : "", /could not be read: EMFILE/);
  assert.equal(fs.readFileSync(path.join(root, "PLANS-DONE.md"), "utf8"), archive);
  assert.equal(fs.readFileSync(path.join(root, "PLANS.md"), "utf8"), plansBefore);
  assert.equal(sh(root, "git", "status", "--porcelain"), "");
  assert.equal(sh(root, "git", "rev-list", "--count", "HEAD"), commits);
});

test("archiveNewFinishedEntries rejects and writes nothing when the archive file cannot be read", async () => {
  const root = makeRepo();
  seedCommit(root, "PLANS.md", plans("_None yet._\n").replace("## Done\n\n_None yet._\n", "## Done\n"), "seed plans");
  const archive = "# Plans done\n\n## Done\n\n### Old (planned 2026-09-01, done 2026-09-02)\n\nOld body.\n";
  seedCommit(root, "PLANS-DONE.md", archive, "seed archive");
  sh(root, "git", "checkout", "-q", "-b", "work");
  const edited =
    "# Plans\n\nIntro.\n\n## Planned\n\n_None yet._\n\n## Done\n\n### Open plan (planned 2026-10-01, done 2026-10-18)\n\nBody.\n";
  fs.writeFileSync(path.join(root, "PLANS.md"), edited);
  const undo = emfileOnRead(path.join(root, "PLANS-DONE.md"));
  try {
    await assert.rejects(archiveNewFinishedEntries(root, "main"), /EMFILE/);
  } finally {
    undo();
  }
  assert.equal(fs.readFileSync(path.join(root, "PLANS.md"), "utf8"), edited);
  assert.equal(fs.readFileSync(path.join(root, "PLANS-DONE.md"), "utf8"), archive);
});
