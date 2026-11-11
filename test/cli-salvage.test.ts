import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { salvageDir, salvagePendingDir } from "../src/paths.js";
import { makeRepo, sh, teamWorkspace, headSha, tmpdir } from "./fixtures/repo-fixtures.js";
import { teamWorkspaceMessage } from "../src/gates/readiness-gates.js";
import { cli } from "./helpers/cli-harness.js";

// The `salvage` command: the read-only view of the workspace patches kept under
// `.tumwater/salvage/`, via the CLI the way the cli-quarantine tests `quarantine` — a temp
// repo, child-process runs, output assertions.

const OLDER_TEXT = "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n";
const NEWER_TEXT = "newer patch body\n";

/** Seed a repo's salvage dir with an older (3h ago) and a newer (under a minute ago) direct
 * patch, plus a `pending/<role>/x.patch` and a `notes.txt` that must both stay out of the
 * list. Returns the salvage file paths so a test can assert bytes before and after. */
function seedSalvage(repo: string): { older: string; newer: string } {
  fs.mkdirSync(salvageDir(repo), { recursive: true });
  fs.mkdirSync(salvagePendingDir(repo, "feature"), { recursive: true });
  fs.writeFileSync(path.join(salvagePendingDir(repo, "feature"), "x.patch"), "pending work");
  fs.writeFileSync(path.join(salvageDir(repo), "notes.txt"), "not a patch");
  const now = Date.now();
  const older = path.join(salvageDir(repo), "a.patch");
  const newer = path.join(salvageDir(repo), "b.patch");
  fs.writeFileSync(older, OLDER_TEXT);
  fs.writeFileSync(newer, NEWER_TEXT);
  fs.utimesSync(older, new Date(now - 3 * 3600_000), new Date(now - 3 * 3600_000));
  fs.utimesSync(newer, new Date(now - 30_000), new Date(now - 30_000));
  return { older, newer };
}

function bytesOf(...files: string[]): number[] {
  return files.map((f) => fs.statSync(f).size);
}

test("salvage lists the kept patches oldest first with age and size, skipping pending and non-patch files", async () => {
  const repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  const before = bytesOf(older, newer);
  const r = await cli(repo, "salvage");
  assert.equal(r.code, 0);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "salvaged workspace patches: 2");
  assert.equal(lines[1], "1. a.patch — saved 3h ago, 38 B");
  assert.equal(lines[2], "2. b.patch — saved 0m ago, 17 B");
  assert.deepEqual(bytesOf(older, newer), before, "the list never writes a patch");
});

test("salvage prints the empty line and exits 0 with no salvage dir, creating nothing", async () => {
  const repo = makeRepo();
  const r = await cli(repo, "salvage");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "no salvaged workspace patches are kept for you");
  assert.equal(fs.existsSync(salvageDir(repo)), false, "no salvage dir is created");
  assert.equal(fs.existsSync(path.join(repo, ".tumwater")), false, "no .tumwater is created");
});

test("salvage --json serves the positioned patches oldest first", async () => {
  const repo = makeRepo();
  seedSalvage(repo);
  const r = await cli(repo, "salvage", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { patches: { position: number; file: string; savedAt: number; bytes: number }[] };
  assert.equal(payload.patches.length, 2);
  const [first, second] = payload.patches;
  assert.equal(first!.position, 1);
  assert.equal(first!.file, "a.patch");
  assert.equal(first!.bytes, 38);
  assert.ok(typeof first!.savedAt === "number");
  assert.equal(second!.position, 2);
  assert.equal(second!.file, "b.patch");
  assert.equal(second!.bytes, 17);
  assert.ok(second!.savedAt > first!.savedAt);
});

test("salvage --json with no patches prints an empty array and creates nothing", async () => {
  const repo = makeRepo();
  const r = await cli(repo, "salvage", "--json");
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { patches: [] });
  assert.equal(fs.existsSync(salvageDir(repo)), false);
});

test("salvage --show <n> prints the Nth patch in full", async () => {
  const repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  const before = bytesOf(older, newer);
  const r = await cli(repo, "salvage", "--show", "2");
  assert.equal(r.code, 0);
  // b.patch holds "newer patch body", not a diff git can parse, so no stat line is printed;
  // the output is exactly the header, the saved line and the patch text verbatim.
  assert.equal(r.stdout, "salvaged workspace patch 2: b.patch\nsaved 0m ago, 17 B\nnewer patch body\n\n");
  assert.deepEqual(bytesOf(older, newer), before, "--show never writes a patch");
});

