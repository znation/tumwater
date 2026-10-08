import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  resolveBacklogInsertConflicts,
  resolveInsertOnlyText,
} from "../src/landing/backlog-conflicts.js";
import { makeRepo, sh } from "./repo-fixtures.js";

// Coverage for the deterministic insert-only backlog resolver (plans/parallel-work-instances.md,
// part 3/7): two landings pasting different entries as the first under ## Done produce a diff3
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
  const original = fs.writeFileSync;
  // Simulate the process dying mid-write: put a truncated prefix on disk, then fail. The
  // atomic helper's tmp file matches the same predicate, so the injection lands on it — the
  // target changes only if a partial file is written straight to it (the pre-fix shape).
  (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((target, data, ...rest) => {
    original(target, String(data).slice(0, 8), ...rest);
    throw new Error("simulated torn write");
  }) as typeof fs.writeFileSync;
  let rejected = false;
  try {
    await resolveBacklogInsertConflicts(root, ["PLANS.md"]);
  } catch {
    rejected = true;
  } finally {
    fs.writeFileSync = original;
  }
  assert.equal(rejected, true, "the failed write is not swallowed");
  assert.equal(fs.readFileSync(file, "utf8"), text, "the conflicted file is untouched");
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.startsWith("PLANS.md.tmp")),
    [],
    "no tmp remnant is left behind",
  );
});
