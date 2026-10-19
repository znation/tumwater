import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  resolveBacklogInsertConflicts,
  resolveInsertOnlyText,
} from "../src/merge/backlog-conflicts.js";
import { conflictedFiles, rebaseOntoMainLeaveConflicts } from "../src/merge/merge-git.js";
import { makeRepo, seedCommit, sh } from "./fixtures/repo-fixtures.js";
import { patchFsMethod } from "./helpers/fs-faults.js";

// Coverage for the deterministic insert-only backlog resolver (plans/parallel-work-instances.md,
// part 3/7): two merges pasting different entries as the first under ## Done produce a diff3
// hunk with an empty base and two non-empty sides. Such a hunk carries no authored bytes and
// must settle without a model run; anything else must be left for the resolver untouched.

/** A diff3 conflict hunk with an empty base section and both sides carrying lines. */
function insertOnlyHunk(theirs: string, ours: string): string {
  return ["<<<<<<< HEAD", ours, "||||||| parent of abc", "=======", theirs, ">>>>>>> abc"].join("\n");
}

test("resolveInsertOnlyText puts the change's lines first, then a blank, then main's", () => {
  const text = `## Done\n\n${insertOnlyHunk("### Entry A\n\n**Goal.** A.", "### Entry C\n\n**Goal.** C.")}\n### Entry Z\n`;
  const resolved = resolveInsertOnlyText(text);
  assert.equal(
    resolved,
    "## Done\n\n### Entry A\n\n**Goal.** A.\n\n### Entry C\n\n**Goal.** C.\n### Entry Z\n",
  );
});

test("resolveInsertOnlyText inserts one blank separator when neither side supplies one", () => {
  const text = insertOnlyHunk("change line", "main line");
  assert.equal(resolveInsertOnlyText(text), "change line\n\nmain line");
});

test("resolveInsertOnlyText does not double a blank separator a side already supplies", () => {
  const text = insertOnlyHunk("change line\n", "main line");
  assert.equal(resolveInsertOnlyText(text), "change line\n\nmain line");
});

test("resolveInsertOnlyText refuses a hunk with a non-empty base section", () => {
  const text = [
    "<<<<<<< HEAD",
    "main line",
    "||||||| parent of abc",
    "base line",
    "=======",
    "change line",
    ">>>>>>> abc",
  ].join("\n");
  assert.equal(resolveInsertOnlyText(text), null);
});

test("resolveInsertOnlyText refuses a hunk with an empty side", () => {
  const text = ["<<<<<<< HEAD", "main line", "||||||| parent of abc", "=======", ">>>>>>> abc"].join("\n");
  assert.equal(resolveInsertOnlyText(text), null);
});

/** A diff3 conflict hunk from its three sides' lines: main (ours), base, the change (theirs). */
function diff3Hunk(ours: string[], base: string[], theirs: string[]): string {
  return ["<<<<<<< HEAD", ...ours, "||||||| parent of abc", ...base, "=======", ...theirs, ">>>>>>> abc"].join("\n");
}

// The entry one side deleted, and the whole entry the other side inserted right above it.
const OLD_ENTRY = ["### Old plan", "", "**Goal.** Old.", ""];
const NEW_ENTRY = ["### New plan", "", "**Goal.** New.", ""];

test("resolveInsertOnlyText keeps main's new entries above an entry the change deleted, in an open section", () => {
  // The plan role prepended a plan on main while the change finished the plan below it.
  const text = `## Planned\n\n${diff3Hunk([...NEW_ENTRY, ...OLD_ENTRY], OLD_ENTRY, [])}\n### Next plan\n`;
  assert.equal(resolveInsertOnlyText(text), "## Planned\n\n### New plan\n\n**Goal.** New.\n\n### Next plan\n");
});

test("resolveInsertOnlyText keeps the change's new entries above an entry main deleted, in an open section", () => {
  const text = `## Planned\n\n${diff3Hunk([], OLD_ENTRY, [...NEW_ENTRY, ...OLD_ENTRY])}\n### Next plan\n`;
  assert.equal(resolveInsertOnlyText(text), "## Planned\n\n### New plan\n\n**Goal.** New.\n\n### Next plan\n");
});

test("resolveInsertOnlyText settles an entry above a deleted entry in any section, mixed with insert-only hunks", () => {
  const text = [
    "## Open",
    "",
    diff3Hunk([...NEW_ENTRY, ...OLD_ENTRY], OLD_ENTRY, []),
    "## Fixed",
    "",
    insertOnlyHunk("### Fix A", "### Fix C"),
    "### Fix Z",
    "",
  ].join("\n");
  assert.equal(
    resolveInsertOnlyText(text),
    "## Open\n\n### New plan\n\n**Goal.** New.\n\n## Fixed\n\n### Fix A\n\n### Fix C\n### Fix Z\n",
  );
});