// a.patch is OLDER_TEXT, a valid single-file diff (f: one line swapped), so `git apply
// --stat` sums to ` f |    2 +-` and ` 1 file changed, 1 insertion(+), 1 deletion(-)` —
// worked from the seeded patch's one changed file and one swapped line, not copied from output.
test("salvage --show <n> prints the patch's git diffstat under its saved line", async () => {
  const repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  const before = bytesOf(older, newer);
  const r = await cli(repo, "salvage", "--show", "1");
  assert.equal(r.code, 0);
  assert.equal(
    r.stdout,
    "salvaged workspace patch 1: a.patch\nsaved 3h ago, 38 B\n"
      + " f |    2 +-\n"
      + " 1 file changed, 1 insertion(+), 1 deletion(-)\n"
      + OLDER_TEXT + "\n",
  );
  assert.deepEqual(bytesOf(older, newer), before, "--show never writes a patch");
});

test("salvage --show <n> --json prints the entry object with the exact patch text and no stat for a non-diff patch", async () => {
  const repo = makeRepo();
  seedSalvage(repo);
  const r = await cli(repo, "salvage", "--show", "2", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { position: number; file: string; savedAt: number; bytes: number; stat: string | null; patch: string };
  assert.equal(payload.position, 2);
  assert.equal(payload.file, "b.patch");
  assert.equal(payload.bytes, 17);
  assert.ok(typeof payload.savedAt === "number");
  assert.equal(payload.stat, null, "a non-diff patch carries no stat");
  assert.equal(payload.patch, NEWER_TEXT);
});

test("salvage --show <n> --json carries the patch's diffstat as stat", async () => {
  const repo = makeRepo();
  seedSalvage(repo);
  const r = await cli(repo, "salvage", "--show", "1", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { position: number; file: string; savedAt: number; bytes: number; stat: string | null; patch: string };
  assert.equal(payload.position, 1);
  assert.equal(payload.file, "a.patch");
  assert.equal(payload.bytes, 38);
  assert.ok(typeof payload.savedAt === "number");
  assert.equal(payload.stat, " f |    2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)");
  assert.equal(payload.patch, OLDER_TEXT);
});

test("salvage --show past the list fails naming the position and the depth", async () => {
  const repo = makeRepo();
  seedSalvage(repo);
  const r = await cli(repo, "salvage", "--show", "3");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("no salvaged workspace patch at position 3 (salvage holds 2 patches)"));
});

test("salvage --show with a missing, zero or non-integer position fails with the --show 2 usage", async () => {
  const repo = makeRepo();
  seedSalvage(repo);
  let r = await cli(repo, "salvage", "--show");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("--show needs a position"), "missing position fails with the --show 2 usage wording");
  r = await cli(repo, "salvage", "--show", "0");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("positive integer"));
  r = await cli(repo, "salvage", "--show", "abc");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("positive integer"));
});

test("salvage refuses an unknown flag, naming it", async () => {
  const repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  const before = bytesOf(older, newer);
  const r = await cli(repo, "salvage", "--bogus");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("--bogus"));
  assert.deepEqual(bytesOf(older, newer), before, "a refused flag never writes a patch");
});

test("salvage inside a team workspace fails naming the owning team root", async () => {
  const { root, slot } = teamWorkspace();
  const r = await cli(slot, "salvage");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes(teamWorkspaceMessage(root)));
});

test("salvage --grep keeps each matching patch under its whole-list number", async () => {
  const repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  const before = bytesOf(older, newer);
  // A phrase present in only the older patch's text keeps that patch under position 1.
  let r = await cli(repo, "salvage", "--grep", "+new");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trimEnd(), "salvaged workspace patches: 1\n1. a.patch — saved 3h ago, 38 B");
  // A pattern matching only the other patch's file name keeps it under position 2.
  r = await cli(repo, "salvage", "--grep", "b.patch");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trimEnd(), "salvaged workspace patches: 1\n2. b.patch — saved 0m ago, 17 B");
  assert.deepEqual(bytesOf(older, newer), before, "the filtered list never writes a patch");
});

