import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  handleSalvageList,
  handleSalvageShow,
  handleSalvageApply,
  handleSalvageDrop,
} from "../src/gui/gui-endpoint-commands.js";
import { salvageDir, salvagePendingDir } from "../src/paths.js";
import { makeRepo, sh, headSha, tmpdir, runningAsRoot, writeConfig } from "./fixtures/repo-fixtures.js";
import { startLocalGui } from "./fixtures/gui-fixtures.js";
import { captureJson, fakeReq } from "./fakes/fake-res.js";

// The dashboard's salvaged workspace patch endpoints (src/gui/gui-salvage-commands.ts): the
// browser twins of `tumwater salvage`'s list, `--show <n>`, `--apply <n>` and `--drop <n>`,
// driven the way test/gui-retire.test.ts drives the retire handlers — the real domain functions
// against a temp repo, captured through the shared fake request/response, no socket.
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
  const { captured, data } = await captureJson((res) => handleSalvageList(new URLSearchParams(), res, repo));
  assert.equal(captured.status, 200);
  const patches = (data as { patches: Array<{ position: number; file: string; savedAt: number; bytes: number; size: string; prune: string }>; total: number }).patches;
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
  // Each record names its own prune deadline: with no tumwater.json the window is
  // defaultConfig()'s 7 days, so a.patch (3h old) is 6.875d out — the day bucket's 7d — and
  // b.patch (30s old) is 6d23h59m30s out, which rounds up to the same 7d. A record that
  // omitted prune fails both assertions, and a card row built from it prints no clause.
  assert.equal(patches[0]!.prune, "prune deadline in 7d");
  assert.equal(patches[1]!.prune, "prune deadline in 7d");
  // The unfiltered listing answers the whole-list count beside its rows, so the card can say
  // how many rows a filter hid.
  assert.equal((data as { total: number }).total, 2);
});

// The card's search box: GET /api/salvage?q=<text> narrows through the CLI's own
// grepSalvagePatches, so it searches the patch body and not only the file name, and every kept
// row carries the position it holds in the unfiltered list (INV-SV1's one shared position).
test("GET /api/salvage with q matches inside the patch text case-insensitively and keeps each row's whole-list position", async () => {
  const repo = makeRepo();
  seedSalvage(repo);
  // "NEWER" sits only in b.patch's body ("newer patch body"): a name-only filter would answer
  // no rows, and a renumbering filter would answer it as position 1.
  const kept = (await captureJson((res) =>
    handleSalvageList(new URLSearchParams({ q: "NEWER" }), res, repo),
  )).data as { patches: Array<{ position: number; file: string; prune: string }>; total: number };
  assert.deepEqual(kept.patches.map((p) => [p.position, p.file]), [[2, "b.patch"]]);
  // The surviving row keeps its prune clause, phrased from its own age like the other rows.
  assert.equal(kept.patches[0]!.prune, "prune deadline in 7d");
  // total is the whole-list count, filtered or not.
  assert.equal(kept.total, 2);
  // A pattern only the older patch's body carries keeps that patch at its own number.
  const older = (await captureJson((res) =>
    handleSalvageList(new URLSearchParams({ q: "OLD" }), res, repo),
  )).data as { patches: Array<{ position: number; file: string }>; total: number };
  assert.deepEqual(older.patches.map((p) => [p.position, p.file]), [[1, "a.patch"]]);
  assert.equal(older.total, 2);
  // A pattern nothing matches answers no rows but the whole-list total.
  const none = (await captureJson((res) =>
    handleSalvageList(new URLSearchParams({ q: "nowhere-in-the-patches" }), res, repo),
  )).data as { patches: unknown[]; total: number };
  assert.deepEqual(none.patches, []);
  assert.equal(none.total, 2);
  // An empty q is no filter at all: the body is identical to an absent q's, rows and total.
  const emptyQ = await captureJson((res) => handleSalvageList(new URLSearchParams({ q: "" }), res, repo));
  const absentQ = await captureJson((res) => handleSalvageList(new URLSearchParams(), res, repo));
  assert.equal(emptyQ.captured.status, 200);
  assert.deepEqual(emptyQ.data, absentQ.data);
});