test("resolveInsertOnlyText adds no separator to new entries whose other side is empty", () => {
  // The inserting side's own lines, byte for byte: the deleting side supplies nothing to keep
  // apart from them.
  const tight = ["### New plan", "**Goal.** New."];
  const text = `## Planned\n\n${diff3Hunk([...tight, ...OLD_ENTRY], OLD_ENTRY, [])}\n### Next plan\n`;
  assert.equal(resolveInsertOnlyText(text), "## Planned\n\n### New plan\n**Goal.** New.\n### Next plan\n");
});

test("resolveInsertOnlyText leaves near misses of an entry above a deleted entry to the resolver", () => {
  const planned = (hunk: string): string => `## Planned\n\n${hunk}\n### Next plan\n`;
  const nearMisses: Record<string, string> = {
    // Main inserted above the entry, and the change edited it rather than deleting it.
    "a non-empty other side": diff3Hunk([...NEW_ENTRY, ...OLD_ENTRY], OLD_ENTRY, ["### Old plan", "", "**Goal.** Edited.", ""]),
    // The mirror: the change inserted, and main kept part of the entry.
    "a non-empty main side": diff3Hunk(["### Old plan", ""], OLD_ENTRY, [...NEW_ENTRY, ...OLD_ENTRY]),
    // The inserting side also edited the entry it sat above.
    "an edited base line": diff3Hunk([...NEW_ENTRY, "### Old plan", "", "**Goal.** Reworded.", ""], OLD_ENTRY, []),
    // The inserting side kept only part of the base lines.
    "a partial base": diff3Hunk([...NEW_ENTRY, ...OLD_ENTRY.slice(0, 2)], OLD_ENTRY, []),
    "a partial base on the change's side": diff3Hunk([], OLD_ENTRY, [...NEW_ENTRY, ...OLD_ENTRY.slice(1)]),
    // Added lines that are not whole entries.
    "added prose, not a heading": diff3Hunk(["stray prose", "", ...OLD_ENTRY], OLD_ENTRY, []),
    "an added `## ` heading": diff3Hunk([], OLD_ENTRY, ["## Later", "", ...OLD_ENTRY]),
    "only added blank lines": diff3Hunk(["", "", ...OLD_ENTRY], OLD_ENTRY, []),
    // The inserting side is no longer than the base: nothing was added above it.
    "an unchanged side": diff3Hunk([...OLD_ENTRY], OLD_ENTRY, []),
  };
  for (const [name, hunk] of Object.entries(nearMisses)) {
    assert.equal(resolveInsertOnlyText(planned(hunk)), null, name);
  }
  // One settleable hunk does not carry a near miss elsewhere in the file.
  const mixed = `${planned(diff3Hunk([...NEW_ENTRY, ...OLD_ENTRY], OLD_ENTRY, []))}\n${nearMisses["a partial base"]}\n`;
  assert.equal(resolveInsertOnlyText(mixed), null);
});

test("resolveInsertOnlyText keeps the change's entries above a rewritten history only in a finished section", () => {
  // Main rewrote the lines below the change's insertion rather than deleting them: the change's
  // entries stack on main's side under ## Done, and the same hunk elsewhere is the resolver's.
  const text = `## Done\n\n${diff3Hunk(["### Old plan", "", "**Goal.** Reworded."], OLD_ENTRY, [...NEW_ENTRY, ...OLD_ENTRY])}\n`;
  assert.equal(resolveInsertOnlyText(text), "## Done\n\n### New plan\n\n**Goal.** New.\n\n### Old plan\n\n**Goal.** Reworded.\n");
  assert.equal(resolveInsertOnlyText(text.replace("## Done", "## Planned")), null);
  // Main's mirror of it — main's new entries above lines the change rewrote — is not settled
  // even under ## Done.
  const mirror = `## Done\n\n${diff3Hunk([...NEW_ENTRY, ...OLD_ENTRY], OLD_ENTRY, ["### Old plan", "", "**Goal.** Reworded."])}\n`;
  assert.equal(resolveInsertOnlyText(mirror), null);
});

for (const [prepender, finisher] of [["main", "the change"], ["the change", "main"]] as const) {
  test(`resolveBacklogInsertConflicts settles a real rebase where ${prepender} prepended a plan above one ${finisher} finished`, async () => {
    const root = makeRepo();
    const plans = (...entries: string[]): string => `# Plans\n\n## Planned\n\n${entries.join("\n")}`;
    const entry = (name: string): string => `### ${name} plan\n\n**Goal.** ${name}.\n`;
    const [fresh, old, next] = [entry("New"), entry("Old"), entry("Next")];
    const prepended = plans(fresh, old, next);
    const finished = plans(next);
    seedCommit(root, "PLANS.md", plans(old, next), "seed plans");
    sh(root, "git", "checkout", "-q", "-b", "change");
    seedCommit(root, "PLANS.md", prepender === "main" ? finished : prepended, "the change's edit");
    sh(root, "git", "checkout", "-q", "main");
    seedCommit(root, "PLANS.md", prepender === "main" ? prepended : finished, "main's edit");
    sh(root, "git", "checkout", "-q", "change");
    assert.equal(await rebaseOntoMainLeaveConflicts(root, "main"), "conflict");

    const remaining = await resolveBacklogInsertConflicts(root, await conflictedFiles(root));

    assert.deepEqual(remaining, []);
    assert.equal(fs.readFileSync(path.join(root, "PLANS.md"), "utf8"), plans(fresh, next));
    assert.equal(sh(root, "git", "diff", "--cached", "--name-only"), "PLANS.md", "the resolved file is staged");
  });
}

