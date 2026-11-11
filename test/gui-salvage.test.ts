import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  handleSalvageList,
  handleSalvageApply,
  handleSalvageDrop,
} from "../src/gui/gui-endpoint-commands.js";
import { salvageDir, salvagePendingDir } from "../src/paths.js";
import { makeRepo, sh, headSha, tmpdir } from "./fixtures/repo-fixtures.js";
import { captureJson, fakeReq } from "./fakes/fake-res.js";

// The dashboard's salvaged workspace patch endpoints (src/gui/gui-salvage-commands.ts): the
// browser twins of `tumwater salvage`'s list, `--apply <n>` and `--drop <n>`, driven the way
// test/gui-retire.test.ts drives the retire handlers — the real domain functions against a
// temp repo, captured through the shared fake request/response, no socket.
//
// The expected positions are derived from the write order (an older patch, then a newer one),
// not read back from the handler's output: the test asserts the handler sorts by savedAt and
// numbers oldest-first.

const OLDER_TEXT = "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n";

// Seed a repo's salvage dir with one older (3h ago) and one newer (under a minute ago)
// direct patch plus one pending patch and one non-patch file; both of the latter stay out of
// the list. Returns the kept patch paths.
function seedSalvage(repo: string): { older: string; newer: string } {
  fs.mkdirSync(salvageDir(repo), { recursive: true });
  fs.mkdirSync(salvagePendingDir(repo, "feature"), { recursive: true });
  fs.writeFileSync(path.join(salvagePendingDir(repo, "feature"), "x.patch"), "pending work");
  fs.writeFileSync(path.join(salvageDir(repo), "notes.txt"), "not a patch");
  const now = Date.now();
  const older = path.join(salvageDir(repo), "a.patch");
  const newer = path.join(salvageDir(repo), "b.patch");
  fs.writeFileSync(older, OLDER_TEXT);
  fs.writeFileSync(newer, "newer patch body\n");
  fs.utimesSync(older, new Date(now - 3 * 3600_000), new Date(now - 3 * 3600_000));
  fs.utimesSync(newer, new Date(now - 30_000), new Date(now - 30_000));
  return { older, newer };
}

test("GET /api/salvage lists the kept patches oldest first with size, skipping pending and non-patch files", async () => {
  const repo = makeRepo();
  seedSalvage(repo);
  const { captured, data } = await captureJson((res) => handleSalvageList(res, repo));
  assert.equal(captured.status, 200);
  const patches = (data as { patches: Array<{ position: number; file: string; savedAt: number; bytes: number; size: string }> }).patches;
  // Exactly the two direct patches, oldest first, with the CLI's size text — the pending
  // patch and notes.txt are not listed.
  assert.equal(patches.length, 2);
  assert.equal(patches[0]!.position, 1);
  assert.equal(patches[0]!.file, "a.patch");
  assert.equal(patches[0]!.size, "38 B");
  assert.ok(typeof patches[0]!.savedAt === "number");
  assert.equal(patches[1]!.position, 2);
  assert.equal(patches[1]!.file, "b.patch");
  assert.ok(patches[1]!.savedAt > patches[0]!.savedAt);
});

test("GET /api/salvage with no salvage dir answers the empty list, creating nothing", async () => {
  const repo = makeRepo();
  const { captured, data } = await captureJson((res) => handleSalvageList(res, repo));
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { patches: [] });
  assert.equal(fs.existsSync(salvageDir(repo)), false, "the list never creates the salvage dir");
});