// A filtered card row's number addresses the same patch as an unfiltered one: the endpoint
// filters rows, never renumbers them, and show/apply/drop still address the whole list.
test("GET /api/salvage with q answers whole-list positions show then reads back at the same number", async () => {
  const repo = makeRepo();
  seedSalvage(repo);
  const listed = (await captureJson((res) =>
    handleSalvageList(new URLSearchParams({ q: "newer patch body" }), res, repo),
  )).data as { patches: Array<{ position: number; file: string }>; total: number };
  assert.deepEqual(listed.patches.map((p) => [p.position, p.file]), [[2, "b.patch"]]);
  // That row's own number reads b.patch back.
  const row = (await captureJson((res) =>
    handleSalvageShow(new URLSearchParams({ position: "2" }), res, repo),
  )).data as { position: number; file: string; patch: string };
  assert.equal(row.position, 2);
  assert.equal(row.file, "b.patch");
  assert.equal(row.patch, "newer patch body\n");
  // A number the filtered card does not show still addresses its patch: the filter hides rows,
  // it does not move the list.
  const hidden = (await captureJson((res) =>
    handleSalvageShow(new URLSearchParams({ position: "1" }), res, repo),
  )).data as { ok?: boolean; file?: string; patch?: string };
  assert.equal(hidden.file, "a.patch");
  assert.equal(hidden.patch, OLDER_TEXT);
  // The off-list sentence still counts the whole salvage dir, not the filtered rows — a handler
  // that renumbered 1..kept would state "1 patch" here.
  const off = (await captureJson((res) =>
    handleSalvageShow(new URLSearchParams({ position: "3" }), res, repo),
  )).data as { ok: boolean; message: string };
  assert.equal(off.ok, false);
  assert.equal(off.message, "no salvaged workspace patch at position 3 (salvage holds 2 patches) — valid: 1-2");
});

// The card's window comes from the live config, not defaultConfig(): a written
// sessionRetentionDays changes the figure on the next request without a restart.
test("GET /api/salvage names each patch's deadline from the configured sessionRetentionDays, including 0 = never pruned", async () => {
  let repo = makeRepo();
  seedSalvage(repo);
  writeConfig(repo, { sessionRetentionDays: 1 });
  let { data } = await captureJson((res) => handleSalvageList(new URLSearchParams(), res, repo));
  let patches = (data as { patches: Array<{ file: string; prune: string }> }).patches;
  // a.patch is 3h old under a 24h window: 21h left, the hour bucket.
  assert.equal(patches[0]!.file, "a.patch");
  assert.equal(patches[0]!.prune, "prune deadline in 21h");
  repo = makeRepo();
  seedSalvage(repo);
  writeConfig(repo, { sessionRetentionDays: 0 });
  ({ data } = await captureJson((res) => handleSalvageList(new URLSearchParams(), res, repo)));
  const offPatches = (data as { patches: Array<{ prune: string }> }).patches;
  assert.deepEqual(
    offPatches.map((p) => p.prune),
    ["retention is off, so this patch is never pruned", "retention is off, so this patch is never pruned"],
  );
});

test("GET /api/salvage with no salvage dir answers the empty list, creating nothing", async () => {
  const repo = makeRepo();
  const { captured, data } = await captureJson((res) => handleSalvageList(new URLSearchParams(), res, repo));
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { patches: [], total: 0 });
  assert.equal(fs.existsSync(salvageDir(repo)), false, "the list never creates the salvage dir");
  // A filter on a dir that does not exist answers the same body and still creates nothing.
  const filtered = await captureJson((res) => handleSalvageList(new URLSearchParams({ q: "x" }), res, repo));
  assert.equal(filtered.captured.status, 200);
  assert.deepEqual(filtered.data, { patches: [], total: 0 });
  assert.equal(fs.existsSync(salvageDir(repo)), false, "a filtered list never creates the salvage dir");
});

interface SalvageListBody {
  patches: { position: number; file: string }[];
  total: number;
}

