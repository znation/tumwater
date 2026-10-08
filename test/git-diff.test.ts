// --- changedFiles + unquotePorcelainPath: the refusal path's git helpers (loop.ts) ---
// A refusing run may leave files with special characters in their names; changedFiles must
// hand back decoded paths that loop.ts can classify (.md filter) and feed straight back to
// `git add`, so these tests round-trip through real `git status --porcelain` output.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { aheadOfMainDiff, aheadOfMainFiles, changedFiles, unquotePorcelainPath } from "../src/git/git-diff.js";
import { commitAll } from "../src/git/git.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { loggingGit, makeRepo, seedCommit, sh, tmpdir } from "./fixtures/repo-fixtures.js";

test("changedFiles is empty on a clean worktree", async () => {
  const repo = makeRepo();
  assert.deepEqual(await changedFiles(repo), []);
});

test("changedFiles lists modified, untracked, and deleted files by repo-relative path", async () => {
  const repo = makeRepo();
  seedCommit(repo, "gone.txt", "bye\n", "second");

  fs.rmSync(path.join(repo, "gone.txt")); // tracked, deleted
  fs.writeFileSync(path.join(repo, "seed.txt"), "edited\n"); // tracked, modified
  fs.mkdirSync(path.join(repo, "sub"));
  fs.writeFileSync(path.join(repo, "sub", "deep.md"), "nested\n"); // untracked, nested

  const files = await changedFiles(repo);
  // Porcelain v1 collapses an untracked directory into a single `?? sub/` entry — the
  // decoded form is still usable as-is by callers that feed paths back to git (`git add sub/`).
  assert.deepEqual(files.sort(), ["gone.txt", "seed.txt", "sub/"]);
});

test("changedFiles decodes C-quoted porcelain paths (quote, tab, newline, backslash, non-ASCII)", async () => {
  const repo = makeRepo();
  // Each name forces a different escape in git's C-quoting under core.quotePath.
  const names = [
    'qu"ote.md', // \"
    "tab\there.txt", // \t
    "new\nline.txt", // \n
    "back\\slash.txt", // \\\\
    "h\u00e9llo.md", // non-ASCII bytes → octal escapes
  ];
  for (const n of names) fs.writeFileSync(path.join(repo, n), "x\n");

  const files = await changedFiles(repo);
  assert.deepEqual(files.sort(), [...names].sort());
});

// Carriage return is a control character too: git C-quotes it as \r, and the decoded form
// must be the real on-disk path — changedFiles feeds it straight back to `git add` (the
// refusal path's commitPathsAndDiscardRest), so a misdecode stages nothing. The sibling
// escapes (\n, \t, \\, \", octal) are pinned by the test above; \r was not.
test("changedFiles decodes C-quoted carriage returns in filenames", async () => {
  const repo = makeRepo();
  const name = "car\rreturn.txt";
  fs.writeFileSync(path.join(repo, name), "x\n");

  const files = await changedFiles(repo);
  assert.deepEqual(files, [name]);
  // The decoded path is the real file on disk — not git's C-quoted form.
  assert.ok(fs.existsSync(path.join(repo, files[0] ?? "")));
});

// A staged rename is one `R  <from> -> <to>` line in plain porcelain, but changedFiles must
// report the path that exists on disk. Reading the whole field as one path returned the
// non-existent `old.md -> "h\303\251llo.md"`, which the refusal path's `.md` filter and
// `git add` could not use. The parse now reads git's -z format: destination first, origin in
// the following NUL-terminated record (which must be skipped, not read as a status line).
test("changedFiles reports a staged rename by its destination path, not the `from -> to` field", async () => {
  const repo = makeRepo();
  seedCommit(repo, "old.md", "note\n", "add note");
  sh(repo, "git", "mv", "old.md", "h\u00e9llo.md");

  const files = await changedFiles(repo);
  assert.deepEqual(files, ["h\u00e9llo.md"]);
  assert.ok(fs.existsSync(path.join(repo, files[0] ?? "")), "the reported path is on disk");
});

