import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { configBytesToPreserve, ffMainTo, restoreConfigBytes } from "../src/landing/landing-git.js";
import { loadConfig } from "../src/config/config.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { assertClean, commitIn, headSha, makeRepo, sh } from "./fixtures/repo-fixtures.js";
import { patchFsMethod } from "./helpers/fs-faults.js";

/** landing-git.ts's config write-back across a landing that untracks tumwater.json, split out
 * of landing-merge.test.ts (whose mergeToMain clusters stay there): these tests exercise
 * ffMainTo's preserve-and-restore path and configBytesToPreserve's contract directly, with no
 * MergeContext or pi run involved. */
// ── Config preserve across an untracking landing (plans/portability.md §4b/7): the working-tree
// merge deletes a tracked config out from under the running fleet, so ffMainTo saves the live
// bytes and restores them when the landing removed the file ───────────────────────────

/** The pre-4a shape this landing retires: a repo whose tumwater.json is TRACKED, with a
 * .gitignore that does not yet list it (but does ignore .tumwater/, so root's
 * `git status --porcelain` stays clean around the worktree dir). */
function trackedConfigRoot(config: string): string {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, ".gitignore"), ".tumwater/\nnode_modules/\ndist/\n");
  fs.writeFileSync(path.join(root, "tumwater.json"), config);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "track the config");
  return root;
}

/** A worktree branch that untracks the config: delete the file, list it in .gitignore. */
async function untrackingBranch(root: string): Promise<string> {
  const wt = await ensureWorktree(root, "improve", "main");
  fs.rmSync(path.join(wt, "tumwater.json"));
  fs.appendFileSync(path.join(wt, ".gitignore"), "tumwater.json\n");
  commitIn(wt, "untrack the config");
  return headSha(wt);
}

test("a landing that untracks the config preserves the live file byte-identical", async () => {
  const config =
    '{"provider":"o","model":"m","fallbackModel":{"provider":"f","model":"fm"},' +
    '"maxConcurrent":3,"tickTimeoutSeconds":54000,"quietTimeoutSeconds":1800,' +
    '"idleBackoff":{"initialSeconds":120,"factor":2,"maxSeconds":36000}}\n';
  const root = trackedConfigRoot(config);
  const parsedBefore = loadConfig(root);
  const before = fs.readFileSync(path.join(root, "tumwater.json"));
  const sha = await untrackingBranch(root);

  assert.ok(await ffMainTo(root, sha, "main"));
  assert.equal(sh(root, "git", "ls-files", "tumwater.json"), "", "untracked on main");
  assert.ok(fs.existsSync(path.join(root, "tumwater.json")), "restored, not deleted");
  assert.ok(
    before.equals(fs.readFileSync(path.join(root, "tumwater.json"))),
    "byte-identical to the pre-landing file",
  );
  assert.deepEqual(loadConfig(root), parsedBefore, "the parsed config survives the landing");
  assertClean(root, "restored file is ignored, tree clean");
});

test("a landing whose tree keeps the config leaves the live file untouched", async () => {
  const root = trackedConfigRoot('{"provider":"o"}\n');
  const wt = await ensureWorktree(root, "improve", "main");
  fs.writeFileSync(path.join(wt, "seed.txt"), "changed\n");
  commitIn(wt, "edit seed");
  const sha = headSha(wt);

  assert.equal(await configBytesToPreserve(root, sha), null, "config present in ref: no preserve");
  assert.ok(await ffMainTo(root, sha, "main"));
  assert.equal(sh(root, "git", "ls-files", "tumwater.json"), "tumwater.json", "still tracked");
  assert.equal(fs.readFileSync(path.join(root, "tumwater.json"), "utf8"), '{"provider":"o"}\n');
});

test("a landing on a repo with no config needs no preserve and still fast-forwards", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, ".gitignore"), ".tumwater/\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "ignore .tumwater");
  const wt = await ensureWorktree(root, "improve", "main");
  fs.writeFileSync(path.join(wt, "new.txt"), "new\n");
  commitIn(wt, "add a file");
  const sha = headSha(wt);

  assert.equal(await configBytesToPreserve(root, sha), null, "no live config: nothing to preserve");
  assert.ok(await ffMainTo(root, sha, "main"));
  assert.ok(!fs.existsSync(path.join(root, "tumwater.json")));
  assertClean(root);
});

test("a crash mid write-back leaves the live config absent, never torn", () => {
  const root = makeRepo();
  const cfg = path.join(root, "tumwater.json");
  const saved = Buffer.from('{"provider":"preserved"}\n');
  assert.ok(!fs.existsSync(cfg), "the landing deleted the live config");

  // Inject the fault: the write dies after emitting half the bytes (an interrupted write —
  // SIGKILL, the OOM killer, a full disk). The live config path must never hold that prefix;
  // the tmp the atomic writer uses may, and is cleaned up on the rethrow.
  const restoreWrite = patchFsMethod("writeFileSync", (orig) => (file, data, ...rest) => {
    if (typeof file === "string" && file.startsWith(cfg)) {
      const text = typeof data === "string" ? data : String(data);
      orig(file, text.slice(0, Math.ceil(text.length / 2)), ...rest);
      throw new Error("simulated interrupted write");
    }
    return orig(file, data, ...rest);
  });
  try {
    assert.throws(() => restoreConfigBytes(root, saved), /simulated interrupted write/);
  } finally {
    restoreWrite();
  }
  assert.ok(!fs.existsSync(cfg), "the torn prefix did not survive at the live config path");
  assert.deepEqual(
    fs.readdirSync(root).filter((f) => f.includes(".tmp-")),
    [],
    "no tmp remnant is left behind",
  );
});

test("the config write-back is restore-only-when-absent: a newer write wins", async () => {
  const root = trackedConfigRoot('{"provider":"old"}\n');
  const sha = await untrackingBranch(root);

  const saved = await configBytesToPreserve(root, sha);
  assert.ok(saved, "a tracked config absent from the ref is preserved");
  assert.ok(await ffMainTo(root, sha, "main"));
  // Replay the applyConfigRequest race (3/7's write lands between the merge and the write-back):
  // the file exists again with newer bytes, and the restore must leave them alone.
  fs.writeFileSync(path.join(root, "tumwater.json"), '{"provider":"newer"}\n');
  restoreConfigBytes(root, saved);
  assert.equal(
    fs.readFileSync(path.join(root, "tumwater.json"), "utf8"),
    '{"provider":"newer"}\n',
    "the newer bytes win",
  );
});