// The card's own request path (src/ui/gui/gui-client-settings.ts fetches `/api/salvage` and
// `/api/salvage?q=<encoded>`): the route must hand the URL's own query to the handler, not a
// bare empty URLSearchParams, so the filter survives the socket. Everything below is derived
// from the seed order, not read back from a previous response.
test("the live server routes GET /api/salvage to the listing and carries ?q= through to it", async () => {
  const repo = makeRepo();
  seedSalvage(repo);
  const { server, base } = await startLocalGui(repo);
  try {
    const all = (await (await fetch(base + "/api/salvage")).json()) as SalvageListBody;
    // The whole list, oldest first, numbered 1 and 2 — the route passed the repo root through.
    assert.deepEqual(
      all.patches.map((p) => [p.position, p.file]),
      [[1, "a.patch"], [2, "b.patch"]],
    );
    assert.equal(all.total, 2);
    // ?q=NEWER reaches the handler: only b.patch's body carries the word, and the kept row keeps
    // the position it holds in the unfiltered list. A route that dropped the query would answer
    // both rows here.
    const filtered = (await (await fetch(base + "/api/salvage?q=NEWER")).json()) as SalvageListBody;
    assert.deepEqual(filtered.patches.map((p) => [p.position, p.file]), [[2, "b.patch"]]);
    assert.equal(filtered.total, 2, "a filtered listing still answers the whole-list count");
    // The read stays read-only over the socket: a known path with the wrong method is the 404
    // every other GET route answers.
    const post = await fetch(base + "/api/salvage", { method: "POST" });
    assert.equal(post.status, 404, "the listing has no POST twin");
  } finally {
    server.close();
  }
});

test("GET /api/salvage-show reads a kept patch back with the CLI's --show fields, addressing the list position", async () => {
  const repo = makeRepo();
  const { older, newer } = seedSalvage(repo);
  // The list's own rows first: the show reply's file/savedAt/bytes/size must equal them.
  const listed = (await captureJson((res) => handleSalvageList(new URLSearchParams(), res, repo))).data as {
    patches: Array<{ position: number; file: string; savedAt: number; bytes: number; size: string }>;
  };
  const before = fs.readdirSync(salvageDir(repo)).sort();
  const olderRow = listed.patches[0]!;
  const { captured, data } = await captureJson((res) =>
    handleSalvageShow(new URLSearchParams({ position: "1" }), res, repo),
  );
  assert.equal(captured.status, 200);
  const d = data as { position: number; file: string; savedAt: number; bytes: number; size: string; stat: string | null; patch: string };
  assert.equal(d.position, 1);
  assert.equal(d.file, olderRow.file);
  assert.equal(d.savedAt, olderRow.savedAt);
  assert.equal(d.bytes, olderRow.bytes);
  assert.equal(d.size, olderRow.size);
  // The patch text verbatim — exactly the file's bytes, nothing added or trimmed.
  assert.equal(d.patch, fs.readFileSync(older, "utf8"));
  assert.equal(d.patch, OLDER_TEXT);
  // git apply --stat read without applying: the one changed file and its totals.
  assert.ok(d.stat !== null, "a valid diff gets a diffstat");
  assert.ok(d.stat.includes("1 file changed"), `stat names the changed file (got ${d.stat})`);
  // The newer patch at the next position.
  const newerRow = await captureJson((res) =>
    handleSalvageShow(new URLSearchParams({ position: "2" }), res, repo),
  );
  assert.equal((newerRow.data as { file: string; patch: string }).file, listed.patches[1]!.file);
  assert.equal((newerRow.data as { patch: string }).patch, fs.readFileSync(newer, "utf8"));
  // A pending patch is not addressable at any position: the list holds two, so 3 is off-list.
  const pending = await captureJson((res) =>
    handleSalvageShow(new URLSearchParams({ position: "3" }), res, repo),
  );
  assert.equal((pending.data as { ok: boolean; message: string }).ok, false);
  assert.ok((pending.data as { message: string }).message.includes("salvage holds 2 patches"));
  // The read is read-only: the salvage dir holds exactly what it held before.
  assert.deepEqual(fs.readdirSync(salvageDir(repo)).sort(), before, "the read creates nothing in the salvage dir");
});