// Git's C-quoting has short escapes for four more control characters than \n/\t/\r — BEL
// (\a), backspace (\b), form feed (\f), and vertical tab (\v), all emitted by `git status
// --porcelain` for a filename containing the byte. They must decode to the control byte, not
// to the bare letter (the old default branch turned `\a` into "a", so the path no longer
// matched the file on disk).
test("changedFiles decodes C-quoted BEL/backspace/form-feed/vertical-tab filenames", async () => {
  const repo = makeRepo();
  const names = ["bell\x07here.md", "back\x08space.txt", "form\x0cfeed.txt", "vert\x0btab.txt"];
  for (const n of names) fs.writeFileSync(path.join(repo, n), "x\n");

  const files = await changedFiles(repo);
  assert.deepEqual(files.sort(), [...names].sort());
  for (const f of files) assert.ok(fs.existsSync(path.join(repo, f)), f);

  // The escape mapping itself, independent of git's output formatting.
  assert.equal(unquotePorcelainPath('"a\\ab"'), "a\x07b");
  assert.equal(unquotePorcelainPath('"a\\bb"'), "a\x08b");
  assert.equal(unquotePorcelainPath('"a\\fb"'), "a\x0cb");
  assert.equal(unquotePorcelainPath('"a\\vb"'), "a\x0bb");
});

// Defensive branches unquotePorcelainPath keeps for input git would never emit: a missing
// closing quote and unrecognized escapes must degrade to "keep as-is", not drop or mangle
// the entry — changedFiles/conflictedFiles feed whatever comes back straight back to git.
test("unquotePorcelainPath keeps malformed and unrecognized escapes as-is", () => {
  assert.equal(unquotePorcelainPath('"no closing quote'), '"no closing quote'); // end < 1
  assert.equal(unquotePorcelainPath('"a\\xb"'), "axb"); // \x: not an escape, kept literally
  assert.equal(unquotePorcelainPath('"a\\8b"'), "a8b"); // 8 is not an octal digit
  assert.equal(unquotePorcelainPath('"a\\1"'), "a1"); // truncated octal at the end: keep the digit
});

// --- aheadOfMainDiff: the review gate's diff feed, including its truncation path ---

/** A deterministic text blob of `lines` lines, each exactly 40 bytes (tag + index + padding). */
function blob(tag: string, lines: number): string {
  return (
    Array.from({ length: lines }, (_, i) => `${tag}-${i.toString().padStart(6, "0")}-` + "z".repeat(28)).join("\n") + "\n"
  );
}

test("aheadOfMainDiff returns the full diff when under the cap", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");
  fs.writeFileSync(path.join(wt, "small.txt"), blob("SML", 5));
  await commitAll(wt, "small change");

  // Default cap (200KB) is far above this diff: the output must be exactly what git prints.
  const out = await aheadOfMainDiff(wt, "main");
  assert.equal(out, sh(wt, "git", "diff", "main...HEAD"));
  assert.ok(!out.includes("[diff truncated:"), "no truncation note under the cap");
});

test("aheadOfMainDiff is empty when the branch has no commits ahead of main", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");
  assert.equal(await aheadOfMainDiff(wt, "main"), "");
});

test("aheadOfMainDiff over the cap keeps --stat plus the largest files within budget", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "improve", "main");
  // File names are chosen so alphabetical order (aaa < mmm < zzz) is the REVERSE of size
  // order: a regression that ranked by name instead of numstat size would include aaa.txt
  // and drop zzz.txt.
  fs.writeFileSync(path.join(wt, "zzz.txt"), blob("ZZZ", 500)); // ~20KB — largest
  fs.writeFileSync(path.join(wt, "mmm.txt"), blob("MMM", 200)); // ~8KB
  fs.writeFileSync(path.join(wt, "aaa.txt"), blob("AAA", 100)); // ~4KB — smallest
  await commitAll(wt, "big change");

  const cap = 31_000; // full diff is ~33KB: over the cap, but room for zzz + mmm only.
  const out = await aheadOfMainDiff(wt, "main", cap);

  assert.ok(out.startsWith("[diff truncated:"), `truncation note first:\n${out.slice(0, 200)}`);
  assert.match(out, /showing --stat plus the largest files/);
  // The --stat section names every changed file, even ones whose diff was cut.
  for (const f of ["zzz.txt", "mmm.txt", "aaa.txt"])
    assert.ok(out.includes(f), `--stat lists ${f}`);
  // The two largest files' full diffs are in, ranked by size: zzz before mmm...
  const zzz = out.indexOf("ZZZ-");
  const mmm = out.indexOf("MMM-");
  assert.ok(zzz >= 0, "largest file's diff included");
  assert.ok(mmm > zzz, `second-largest after the largest (zzz=${zzz}, mmm=${mmm})`);
  // ...and the budget stops before the smallest.
  assert.ok(!out.includes("AAA-"), "smallest file cut by the budget");
  assert.ok(out.length <= cap, `output stays within the cap (${out.length} <= ${cap})`);
});