test("POST /api/salvage-apply applies the Nth patch as unstaged edits, committing nothing and keeping it", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "f"), "old\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "old");
  const headBefore = headSha(repo);
  const { older, newer } = seedSalvage(repo);
  const { captured, data } = await captureJson((res) => handleSalvageApply(fakeReq(JSON.stringify({ position: 1 })), res, repo));
  assert.equal(captured.status, 200);
  const d = data as { ok: boolean; applied?: { position: number; file: string }; message: string };
  assert.equal(d.ok, true);
  assert.deepEqual(d.applied, { position: 1, file: "a.patch" });
  assert.equal(d.message, "applied salvaged workspace patch 1: a.patch");
  assert.equal(fs.readFileSync(path.join(repo, "f"), "utf8"), "new\n", "the patch's content is in the tree");
  assert.ok(sh(repo, "git", "status", "--porcelain").split("\n").includes(" M f"), "the edit is modified and unstaged");
  assert.equal(sh(repo, "git", "diff", "--cached"), "", "the index is untouched");
  assert.equal(headSha(repo), headBefore, "no commit was made");
  assert.equal(fs.existsSync(older), true, "the applied patch is kept");
  assert.equal(fs.existsSync(newer), true);
});

test("POST /api/salvage-apply of a patch whose context no longer fits refuses, changing nothing and keeping it", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "f"), "old\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "old");
  fs.mkdirSync(salvageDir(repo), { recursive: true });
  const patch = path.join(salvageDir(repo), "a.patch");
  fs.writeFileSync(patch, OLDER_TEXT);
  // Move the tree under the patch so its context no longer fits.
  fs.writeFileSync(path.join(repo, "f"), "moved\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "move");
  const { captured, data } = await captureJson((res) => handleSalvageApply(fakeReq(JSON.stringify({ position: 1 })), res, repo));
  assert.equal(captured.status, 200);
  const d = data as { ok: boolean; message: string };
  assert.equal(d.ok, false);
  assert.ok(d.message.includes("a.patch does not apply cleanly"), "the refusal names the patch file");
  assert.ok(d.message.includes("no files were changed"));
  assert.ok(d.message.includes("tumwater salvage --show 1"));
  assert.equal(fs.readFileSync(path.join(repo, "f"), "utf8"), "moved\n", "the working tree is byte-identical");
  assert.equal(fs.readFileSync(patch, "utf8"), OLDER_TEXT, "the refused patch is still kept");
});

test("POST /api/salvage-apply with an out-of-range position answers ok:false and changes nothing", async () => {
  const repo = makeRepo();
  fs.mkdirSync(salvageDir(repo), { recursive: true });
  fs.writeFileSync(path.join(salvageDir(repo), "a.patch"), OLDER_TEXT);
  const { captured, data } = await captureJson((res) => handleSalvageApply(fakeReq(JSON.stringify({ position: 9 })), res, repo));
  assert.equal(captured.status, 200);
  const d = data as { ok: boolean; message: string };
  assert.equal(d.ok, false);
  assert.equal(d.message, "no salvaged workspace patch at position 9 (salvage holds 1 patches)");
  assert.equal(fs.readFileSync(path.join(salvageDir(repo), "a.patch"), "utf8"), OLDER_TEXT, "an out-of-range apply writes nothing");
});

test("POST /api/salvage-apply with a missing, zero or non-integer position is a 400", async () => {
  const repo = makeRepo();
  fs.mkdirSync(salvageDir(repo), { recursive: true });
  fs.writeFileSync(path.join(salvageDir(repo), "a.patch"), OLDER_TEXT);
  for (const body of [{}, { position: 0 }, { position: 1.5 }]) {
    const { captured, data } = await captureJson((res) =>
      handleSalvageApply(fakeReq(JSON.stringify(body)), res, repo),
    );
    assert.equal(captured.status, 400);
    assert.match((data as { error: string }).error, /whole-number patch position/);
  }
});