test("GET /api/salvage-show answers stat null for a patch that is not a diff, and a non-null stat for one that is", async () => {
  const repo = makeRepo();
  fs.mkdirSync(salvageDir(repo), { recursive: true });
  // A truncated `From <sha>` scratch file — what an aborted review lands leaves behind.
  const scratch = "From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001 +0000\nSubject: [PATCH] half a diff\n\n";
  fs.writeFileSync(path.join(salvageDir(repo), "scratch.patch"), scratch);
  fs.utimesSync(path.join(salvageDir(repo), "scratch.patch"), new Date(1), new Date(1));
  const { captured, data } = await captureJson((res) =>
    handleSalvageShow(new URLSearchParams({ position: "1" }), res, repo),
  );
  assert.equal(captured.status, 200);
  const d = data as { stat: string | null; patch: string };
  assert.equal(d.stat, null, "a non-diff body has no diffstat");
  assert.equal(d.patch, scratch, "the text comes back unchanged");
});

test("GET /api/salvage-show with no salvage dir creates nothing and answers the off-list sentence", async () => {
  const repo = makeRepo();
  const { captured, data } = await captureJson((res) =>
    handleSalvageShow(new URLSearchParams({ position: "1" }), res, repo),
  );
  assert.equal(captured.status, 200);
  const d = data as { ok: boolean; message: string };
  assert.equal(d.ok, false);
  assert.equal(d.message, "no salvaged workspace patch at position 1 (salvage holds 0 patches)");
  assert.equal(fs.existsSync(salvageDir(repo)), false, "the read never creates the salvage dir");
});

test("GET /api/salvage-show with an absent or malformed position is a 400 with the shared query wording", async () => {
  const repo = makeRepo();
  seedSalvage(repo);
  const absent = await captureJson((res) => handleSalvageShow(new URLSearchParams(), res, repo));
  assert.equal(absent.captured.status, 400);
  assert.deepEqual(absent.data, { error: "position required" });
  for (const value of ["abc", "0", "1e2"]) {
    const bad = await captureJson((res) => handleSalvageShow(new URLSearchParams({ position: value }), res, repo));
    assert.equal(bad.captured.status, 400);
    assert.match((bad.data as { error: string }).error, /position must be a positive integer/);
  }
});

test("GET /api/salvage-show with a position off the list answers the sentence --drop <n> prints", async () => {
  const repo = makeRepo();
  const { older } = seedSalvage(repo);
  const { captured, data } = await captureJson((res) =>
    handleSalvageShow(new URLSearchParams({ position: "7" }), res, repo),
  );
  assert.equal(captured.status, 200);
  const d = data as { ok: boolean; message: string };
  assert.equal(d.ok, false);
  assert.equal(d.message, "no salvaged workspace patch at position 7 (salvage holds 2 patches) — valid: 1-2");
  assert.equal(fs.readFileSync(older, "utf8"), OLDER_TEXT, "an off-list read changes nothing");
});

test("GET /api/salvage-show of an unreadable patch answers the CLI's could-not-read sentence", { skip: runningAsRoot() }, async () => {
  const repo = makeRepo();
  fs.mkdirSync(salvageDir(repo), { recursive: true });
  const unreadable = path.join(salvageDir(repo), "sealed.patch");
  fs.writeFileSync(unreadable, OLDER_TEXT);
  fs.chmodSync(unreadable, 0o000);
  try {
    const { captured, data } = await captureJson((res) =>
      handleSalvageShow(new URLSearchParams({ position: "1" }), res, repo),
    );
    assert.equal(captured.status, 200);
    const d = data as { ok: boolean; message: string };
    assert.equal(d.ok, false);
    assert.equal(d.message, "could not read salvaged patch sealed.patch");
  } finally {
    fs.chmodSync(unreadable, 0o600);
  }
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
  assert.equal(d.message, "no salvaged workspace patch at position 9 (salvage holds 1 patch) — valid: 1-1");
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
  assert.equal(d.message, "no salvaged workspace patch at position 9 (salvage holds 2 patches) — valid: 1-2");
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
