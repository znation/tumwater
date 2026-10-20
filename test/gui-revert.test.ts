import test from "node:test";
import assert from "node:assert/strict";
import { handleRevert } from "../src/gui/gui-endpoint-commands.js";
import { captureJson, fakeReq } from "./fakes/fake-res.js";
import { headSha, makeRepo, seedCommit, sh } from "./fixtures/repo-fixtures.js";

// POST /api/revert: the History drill-down's preview-then-revert button, through the same cores
// `tumwater revert` uses.

const post = (root: string, body: unknown) => captureJson((res) => handleRevert(fakeReq(JSON.stringify(body)), res, root));
const status = (root: string) => sh(root, "git", "status", "--porcelain");

test("POST /api/revert dryRun previews and writes nothing", async () => {
  const repo = makeRepo();
  seedCommit(repo, "file.txt", "content\n", "first work commit");
  const sha = headSha(repo);
  const { captured, data } = await post(repo, { sha, dryRun: true });
  assert.equal(captured.status, 200);
  const d = data as { ok: boolean; preview: { applies: boolean; subject: string; paths: string[] } };
  assert.equal(d.ok, true);
  assert.equal(d.preview.applies, true);
  assert.deepEqual(d.preview.paths, ["file.txt"]);
  assert.equal(headSha(repo), sha, "HEAD did not move");
  assert.equal(status(repo), "");
});

test("POST /api/revert reverts a merged commit", async () => {
  const repo = makeRepo();
  seedCommit(repo, "file.txt", "content\n", "first work commit");
  const sha = headSha(repo);
  const { captured, data } = await post(repo, { sha });
  assert.equal(captured.status, 200);
  assert.equal(headSha(repo), (data as { headSha: string }).headSha);
  assert.notEqual(headSha(repo), sha, "HEAD moved");
  assert.equal(sh(repo, "git", "log", "-1", "--format=%s"), `tumwater(operator): Revert ${sha.slice(0, 8)}`);
  assert.match((data as { message: string }).message, /^main is now [0-9a-f]+$/);
});

test("POST /api/revert refuses a sha not on main with 409 and writes nothing", async () => {
  const repo = makeRepo();
  const base = sh(repo, "git", "rev-parse", "--abbrev-ref", "HEAD");
  sh(repo, "git", "checkout", "-q", "-b", "side");
  seedCommit(repo, "side.txt", "x\n", "side work");
  const sha = headSha(repo);
  sh(repo, "git", "checkout", "-q", base);
  const before = headSha(repo);
  for (const body of [{ sha }, { sha, dryRun: true }]) {
    const { captured, data } = await post(repo, body);
    assert.equal(captured.status, 409);
    assert.match((data as { error: string }).error, /is not on /);
  }
  assert.equal(headSha(repo), before);
  assert.equal(status(repo), "");
});

test("POST /api/revert rejects a non-hex sha and a non-boolean dryRun with 400", async () => {
  const repo = makeRepo();
  const before = headSha(repo);
  for (const body of [{ sha: "--json" }, { sha: "main" }, { sha: 42 }, { sha: before, dryRun: "yes" }]) {
    const { captured } = await post(repo, body);
    assert.equal(captured.status, 400, JSON.stringify(body));
  }
  assert.equal(headSha(repo), before);
});

test("POST /api/revert with no sha is a 400 that names no undefined value", async () => {
  const repo = makeRepo();
  const { captured, data } = await post(repo, {});
  assert.equal(captured.status, 400);
  assert.doesNotMatch((data as { error: string }).error, /got undefined/);
});
