import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { secretEnvValues, secretLeakReason } from "../src/review/secret-leaks.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { makeRepo, sh } from "./fixtures/repo-fixtures.js";

const VALUE = "hf_abcdefghijklmnopqrstuvwxyz";
const ENV = { HF_TOKEN: VALUE };

async function worktree(base: Record<string, string>, edit: Record<string, string>) {
  const root = makeRepo();
  for (const [f, c] of Object.entries(base)) fs.writeFileSync(path.join(root, f), c);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "base");
  const wt = await ensureWorktree(root, "improve", "main");
  for (const [f, c] of Object.entries(edit)) {
    fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
    fs.writeFileSync(path.join(wt, f), c);
  }
  return wt;
}

test("secretEnvValues keeps long credential-named values only", () => {
  const got = secretEnvValues({
    HF_TOKEN: VALUE,
    SHORT_TOKEN: "abc",
    SPACED_SECRET: "has some whitespace in it",
    GOOGLE_APPLICATION_CREDENTIALS: "/path/to/key.json",
    HOME: "/Users/someone/long/home/dir",
    PLAIN: "abcdefghijklmnopqrstuvwxyz",
  });
  assert.deepEqual(got, [{ name: "HF_TOKEN", value: VALUE }]);
});

test("secretLeakReason names the file and variable, never the value", async () => {
  const wt = await worktree({ "README.md": "# T\n" }, { "report.json": `{"env":"${VALUE}"}` });
  const reason = await secretLeakReason(wt, "main", ["report.json"], ENV);
  assert.match(reason!, /`report\.json` contains the value of \$HF_TOKEN/);
  assert.ok(!reason!.includes(VALUE));
});

test("secretLeakReason passes a value already at the merge-base, a directory, and no secrets", async () => {
  const wt = await worktree({ "old.json": VALUE }, { "old.json": `${VALUE}\nmore`, "dir/x.json": VALUE });
  assert.equal(await secretLeakReason(wt, "main", ["old.json"], ENV), undefined);
  assert.equal(await secretLeakReason(wt, "main", ["dir"], ENV), undefined);
  assert.equal(await secretLeakReason(wt, "main", ["dir/x.json"], {}), undefined);
});