test("salvage --grep with no match or an empty dir keeps the no-match and empty lines and writes nothing", async () => {
  let repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  const before = bytesOf(older, newer);
  let r = await cli(repo, "salvage", "--grep", "nowhere-in-the-patches");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), `no salvaged workspace patches match "nowhere-in-the-patches"`);
  assert.deepEqual(bytesOf(older, newer), before, "a no-match filter never writes a patch");
  repo = makeRepo();
  r = await cli(repo, "salvage", "--grep", "zzz");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "no salvaged workspace patches are kept for you");
  assert.equal(fs.existsSync(salvageDir(repo)), false, "no salvage dir is created");
  assert.equal(fs.existsSync(path.join(repo, ".tumwater")), false, "no .tumwater is created");
});

test("salvage --grep <text> --json serves only the kept rows with whole-list positions", async () => {
  const repo = makeRepo();
  seedSalvage(repo);
  const r = await cli(repo, "salvage", "--grep", "+new", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { patches: { position: number; file: string; savedAt: number; bytes: number }[] };
  assert.equal(payload.patches.length, 1);
  assert.equal(payload.patches[0]!.position, 1);
  assert.equal(payload.patches[0]!.file, "a.patch");
  assert.equal(payload.patches[0]!.bytes, 38);
  const noMatch = await cli(repo, "salvage", "--grep", "zzz", "--json");
  assert.equal(noMatch.code, 0);
  assert.deepEqual(JSON.parse(noMatch.stdout), { patches: [] });
});

test("salvage --show 2 --grep x is refused naming --grep", async () => {
  const repo = makeRepo();
  seedSalvage(repo);
  const r = await cli(repo, "salvage", "--show", "2", "--grep", "x");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("--grep"), "the refusal names the flag the detail view rejects");
});

test("salvage --grep with no value fails with the shared missing-value wording", async () => {
  const repo = makeRepo();
  seedSalvage(repo);
  const r = await cli(repo, "salvage", "--grep");
  assert.equal(r.code, 1);
  assert.ok(
    r.stderr.includes("salvage --grep needs text (usage: tumwater salvage --grep <text>)"),
    "a valueless --grep fails with the shared missing-value wording",
  );
});

test("salvage --drop <n> deletes the Nth patch and leaves the rest and pending alone", async () => {
  const repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  const before = bytesOf(older);
  const r = await cli(repo, "salvage", "--drop", "2");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trimEnd(), "dropped salvaged workspace patch 2: b.patch");
  assert.equal(fs.existsSync(newer), false, "b.patch is deleted");
  assert.deepEqual(bytesOf(older), before, "a.patch is untouched");
  assert.equal(fs.existsSync(salvagePendingDir(repo, "feature")), true, "pending/<role>/ survives");
  assert.equal(fs.existsSync(path.join(salvageDir(repo), "notes.txt")), true, "a non-patch file survives");
  const list = await cli(repo, "salvage");
  assert.equal(list.code, 0);
  assert.equal(list.stdout.trimEnd(), "salvaged workspace patches: 1\n1. a.patch — saved 3h ago, 38 B");
});

test("salvage --drop <n> --json deletes the same patch and prints one object", async () => {
  const repo = makeRepo();
  const { newer } = seedSalvage(repo);
  const r = await cli(repo, "salvage", "--drop", "2", "--json");
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { dropped: { position: 2, file: "b.patch" } });
  assert.equal(fs.existsSync(newer), false, "b.patch is deleted");
  assert.equal(fs.existsSync(path.join(salvageDir(repo), "a.patch")), true, "a.patch survives");
});

test("salvage --drop past the list fails naming the position and depth and deletes nothing", async () => {
  const repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  const before = bytesOf(older, newer);
  const r = await cli(repo, "salvage", "--drop", "3");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("no salvaged workspace patch at position 3 (salvage holds 2 patches)"));
  assert.deepEqual(bytesOf(older, newer), before, "an out-of-range drop deletes nothing");
});

test("salvage --drop with a missing, zero or non-integer position fails and deletes nothing", async () => {
  const repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  const before = bytesOf(older, newer);
  let r = await cli(repo, "salvage", "--drop");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("--drop needs a position"), "a missing position fails with the --drop 2 usage wording");
  r = await cli(repo, "salvage", "--drop", "0");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("positive integer"));
  r = await cli(repo, "salvage", "--drop", "abc");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("positive integer"));
  assert.deepEqual(bytesOf(older, newer), before, "a refused drop deletes nothing");
});

test("salvage --drop with no salvage dir fails with 0 patches and creates nothing", async () => {
  const repo = makeRepo();
  const r = await cli(repo, "salvage", "--drop", "1");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("salvage holds 0 patches"));
  assert.equal(fs.existsSync(salvageDir(repo)), false, "no salvage dir is created");
  assert.equal(fs.existsSync(path.join(repo, ".tumwater")), false, "no .tumwater is created");
});

