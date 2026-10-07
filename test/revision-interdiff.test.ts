import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { revisionInterdiff } from "../src/git/git-diff.js";
import { headOf } from "../src/git/git.js";
import { commitIn, makeRepo, sh } from "./repo-fixtures.js";

/** Unit coverage for the revision interdiff (plans/revise-rejected.md part 2/2): the re-review
 * compares a rejected change with its revision over each version's own base..tip range, so
 * main's movement between the two versions is not mistaken for part of the revision. */

test("revisionInterdiff shows only the revision's amendment, not main's movement", async () => {
  const root = makeRepo();
  // The rejected change: adds feature.ts with two lines.
  sh(root, "git", "checkout", "-b", "rejected-work");
  fs.writeFileSync(path.join(root, "feature.ts"), "export const a = 1;\nexport const b = 2;\n");
  commitIn(root, "the rejected change");
  const priorSha = sh(root, "git", "rev-parse", "HEAD").trim();
  // main moves on in an unrelated file while the review runs.
  sh(root, "git", "checkout", "main");
  fs.writeFileSync(path.join(root, "other.ts"), "export const other = true;\n");
  commitIn(root, "move main");
  // The revision: rebase the rejected change onto the moved main and amend one line.
  sh(root, "git", "checkout", "rejected-work");
  sh(root, "git", "rebase", "main");
  fs.writeFileSync(path.join(root, "feature.ts"), "export const a = 1;\nexport const b = 3;\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "--amend", "-m", "the rejected change");
  const head = await headOf(root, "HEAD");

  const interdiff = await revisionInterdiff(root, "main", priorSha, head);

  assert.match(interdiff, /export const b = 2;/);
  assert.match(interdiff, /export const b = 3;/);
  assert.doesNotMatch(interdiff, /other\.ts/, "main's own movement is not part of the interdiff");
});

test("revisionInterdiff returns an empty string when the prior object is gone", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "f.txt"), "x\n");
  commitIn(root, "some change");
  const head = await headOf(root, "HEAD");

  assert.equal(await revisionInterdiff(root, "main", "0".repeat(40), head), "");
});
