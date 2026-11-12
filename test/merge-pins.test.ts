/** Direct unit tests for the live merge-pin view (src/merge/merge-pins.ts `readMergePins`).
 * The doctor and orchestrator reach it indirectly, but this file pins the pin-reader's own
 * contract: the per-role read (roleIds), the no-roles-named listing that derives each pin's
 * role from its ref name, and the dangling-pin unreadable count — the branches a caller that
 * names roles never exercises. */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readMergePins } from "../src/merge/merge-pins.js";
import { mergeRefName } from "../src/paths.js";
import { makeRepo, sh, seedCommit, headSha } from "./fixtures/repo-fixtures.js";

/** Commit one file with the given subject and message, then pin it as the role's waiting merge
 * ref. The commit's committer date matches `ageMs`-ago, so the entry's age source is set. */
function pinCommit(
  root: string,
  role: string,
  file: string,
  subject: string,
  message: string,
  ageMs: number,
  now: number,
): void {
  const iso = new Date(now - ageMs).toISOString();
  seedCommit(root, file, `${file}\n`, subject);
  execFileSync("git", ["commit", "--amend", "-m", message], {
    cwd: root,
    env: { ...process.env, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso },
  });
  sh(root, "git", "update-ref", mergeRefName(role), headSha(root));
}

/** Pin `sha` under the merge prefix so the ref names a commit the repo does not hold — a
 * dangling pin. git itself refuses `update-ref` to a nonexistent object, so the ref file is
 * written directly (the shape `for-each-ref` would list and `cat-file -e` would reject). */
function pinDangling(root: string, role: string): void {
  const ref = path.join(root, ".git", "refs", "tumwater", "merge", role);
  fs.mkdirSync(path.dirname(ref), { recursive: true });
  fs.writeFileSync(ref, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n");
}

test("readMergePins with roleIds reads each pin's sha, run trailer, summary and commit-date age", async () => {
  const root = makeRepo();
  const now = Date.now();
  // A harness-stamped commit: subject carries the role stamp, body carries a `Run: <role> #N` line.
  const run = 7;
  const subject = "tidy parser";
  const message = `tumwater(feature): ${subject}\n\nRun: feature #${run} · turns 3 · ctx 1.2k`;
  pinCommit(root, "feature", "a.txt", subject, message, 10 * 60 * 1000, now);

  const { entries, unreadable } = await readMergePins(root, ["feature"]);
  assert.equal(unreadable, 0);
  assert.equal(entries.length, 1);
  assert.ok(entries[0], "one entry for the pinned role");
  const e = entries[0];
  assert.equal(e.role, "feature");
  assert.equal(e.sha, headSha(root));
  assert.equal(e.run, run, "the Run trailer's number is read back as the entry's run");
  assert.equal(e.summary, subject, "the stamp-stripped commit subject is the entry's summary");
  // The entry is anchored to the commit's committer date (second-granular), not the read time.
  const closeTo = 10 * 60 * 1000;
  assert.ok(Math.abs(now - closeTo - e.enqueuedAt) <= 2000, `enqueuedAt is the commit's age, got ${e.enqueuedAt}`);
});

test("readMergePins derives each pin's role from its ref name when no roleIds are named", async () => {
  const root = makeRepo();
  const now = Date.now();
  pinCommit(root, "clean", "b.txt", "split module", "tumwater(clean): split module", 5 * 60 * 1000, now);
  // An instance-id role is carried verbatim in the ref suffix and derived back as-is.
  pinCommit(root, "feature-2", "c.txt", "add a knob", "tumwater(feature-2): add a knob", 60 * 1000, now);

  const { entries, unreadable } = await readMergePins(root);
  assert.equal(unreadable, 0);
  assert.deepEqual(
    entries.map((e) => e.role).sort(),
    ["clean", "feature-2"],
    "every live pin under the merge prefix is listed, role derived from its ref suffix",
  );
  const feature2 = entries.find((e) => e.role === "feature-2");
  assert.ok(feature2, "the instance-id pin is listed");
  assert.equal(feature2.summary, "add a knob");
  // The doctor ages from the commit date; a fresh pin reads as just-arrived.
  assert.ok(Math.abs(now - 60 * 1000 - (feature2?.enqueuedAt ?? 0)) <= 2000);
});

test("a role whose ref is absent contributes nothing in a roleIds read", async () => {
  const root = makeRepo();
  // No ref is set for `organize`, so a roleIds read names no pins.
  const { entries, unreadable } = await readMergePins(root, ["organize"]);
  assert.equal(entries.length, 0);
  assert.equal(unreadable, 0);
});

test("a dangling pin — its ref names a commit the repo no longer holds — counts unreadable", async () => {
  const root = makeRepo();
  const now = Date.now();
  pinCommit(root, "clean", "a.txt", "real work", "tumwater(clean): real work", 60 * 1000, now);
  pinDangling(root, "feature");

  const anyRole = await readMergePins(root, ["clean", "feature"]);
  assert.equal(anyRole.unreadable, 1, "the dangling pin cannot build an entry and counts unreadable");
  assert.equal(anyRole.entries.length, 1, "the present pin still reads");
  assert.ok(anyRole.entries[0], "the present pin's entry");
  assert.equal(anyRole.entries[0].role, "clean");

  // The no-roles-named listing counts it the same way.
  const listed = await readMergePins(root);
  assert.equal(listed.unreadable, 1);
  assert.deepEqual(listed.entries.map((e) => e.role), ["clean"]);
});

test("readMergePins builds one entry per live pin, roleIds and listing agreeing", async () => {
  const root = makeRepo();
  const now = Date.now();
  const a = (file: string, role: string, subject: string): void =>
    pinCommit(root, role, file, subject, `tumwater(${role}): ${subject}`, 60 * 1000, now);
  a("a.txt", "improve", "tidy");
  a("b.txt", "organize", "move");

  const { entries, unreadable } = await readMergePins(root, ["improve", "organize"]);
  assert.equal(unreadable, 0);
  assert.deepEqual(entries.map((e) => e.role).sort(), ["improve", "organize"]);
  // Each role's commit is its own sha (distinct files/commits), so the two entries differ.
  assert.equal(entries.length, 2);
  assert.ok(entries[0] && entries[1], "both entries present");
  assert.notEqual(entries[0].sha, entries[1].sha, "two distinct commits in one repo have two shas");
});
