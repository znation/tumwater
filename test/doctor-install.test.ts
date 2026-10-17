import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkRootInstall } from "../src/doctor/doctor-install.js";
import { logEvent } from "../src/events/events.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

function writeLock(dir: string, deps: Record<string, string>): void {
  const packages: Record<string, object> = { "": { name: "proj", dependencies: deps } };
  for (const [name, version] of Object.entries(deps)) packages[`node_modules/${name}`] = { version };
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
}

function installPkg(dir: string, name: string, version: string): void {
  const pkgDir = path.join(dir, "node_modules", name);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name, version }));
}

const failedInstall = { source: "feature", type: "dep_install", packages: ["a"], status: "failed", durationMs: 1, error: "ENOTFOUND registry" } as const;

test("no lockfile is ok", () => {
  const out = checkRootInstall(tmpdir());
  assert.equal(out.level, "ok");
  assert.match(out.detail, /nothing pinned/);
});

test("installed pins are ok", () => {
  const dir = tmpdir();
  writeLock(dir, { a: "1.0.0" });
  installPkg(dir, "a", "1.0.0");
  assert.equal(checkRootInstall(dir).level, "ok");
});

test("a missing pin and a skewed pin warn with the fix", () => {
  const dir = tmpdir();
  writeLock(dir, { a: "1.0.0", b: "2.0.0" });
  installPkg(dir, "b", "1.0.0");
  const out = checkRootInstall(dir);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /a, b/);
  assert.match(out.detail, /run npm install in/);
});

test("a recent failed re-sync is named in the warning", () => {
  const dir = tmpdir();
  writeLock(dir, { a: "1.0.0" });
  logEvent(dir, failedInstall);
  const out = checkRootInstall(dir);
  assert.equal(out.level, "warn");
  assert.match(out.detail, /last re-sync failed .* ago: ENOTFOUND registry/);
});

test("a failed re-sync with no drift is ok", () => {
  const dir = tmpdir();
  writeLock(dir, { a: "1.0.0" });
  installPkg(dir, "a", "1.0.0");
  logEvent(dir, failedInstall);
  assert.equal(checkRootInstall(dir).level, "ok");
});