test("salvage --drop refuses --grep, --show, -f and an unknown flag, leaving the patches", async () => {
  const repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  const before = bytesOf(older, newer);
  const cases: { args: string[]; named: string }[] = [
    { args: ["--drop", "1", "--grep", "x"], named: "--grep" },
    // `--show`'s guard runs first, so a command carrying both routes to `--show` and
    // refuses `--drop` through its rejectUnknownArgs.
    { args: ["--drop", "1", "--show", "2"], named: "--drop" },
    { args: ["--drop", "1", "-f"], named: "-f" },
    { args: ["--drop", "1", "--bogus"], named: "--bogus" },
  ];
  for (const { args, named } of cases) {
    const r = await cli(repo, "salvage", ...args);
    assert.equal(r.code, 1, named);
    assert.ok(r.stderr.includes(named), `the refusal names ${named}`);
  }
  assert.deepEqual(bytesOf(older, newer), before, "a refused drop leaves both patches");
});

test("salvage --grep --drop treats --drop as the pattern text, not the drop mode", async () => {
  const repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  const before = bytesOf(older, newer);
  const r = await cli(repo, "salvage", "--grep", "--drop");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), `no salvaged workspace patches match "--drop"`);
  assert.deepEqual(bytesOf(older, newer), before, "the filter mode deletes nothing");
});

// --apply: the apply twin of --show/--drop, driving the CLI as a child process against a real
// git checkout. OLDER_TEXT is a valid unified diff against a committed file, so a patch holding
// it applies exactly to the tree the repo template left — content, unstaged status, head and
// patch bytes are all worked from the patch the test writes, not from a run's output.

/** A one-commit repo whose file `f` holds the content OLDER_TEXT expects ("old"), the patch
 * seeded into its salvage dir, and the patch's bytes. The patch's `--- a/f`/`+++ b/f` header
 * names `f`, so the committed file is `f`, not the repo's seed.txt. */
function applyFixture(): { repo: string; patch: string; patchBytes: string } {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "f"), "old\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "old");
  const patch = path.join(salvageDir(repo), "a.patch");
  fs.mkdirSync(salvageDir(repo), { recursive: true });
  fs.writeFileSync(patch, OLDER_TEXT);
  return { repo, patch, patchBytes: OLDER_TEXT };
}

test("salvage --apply <n> applies the patch as unstaged edits, committing nothing and keeping it", async () => {
  const { repo, patch, patchBytes } = applyFixture();
  const headBefore = headSha(repo);
  const r = await cli(repo, "salvage", "--apply", "1");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "applied salvaged workspace patch 1: a.patch");
  assert.equal(fs.readFileSync(path.join(repo, "f"), "utf8"), "new\n", "the patch's content is in the tree");
  const status = sh(repo, "git", "status", "--porcelain").split("\n");
  assert.ok(status.includes(" M f"), "the edit is modified and unstaged");
  assert.equal(sh(repo, "git", "diff", "--cached"), "", "the index is untouched");
  assert.equal(headSha(repo), headBefore, "no commit was made");
  assert.equal(fs.readFileSync(patch, "utf8"), patchBytes, "the patch file is kept");
});

test("salvage --apply <n> --json prints only the applied object", async () => {
  const { repo } = applyFixture();
  const r = await cli(repo, "salvage", "--apply", "1", "--json");
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { applied: { position: 1, file: "a.patch" } });
  assert.equal(fs.readFileSync(path.join(repo, "f"), "utf8"), "new\n");
});

test("salvage --apply of a patch whose context no longer fits changes nothing and keeps the patch", async () => {
  const { repo, patch, patchBytes } = applyFixture();
  // The branch moved under the patch: f now holds text the patch's context does not,
  // so `git apply --check` refuses it.
  fs.writeFileSync(path.join(repo, "f"), "moved\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "move");
  const r = await cli(repo, "salvage", "--apply", "1");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("a.patch does not apply cleanly"), "the refusal names the patch file");
  assert.ok(r.stderr.includes("no files were changed"), "the refusal says the tree is untouched");
  assert.ok(r.stderr.includes("tumwater salvage --show 1"), "the refusal points at --show for a manual apply");
  assert.equal(fs.readFileSync(path.join(repo, "f"), "utf8"), "moved\n", "the working tree is byte-identical");
  assert.equal(sh(repo, "git", "status", "--porcelain"), "", "nothing was staged or modified");
  assert.equal(fs.readFileSync(patch, "utf8"), patchBytes, "the patch is still kept");
});

