import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  mergeBacklogEntries,
  resolveBacklogInsertConflicts,
  resolveInsertOnlyText,
} from "../src/merge/merge-backlog-conflicts.js";
import { conflictedFiles, rebaseOntoMainLeaveConflicts } from "../src/merge/merge-git.js";
import { makeRepo, seedCommit, sh } from "./fixtures/repo-fixtures.js";

// Branches of the entry-by-entry backlog merge that test/merge-backlog-conflicts.test.ts leaves
// unpinned: the archive guard, placement without a surviving predecessor, a heading both sides
// added, and a preamble or section header only one side changed.

const doc = (...entries: string[]): string => `# Plans\n\n## Planned\n\n${entries.map((e) => `${e}\n`).join("\n")}\n## Done\n`.replace("\n\n\n## Done", "\n\n## Done");
const ent = (name: string, body = name): string => `### ${name} plan\n\n**Goal.** ${body}.`;
const [A, B, C, D, N, M] = [ent("A"), ent("B"), ent("C"), ent("D"), ent("N"), ent("M")] as [
  string, string, string, string, string, string,
];

test("resolveBacklogInsertConflicts leaves an archive conflict the hunk settler cannot settle to the resolver", async () => {
  for (const file of ["PLANS-DONE.md", "BUGS-FIXED.md"]) {
    const root = makeRepo();
    seedCommit(root, file, doc(A, B, C), "seed archive");
    sh(root, "git", "checkout", "-q", "-b", "change");
    seedCommit(root, file, doc(A, C), "the change finishes B");
    sh(root, "git", "checkout", "-q", "main");
    seedCommit(root, file, doc(B, D), "main finishes A and C, adds D");
    sh(root, "git", "checkout", "-q", "change");
    assert.equal(await rebaseOntoMainLeaveConflicts(root, "main"), "conflict");
    const conflicted = fs.readFileSync(path.join(root, file), "utf8");
    assert.equal(resolveInsertOnlyText(conflicted), null, "the hunk settler alone leaves it");

    const remaining = await resolveBacklogInsertConflicts(root, await conflictedFiles(root));

    assert.deepEqual(remaining, [file]);
    assert.match(fs.readFileSync(path.join(root, file), "utf8"), /<<<<<<</);
    assert.match(sh(root, "git", "ls-files", "-u", "--", file), /^\d+ \w+ [123]\t/, "still unmerged");
  }
});

test("mergeBacklogEntries places the change's new entry after its nearest surviving predecessor, keeps one copy of an entry both sides added, and settles a preamble or header only one side changed", () => {
  assert.equal(mergeBacklogEntries(doc(A, B), doc(B), doc(A, M, B)), doc(M, B), "no predecessor");

  assert.equal(mergeBacklogEntries(doc(A), doc(A, N), doc(A, N)), doc(A, N), "same addition");
  assert.equal(mergeBacklogEntries(doc(A), doc(A, N), doc(A, ent("N", "other"))), null, "differing");

  const intro = (text: string, note: string): string => text.replace("# Plans", `# Plans\n\n${note}`);
  assert.equal(
    mergeBacklogEntries(doc(A), doc(A, N), intro(doc(A), "Intro.")),
    intro(doc(A, N), "Intro."),
    "preamble changed by one side",
  );
  assert.equal(
    mergeBacklogEntries(doc(A), intro(doc(A), "Intro one."), intro(doc(A), "Intro two.")),
    null,
    "preamble changed by both",
  );

  const note = (text: string, n: string): string => text.replace("## Planned", `## Planned\n\n${n}`);
  assert.equal(
    mergeBacklogEntries(doc(A), doc(A, N), note(doc(A), "Queue note.")),
    note(doc(A, N), "Queue note."),
    "header changed by one side",
  );
  assert.equal(
    mergeBacklogEntries(doc(A), note(doc(A), "Note one."), note(doc(A), "Note two.")),
    null,
    "header changed by both",
  );
});