test("POST /api/salvage-apply on a non-git root answers 409 with the git-checkout sentence", async () => {
  const plain = tmpdir("tumwater-gui-salvage-plain-");
  try {
    fs.mkdirSync(salvageDir(plain), { recursive: true });
    fs.writeFileSync(path.join(salvageDir(plain), "a.patch"), OLDER_TEXT);
    const { captured, data } = await captureJson((res) =>
      handleSalvageApply(fakeReq(JSON.stringify({ position: 1 })), res, plain),
    );
    assert.equal(captured.status, 409);
    assert.equal((data as { message: string }).message, "salvage --apply needs a git checkout (run it from the checkout the patch should apply to)");
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test("POST /api/salvage-drop deletes only its patch, leaving the other and pending untouched", async () => {
  const repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  const pending = path.join(salvagePendingDir(repo, "feature"), "x.patch");
  const { captured, data } = await captureJson((res) => handleSalvageDrop(fakeReq(JSON.stringify({ position: 1 })), res, repo));
  assert.equal(captured.status, 200);
  const d = data as { ok: boolean; dropped?: { position: number; file: string }; message: string };
  assert.equal(d.ok, true);
  assert.deepEqual(d.dropped, { position: 1, file: "a.patch" });
  assert.equal(d.message, "dropped salvaged workspace patch 1: a.patch");
  assert.equal(fs.existsSync(older), false, "the dropped patch is gone");
  assert.equal(fs.existsSync(newer), true, "the other kept patch remains");
  assert.equal(fs.existsSync(pending), true, "the pending patch is untouched");
});

test("POST /api/salvage-drop with an out-of-range position answers ok:false and deletes nothing", async () => {
  const repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  const { captured, data } = await captureJson((res) => handleSalvageDrop(fakeReq(JSON.stringify({ position: 9 })), res, repo));
  assert.equal(captured.status, 200);
  const d = data as { ok: boolean; message: string };
  assert.equal(d.ok, false);
  assert.equal(d.message, "no salvaged workspace patch at position 9 (salvage holds 2 patches)");
  assert.equal(fs.existsSync(older), true, "an out-of-range drop deletes nothing");
  assert.equal(fs.existsSync(newer), true);
});

test("POST /api/salvage-drop with a missing, zero or non-integer position is a 400", async () => {
  const repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  for (const body of [{}, { position: 0 }, { position: 1.5 }]) {
    const { captured, data } = await captureJson((res) =>
      handleSalvageDrop(fakeReq(JSON.stringify(body)), res, repo),
    );
    assert.equal(captured.status, 400);
    assert.match((data as { error: string }).error, /whole-number patch position/);
  }
  assert.equal(fs.existsSync(older), true, "a refused drop deletes nothing");
  assert.equal(fs.existsSync(newer), true);
});

test("POST /api/salvage-apply with an injected refusal reports the does-not-apply message without deleting the patch", async () => {
  const repo = makeRepo();
  const { older } = seedSalvage(repo);
  // Inject an apply that always refuses (a real `git apply` would need a fitting tree): the
  // handler must surface the refusal and never delete the patch.
  let injected = false;
  const { captured, data } = await captureJson((res) =>
    handleSalvageApply(fakeReq(JSON.stringify({ position: 1 })), res, repo, async () => {
      injected = true;
      return false;
    }),
  );
  assert.equal(injected, true, "the injected operation ran");
  assert.equal(captured.status, 200);
  const d = data as { ok: boolean; message: string };
  assert.equal(d.ok, false);
  assert.ok(d.message.includes("does not apply cleanly"));
  assert.equal(fs.existsSync(older), true, "a refused apply keeps the patch");
});

test("POST /api/salvage-drop with an injected failure reports could-not-drop without deleting", async () => {
  const repo = makeRepo();
  const { older } = seedSalvage(repo);
  const { captured, data } = await captureJson((res) =>
    handleSalvageDrop(fakeReq(JSON.stringify({ position: 1 })), res, repo, () => false),
  );
  assert.equal(captured.status, 200);
  const d = data as { ok: boolean; message: string };
  assert.equal(d.ok, false);
  assert.equal(d.message, "could not drop salvaged patch a.patch");
  assert.equal(fs.existsSync(older), true, "a failed drop keeps the patch");
});