test("salvage --apply with a missing position fails with the --apply 2 usage", async () => {
  const { repo, patch, patchBytes } = applyFixture();
  const r = await cli(repo, "salvage", "--apply");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("--apply needs a position"));
  assert.equal(fs.readFileSync(path.join(repo, "f"), "utf8"), "old\n", "a refused apply writes nothing");
  assert.equal(fs.readFileSync(patch, "utf8"), patchBytes);
});

test("salvage --apply past the list fails with the shared out-of-range wording", async () => {
  const { repo, patch, patchBytes } = applyFixture();
  const r = await cli(repo, "salvage", "--apply", "9");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("no salvaged workspace patch at position 9 (salvage holds 1 patches)"));
  assert.equal(fs.readFileSync(path.join(repo, "f"), "utf8"), "old\n", "an out-of-range apply writes nothing");
  assert.equal(fs.readFileSync(patch, "utf8"), patchBytes);
});

test("salvage --apply outside a git checkout fails with the git-checkout refusal and writes nothing", async () => {
  const plain = tmpdir("tumwater-salvage-plain-");
  try {
    const r = await cli(plain, "salvage", "--apply", "1");
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("salvage --apply needs a git checkout"));
    assert.equal(fs.existsSync(path.join(plain, ".tumwater")), false, "the refusal creates nothing");
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test("salvage --apply in a team workspace is refused like the list and --show", async () => {
  const { root, slot } = teamWorkspace();
  const r = await cli(slot, "salvage", "--apply", "1");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes(teamWorkspaceMessage(root)), "the refusal names the owning team root");
});

test("salvage --apply refuses --show, --drop, -f and an unknown flag, leaving the tree and the patch", async () => {
  const { repo, patch, patchBytes } = applyFixture();
  const cases: { args: string[]; named: string }[] = [
    // `--show`'s guard runs before `--apply`'s, so a command carrying both routes to `--show`
    // and refuses `--apply` through its own rejectUnknownArgs (the same quirk the `--drop`
    // test documents): the message names `--apply`.
    { args: ["--apply", "1", "--show", "2"], named: "--apply" },
    // `--drop`'s guard runs before `--apply`'s, so this routes to `--drop` and refuses `--apply`.
    { args: ["--apply", "1", "--drop", "2"], named: "--apply" },
    { args: ["--apply", "1", "-f"], named: "-f" },
    { args: ["--apply", "1", "--bogus"], named: "--bogus" },
  ];
  for (const { args, named } of cases) {
    const r = await cli(repo, "salvage", ...args);
    assert.equal(r.code, 1, named);
    assert.ok(r.stderr.includes(named), `the refusal names ${named}`);
  }
  assert.equal(fs.readFileSync(path.join(repo, "f"), "utf8"), "old\n", "a refused apply leaves the tree untouched");
  assert.equal(fs.readFileSync(patch, "utf8"), patchBytes, "a refused apply keeps the patch");
});

test("salvage --grep --apply treats --apply as the pattern text, not the apply mode", async () => {
  const { repo, patch, patchBytes } = applyFixture();
  const r = await cli(repo, "salvage", "--grep", "--apply");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), `no salvaged workspace patches match "--apply"`);
  assert.equal(fs.readFileSync(path.join(repo, "f"), "utf8"), "old\n", "the filter mode applies nothing");
  assert.equal(fs.readFileSync(patch, "utf8"), patchBytes);
});

// --apply --dry-run: the read-only preview of the apply — the same `git apply --check` read
// the real apply runs first, with nothing written. The fixture leaves a clean tree whose f
// holds the content the patch expects, so a plain preview fits; moving the branch under the
// patch makes the same preview refuse.

test("salvage --apply 1 --dry-run on a fitting patch prints the would-apply line, writing nothing", async () => {
  const { repo, patch, patchBytes } = applyFixture();
  const headBefore = headSha(repo);
  const treeBefore = sh(repo, "git", "status", "--porcelain");
  const indexBefore = sh(repo, "git", "diff", "--cached");
  const fBefore = fs.readFileSync(path.join(repo, "f"), "utf8");
  const r = await cli(repo, "salvage", "--apply", "1", "--dry-run");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "would apply salvaged workspace patch 1: a.patch — applies cleanly to this checkout; nothing was written");
  assert.equal(fs.readFileSync(path.join(repo, "f"), "utf8"), fBefore, "the preview leaves the tracked file byte-identical");
  assert.equal(sh(repo, "git", "status", "--porcelain"), treeBefore, "the preview leaves the working tree untouched");
  assert.equal(sh(repo, "git", "diff", "--cached"), indexBefore, "the index is untouched");
  assert.equal(headSha(repo), headBefore, "no commit was made");
  assert.equal(fs.readFileSync(patch, "utf8"), patchBytes, "the patch is kept");
});

