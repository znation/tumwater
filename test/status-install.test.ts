import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { collectRootInstallDrift, resetRootInstallCache } from "../src/status/status-install.js";
import { snapshot } from "../src/status/status-data.js";
import { initProject } from "../src/init/init.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// status-install.ts: the throttled root-install drift the dashboards' `install` alert reads.

function fixture(installed: string): string {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { devDependencies: { widget: "^1.0.0" } }, "node_modules/widget": { version: "1.0.0" } },
    }),
  );
  setInstalled(dir, installed);
  return dir;
}

function setInstalled(dir: string, version: string): void {
  const mod = path.join(dir, "node_modules", "widget");
  fs.mkdirSync(mod, { recursive: true });
  fs.writeFileSync(path.join(mod, "package.json"), JSON.stringify({ name: "widget", version }));
}

test("collectRootInstallDrift names drifted packages and reuses the answer for a minute", () => {
  resetRootInstallCache();
  const dir = fixture("0.9.0");
  const now = 1_000_000;
  assert.deepEqual(collectRootInstallDrift(dir, now), ["widget"]);
  setInstalled(dir, "1.0.0");
  assert.deepEqual(collectRootInstallDrift(dir, now), ["widget"], "throttled");
  assert.deepEqual(collectRootInstallDrift(dir, now + 60_001), []);
  resetRootInstallCache();
});

test("collectRootInstallDrift is empty without a lockfile", () => {
  resetRootInstallCache();
  assert.deepEqual(collectRootInstallDrift(tmpdir(), 1), []);
  resetRootInstallCache();
});

test("snapshot carries rootInstallDrift only while the install drifts", async () => {
  resetRootInstallCache();
  const dir = fixture("0.9.0");
  await initProject(dir, "install drift");
  assert.deepEqual(snapshot(dir).rootInstallDrift, ["widget"]);
  setInstalled(dir, "1.0.0");
  resetRootInstallCache();
  assert.equal(snapshot(dir).rootInstallDrift, undefined);
  resetRootInstallCache();
});
