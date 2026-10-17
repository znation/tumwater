import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type http from "node:http";
import { handleRetireList } from "../src/gui/gui-endpoints.js";
import { handleRetire } from "../src/gui/gui-endpoint-commands.js";
import { worktreePath } from "../src/paths.js";
import { initializedWorktree, sh } from "./fixtures/repo-fixtures.js";
import { captureJson } from "./fakes/fake-res.js";
import { readJson } from "./helpers/json-read.js";

// The dashboard's retire endpoints: GET /api/retire lists disabled roles' leftovers and POST
// /api/retire removes them through the same cores `tumwater retire --role <id>` uses.

function fakeReq(body: string): http.IncomingMessage {
  const req = new EventEmitter() as unknown as http.IncomingMessage;
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

/** Disable one role in the repo's tumwater.json in place. */
function disableRole(root: string, role: string): void {
  const file = path.join(root, "tumwater.json");
  const cfg = readJson(file) as { roles: Record<string, { enabled?: boolean }> };
  cfg.roles ??= {};
  cfg.roles[role] = { ...cfg.roles[role], enabled: false };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
}

const post = (root: string, body: unknown) => captureJson((res) => handleRetire(fakeReq(JSON.stringify(body)), res, root));
const branchExists = (root: string) => {
  try {
    sh(root, "git", "rev-parse", "--verify", "tumwater/improve");
    return true;
  } catch {
    return false;
  }
};

test("GET /api/retire lists a disabled role's leftovers and omits enabled roles", async () => {
  const { root } = await initializedWorktree();
  disableRole(root, "improve");
  const { captured, data } = await captureJson((res) => handleRetireList(res, root));
  assert.equal(captured.status, 200);
  const roles = (data as { roles: Array<{ role: string; wouldRemove: string[]; phrases: string[]; objections: string[] }> }).roles;
  assert.equal(roles.length, 1);
  assert.equal(roles[0]!.role, "improve");
  assert.ok(roles[0]!.wouldRemove.includes("worktree") && roles[0]!.wouldRemove.includes("branch"));
  assert.ok(roles[0]!.phrases.includes("the branch (tumwater/improve)"));
  assert.deepEqual(roles[0]!.objections, []);
  const enabled = await initializedWorktree();
  const again = await captureJson((res) => handleRetireList(res, enabled.root));
  assert.deepEqual(again.data, { roles: [] });
});

test("GET /api/retire answers 500 on an unreadable tumwater.json", async () => {
  const { root } = await initializedWorktree();
  fs.writeFileSync(path.join(root, "tumwater.json"), "{");
  const { captured } = await captureJson((res) => handleRetireList(res, root));
  assert.equal(captured.status, 500);
});

test("POST /api/retire removes a disabled role's worktree and branch", async () => {
  const { root } = await initializedWorktree();
  disableRole(root, "improve");
  const first = await post(root, { role: "improve" });
  assert.equal(first.captured.status, 200);
  const d = first.data as { removed: string[]; message: string };
  assert.ok(d.removed.includes("branch"));
  assert.match(d.message, /removed the branch \(tumwater\/improve\)/);
  assert.equal(branchExists(root), false);
  const second = await post(root, { role: "improve" });
  assert.equal(second.captured.status, 200);
  assert.equal((second.data as { message: string }).message, "nothing to remove for role improve");
});

test("POST /api/retire refuses an enabled role with 409 and removes nothing", async () => {
  const { root } = await initializedWorktree();
  const { captured, data } = await post(root, { role: "improve" });
  assert.equal(captured.status, 409);
  assert.match((data as { error: string }).error, /still enabled/);
  assert.ok(fs.existsSync(worktreePath(root, "improve")));
});

test("POST /api/retire rejects force, a missing role, and an unknown role with 400", async () => {
  const { root } = await initializedWorktree();
  disableRole(root, "improve");
  const forced = await post(root, { role: "improve", force: true });
  assert.equal(forced.captured.status, 400);
  assert.match((forced.data as { error: string }).error, /never forces/);
  assert.ok(branchExists(root));
  assert.equal((await post(root, {})).captured.status, 400);
  const bogus = await post(root, { role: "bogus" });
  assert.equal(bogus.captured.status, 400);
  assert.match((bogus.data as { error: string }).error, /unknown role/);
});