test("salvage --apply 1 --dry-run on a patch whose context no longer fits fails, naming the patch, and writes nothing", async () => {
  const { repo, patch, patchBytes } = applyFixture();
  // Move the branch under the patch so its context no longer fits.
  fs.writeFileSync(path.join(repo, "f"), "moved\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "move");
  const headBefore = headSha(repo);
  const treeBefore = sh(repo, "git", "status", "--porcelain");
  const indexBefore = sh(repo, "git", "diff", "--cached");
  const r = await cli(repo, "salvage", "--apply", "1", "--dry-run");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("a.patch does not apply cleanly"), "the refusal names the patch file");
  assert.ok(r.stderr.includes("no files were changed"), "the refusal says the tree is untouched");
  assert.ok(r.stderr.includes("tumwater salvage --show 1"), "the refusal points at --show");
  assert.equal(fs.readFileSync(path.join(repo, "f"), "utf8"), "moved\n", "the preview leaves the tracked file byte-identical");
  assert.equal(sh(repo, "git", "status", "--porcelain"), treeBefore, "the preview leaves the working tree untouched");
  assert.equal(sh(repo, "git", "diff", "--cached"), indexBefore, "the index is untouched");
  assert.equal(headSha(repo), headBefore, "no commit was made");
  assert.equal(fs.readFileSync(patch, "utf8"), patchBytes, "the patch is kept");
});

test("salvage --apply 1 --dry-run --json prints the preview object on either outcome", async () => {
  let { repo, patch } = applyFixture();
  let r = await cli(repo, "salvage", "--apply", "1", "--dry-run", "--json");
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { dryRun: true, position: 1, file: "a.patch", applies: true });
  assert.equal(fs.readFileSync(path.join(repo, "f"), "utf8"), "old\n", "the clean preview writes nothing");
  assert.equal(fs.readFileSync(patch, "utf8"), OLDER_TEXT, "the patch is kept");

  // The same command on a moved tree reports applies: false and exits 1.
  fs.writeFileSync(path.join(repo, "f"), "moved\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "move");
  r = await cli(repo, "salvage", "--apply", "1", "--dry-run", "--json");
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.stdout), { dryRun: true, position: 1, file: "a.patch", applies: false });
  assert.equal(fs.readFileSync(path.join(repo, "f"), "utf8"), "moved\n", "the unclean preview writes nothing");
  assert.equal(fs.readFileSync(patch, "utf8"), OLDER_TEXT, "the patch is kept");
});

test("a real apply after a dry-run preview still applies, so the preview is a safe dry preview", async () => {
  const { repo, patch, patchBytes } = applyFixture();
  const headBefore = headSha(repo);
  // The preview changes nothing, so the real apply that follows fits and lands.
  const preview = await cli(repo, "salvage", "--apply", "1", "--dry-run");
  assert.equal(preview.code, 0);
  const r = await cli(repo, "salvage", "--apply", "1");
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(path.join(repo, "f"), "utf8"), "new\n", "the real apply wrote the patch");
  assert.ok(sh(repo, "git", "status", "--porcelain").includes(" M f"), "the edit is unstaged");
  assert.equal(headSha(repo), headBefore, "no commit was made");
  assert.equal(fs.readFileSync(patch, "utf8"), patchBytes, "the patch is kept");
});

test("salvage --dry-run, --show 1 --dry-run and --drop 1 --dry-run are refused, changing nothing", async () => {
  const repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  const before = bytesOf(older, newer);
  const cases = [
    { args: ["--dry-run"], named: "--dry-run" },
    { args: ["--show", "1", "--dry-run"], named: "--dry-run" },
    { args: ["--drop", "1", "--dry-run"], named: "--dry-run" },
  ];
  for (const { args, named } of cases) {
    const r = await cli(repo, "salvage", ...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.ok(r.stderr.includes(named), `the refusal names ${named}`);
  }
  assert.deepEqual(bytesOf(older, newer), before, "a refused preview deletes and writes no patch");
});

