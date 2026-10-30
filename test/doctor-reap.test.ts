import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitOnlyBinDir, makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { cli, cliWithEnv } from "./helpers/cli-harness.js";
import { diskHermeticRepo } from "./fixtures/doctor-fixtures.js";

// The `tumwater doctor` reap flags that act before the report (see doctor.test.ts for the
// split): --kill-orphans, --commit-backlog and --resync-install, each printed ahead of the
// report and carried as its own field under --json, and two of them combined.

test("doctor --kill-orphans reports an unreadable process table, then the report; with --json it is the report's orphanKill field", async () => {
  // The no-ps PATH keeps the scan off the host's real table: a real scan could kill another
  // agent's leaked process.
  const env = { PATH: gitOnlyBinDir() };
  const r = await cliWithEnv(tmpdir(), env, ["doctor", "--kill-orphans"]);
  assert.match(r.stdout, /^could not scan the process table — .*; nothing killed\n\n/);
  assert.match(r.stdout, /warn\s+orphans\s+could not scan the process table/);
  assert.equal(r.code, 1, "exit follows the report's verdict");
  const json = await cliWithEnv(tmpdir(), env, ["doctor", "--kill-orphans", "--json"]);
  assert.equal(json.code, 1);
  const doc = JSON.parse(json.stdout);
  assert.ok(typeof doc.orphanKill.error === "string" && doc.orphanKill.error.length > 0);
  assert.equal(doc.checks.find((c: { name: string }) => c.name === "orphans").level, "warn");
  const prob = JSON.parse((await cliWithEnv(tmpdir(), env, ["doctor", "--kill-orphans", "--problems", "--json"])).stdout);
  assert.ok(prob.orphanKill.error);
  assert.ok(!prob.checks.some((c: { level: string }) => c.level === "ok"));
  const plain = JSON.parse((await cliWithEnv(tmpdir(), env, ["doctor", "--json"])).stdout);
  assert.ok(!("orphanKill" in plain));
});

test("doctor --commit-backlog commits a dirty backlog file before the report; with --json it is the report's backlogCommit field", async () => {
  const repo = await diskHermeticRepo("cli doctor commit backlog");
  fs.appendFileSync(path.join(repo, "PLANS.md"), "edit\n");
  const json = await cli(repo, "doctor", "--commit-backlog", "--json");
  const doc = JSON.parse(json.stdout);
  assert.deepEqual(doc.backlogCommit.committed, ["PLANS.md"]);
  assert.equal(doc.checks.find((c: { name: string }) => c.name === "uncommitted backlog").level, "ok");
  assert.equal(sh(repo, "git", "status", "--porcelain", "--", "PLANS.md"), "");
  fs.appendFileSync(path.join(repo, "PLANS.md"), "edit2\n");
  const r = await cli(repo, "doctor", "--commit-backlog");
  assert.match(r.stdout, /^committed PLANS\.md on main\n/m);
  assert.ok(r.stdout.indexOf("committed PLANS.md on main") < r.stdout.indexOf("uncommitted backlog"));
  const plain = JSON.parse((await cli(repo, "doctor", "--json")).stdout);
  assert.ok(!("backlogCommit" in plain));
});

test("doctor combines two reap flags under --json in payload order (resyncInstall before backlogCommit)", async () => {
  // doctorPayload appends the optional keys in the closure chain's original order — leftoverRetire,
  // brokenPinDrop, resyncInstall, backlogCommit, orphanKill — so a combined --json run must keep
  // resyncInstall ahead of backlogCommit even though the other keys are absent. This pins the byte
  // order that a payload-level diff (or a consumer that reads keys) would otherwise depend on.
  const repo = await diskHermeticRepo("cli doctor combined reap");
  fs.appendFileSync(path.join(repo, "PLANS.md"), "edit\n");
  const json = await cli(repo, "doctor", "--resync-install", "--commit-backlog", "--json");
  const doc = JSON.parse(json.stdout);
  assert.equal(doc.resyncInstall.attempted, false);
  assert.equal(doc.resyncInstall.ok, true);
  assert.deepEqual(doc.resyncInstall.packages, []);
  assert.deepEqual(doc.backlogCommit.committed, ["PLANS.md"]);
  const keys = Object.keys(doc);
  assert.ok(keys.includes("resyncInstall") && keys.includes("backlogCommit"));
  assert.ok(
    keys.indexOf("resyncInstall") < keys.indexOf("backlogCommit"),
    `resyncInstall must precede backlogCommit in the --json payload (key order: ${keys.join(",")})`,
  );
});

test("doctor --resync-install is accepted and reports nothing to do without a lockfile", async () => {
  // A bare repo (no package-lock.json) pins nothing, so the re-sync has nothing to do; a
  // `.tumwater` dir lets the merge lock acquire (a real project always has one).
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".tumwater"), { recursive: true });
  const json = await cli(repo, "doctor", "--resync-install", "--json");
  const doc = JSON.parse(json.stdout);
  assert.equal(doc.resyncInstall.attempted, false);
  assert.equal(doc.resyncInstall.ok, true);
  assert.deepEqual(doc.resyncInstall.packages, []);
  assert.equal(doc.resyncInstall.pinned, false);
  const r = await cli(repo, "doctor", "--resync-install");
  assert.match(r.stdout, /^no package-lock\.json to match — nothing to re-sync\n/m);
  assert.ok(r.stdout.indexOf("nothing to re-sync") < r.stdout.indexOf("tumwater doctor — not running"));
  // Without the flag the doctor payload is unchanged — no resyncInstall field.
  const plain = JSON.parse((await cli(repo, "doctor", "--json")).stdout);
  assert.ok(!("resyncInstall" in plain));
});

test("doctor --resync-install on a matched root says the tree already matches the lockfile", async () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".tumwater"), { recursive: true });
  fs.mkdirSync(path.join(repo, "node_modules", "ink"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "proj", dependencies: { ink: "7.1.1" } }, "node_modules/ink": { version: "7.1.1" } } }));
  fs.writeFileSync(path.join(repo, "node_modules/ink/package.json"), JSON.stringify({ name: "ink", version: "7.1.1" }));
  const json = await cli(repo, "doctor", "--resync-install", "--json");
  const doc = JSON.parse(json.stdout);
  assert.equal(doc.resyncInstall.attempted, false);
  assert.equal(doc.resyncInstall.pinned, true);
  const r = await cli(repo, "doctor", "--resync-install");
  assert.match(r.stdout, /^node_modules already matches package-lock\.json — nothing to re-sync\n/m);
});