test("aheadOfMainDiff handles binary files ('-' numstat) without crashing", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "big.txt"), blob("BIG", 100)); // ~4KB — largest text change
  fs.writeFileSync(path.join(wt, "small.txt"), blob("SML", 50)); // ~2KB
  // A binary file's numstat line is "-\t-\tpath": the parser must treat it as size 0 (ranked
  // last), not crash or poison the ranking of text files.
  fs.writeFileSync(path.join(wt, "blob.bin"), Buffer.from(Array.from({ length: 128 }, (_, i) => i)));
  await commitAll(wt, "mixed change");

  const cap = 5_500; // full diff is ~6.5KB: over the cap, room for big.txt only.
  const out = await aheadOfMainDiff(wt, "main", cap);

  assert.ok(out.startsWith("[diff truncated:"), `truncation note first:\n${out.slice(0, 200)}`);
  // The --stat section names the binary file and marks it as a binary change.
  assert.ok(out.includes("blob.bin"), "--stat lists blob.bin");
  assert.match(out, /Bin 0 ->/);
  // The largest text file's diff is still in — the '-' entry did not displace it...
  assert.ok(out.includes("BIG-"), "largest text file's diff included despite the binary entry");
  // ...and the budget stops before the smaller files (the size-0 binary ranks after them).
  assert.ok(!out.includes("SML-"), "budget stops before the smaller files");
  assert.ok(out.length <= cap);
});

test("aheadOfMainDiff over the cap spawns only two git calls, not one per file", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "perf", "main");
  // Several files so the old spawn-per-file behavior would have made many more than two
  // git invocations (full diff + numstat + stat + one per file until the budget ran out).
  for (const [name, lines] of [
    ["one.txt", 400],
    ["two.txt", 300],
    ["three.txt", 200],
  ] as const) fs.writeFileSync(path.join(wt, name), blob(name.toUpperCase().slice(0, 3), lines));
  await commitAll(wt, "several big files");

  const logFile = path.join(tmpdir(), "git-calls.log");
  const restore = loggingGit(logFile);
  try {
    // Cap far below the full diff so the truncation path runs.
    await aheadOfMainDiff(wt, "main", 10_000);
  } finally {
    restore();
  }
  const calls = fs.readFileSync(logFile, "utf8").trim().split("\n");
  // Exactly the full diff and its --stat — no numstat, no per-file re-diffs.
  assert.equal(calls.length, 2, `expected 2 git spawns, got ${calls.length}: ${calls.join(" | ")}`);
  assert.ok(calls.some((c) => c === "diff main...HEAD"), "full diff was fetched");
  assert.ok(calls.some((c) => c === "diff --stat main...HEAD"), "--stat was fetched");
});

// --- aheadOfMainFiles: the file list the review gate and merge path see ---

test("aheadOfMainFiles lists the files the branch's commits change", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "new.txt"), "added\n");
  fs.appendFileSync(path.join(wt, "seed.txt"), "more\n");
  await commitAll(wt, "branch change");
  assert.deepEqual((await aheadOfMainFiles(wt, "main")).sort(), ["new.txt", "seed.txt"]);
});

test("aheadOfMainFiles omits files only main gained after the branch forked (three-dot range)", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "improve", "main");
  // Main moves after the worktree's branch was cut (what a long tick spans).
  fs.writeFileSync(path.join(repo, "main-only.txt"), "on main\n");
  await commitAll(repo, "main moves on");
  fs.writeFileSync(path.join(wt, "branch-only.txt"), "on branch\n");
  await commitAll(wt, "branch change");
  assert.deepEqual(await aheadOfMainFiles(wt, "main"), ["branch-only.txt"]);
});