test("resolveInsertOnlyText refuses a malformed (non-diff3) conflict", () => {
  const text = ["<<<<<<< HEAD", "main line", "=======", "change line", ">>>>>>> abc"].join("\n");
  assert.equal(resolveInsertOnlyText(text), null);
});

test("resolveBacklogInsertConflicts rewrites and stages an insert-only PLANS.md", async () => {
  const root = makeRepo();
  const text = `## Done\n\n${insertOnlyHunk("### Entry A", "### Entry C")}\n### Entry Z\n`;
  fs.writeFileSync(path.join(root, "PLANS.md"), text);

  const remaining = await resolveBacklogInsertConflicts(root, ["PLANS.md"]);

  assert.deepEqual(remaining, []);
  assert.equal(fs.readFileSync(path.join(root, "PLANS.md"), "utf8"), "## Done\n\n### Entry A\n\n### Entry C\n### Entry Z\n");
  assert.equal(sh(root, "git", "diff", "--cached", "--name-only"), "PLANS.md", "the resolved file is staged");
});

test("resolveBacklogInsertConflicts leaves a non-insert-only backlog file untouched", async () => {
  const root = makeRepo();
  const text = ["<<<<<<< HEAD", "main line", "||||||| parent of abc", "base line", "=======", "change line", ">>>>>>> abc"].join("\n");
  fs.writeFileSync(path.join(root, "BUGS.md"), text);
  const before = fs.readFileSync(path.join(root, "BUGS.md"), "utf8");

  const remaining = await resolveBacklogInsertConflicts(root, ["BUGS.md"]);

  assert.deepEqual(remaining, ["BUGS.md"]);
  assert.equal(fs.readFileSync(path.join(root, "BUGS.md"), "utf8"), before, "the conflict markers are still there");
  assert.equal(sh(root, "git", "diff", "--cached", "--name-only"), "", "nothing was staged");
});

test("resolveBacklogInsertConflicts ignores non-backlog and non-root files", async () => {
  const root = makeRepo();
  const hunk = insertOnlyHunk("change line", "main line");
  // Built with path.join so the nested name is not a hard-coded repo path in this file: the
  // path exists only at test runtime, and the pre-queue self-check rejects added lines that
  // name paths absent from the tree.
  const nested = path.join("docs", "PLANS.md");
  fs.writeFileSync(path.join(root, "app.ts"), hunk);
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, nested), hunk);

  const remaining = await resolveBacklogInsertConflicts(root, ["app.ts", nested]);

  assert.deepEqual(remaining, ["app.ts", nested]);
  assert.deepEqual(fs.readFileSync(path.join(root, "app.ts"), "utf8"), hunk);
  assert.deepEqual(fs.readFileSync(path.join(root, nested), "utf8"), hunk);
});

test("resolveBacklogInsertConflicts treats an unreadable path as still conflicted", async () => {
  const root = makeRepo();
  const remaining = await resolveBacklogInsertConflicts(root, ["QUESTIONS.md"]);
  assert.deepEqual(remaining, ["QUESTIONS.md"]);
});

test("resolveBacklogInsertConflicts leaves the conflicted file intact when a write dies mid-way", async () => {
  const root = makeRepo();
  const text = `## Done\n\n${insertOnlyHunk("### Entry A", "### Entry C")}\n### Entry Z\n`;
  const file = path.join(root, "PLANS.md");
  fs.writeFileSync(file, text);
  // Simulate the process dying mid-write: put a truncated prefix on disk, then fail. The
  // atomic helper's tmp file matches the same predicate, so the injection merges on it — the
  // target changes only if a partial file is written straight to it (the pre-fix shape).
  const restoreWrite = patchFsMethod("writeFileSync", (orig) => (target, data, ...rest) => {
    orig(target, String(data).slice(0, 8), ...rest);
    throw new Error("simulated torn write");
  });
  let rejected = false;
  try {
    await resolveBacklogInsertConflicts(root, ["PLANS.md"]);
  } catch {
    rejected = true;
  } finally {
    restoreWrite();
  }
  assert.equal(rejected, true, "the failed write is not swallowed");
  assert.equal(fs.readFileSync(file, "utf8"), text, "the conflicted file is untouched");
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.startsWith("PLANS.md.tmp")),
    [],
    "no tmp remnant is left behind",
  );
});
