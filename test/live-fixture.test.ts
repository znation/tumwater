/** scripts/live-fixture.mjs — the shared seeder behind the hand-run bench-live and diff-check
 * dashboard scripts. It had no test of its own (grep for its exports found none), yet both
 * scripts depend on it for the same two things that drift silently: the compiled role set and
 * the on-disk fleet shape. This file drives its three exports — the dist guard's fail-fast, the
 * role catalog it delegates to the compiled harness, and the seeder both scripts consume.
 *
 * requireDistBuild's failure path calls process.exit(1), so both of its outcomes are exercised
 * in a child (`node --input-type=module -e`) rather than in-process, where a regression would
 * take the whole test runner down with it. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { allRoleIds } from "../src/roles/roles.js";

const FIXTURE = fileURLToPath(new URL("../../scripts/live-fixture.mjs", import.meta.url));

interface LiveFixture {
  requireDistBuild(relModule: string, purpose: string): void;
  distRoleIds(): Promise<string[]>;
  seedLiveFleet(root: string, roles: readonly string[]): void;
}

/** Imported lazily by URL (the module lives outside dist/): a computed specifier keeps the
 * .mjs import out of tsc's module resolution, matching how the hand-run scripts load it. */
async function loadFixture(): Promise<LiveFixture> {
  return (await import(pathToFileURL(FIXTURE).href)) as LiveFixture;
}

/** Run requireDistBuild in a child and hand back its exit status and streams. */
function runGuard(relModule: string): { status: number | null; stderr: string; stdout: string } {
  const code =
    `const m = await import(${JSON.stringify(pathToFileURL(FIXTURE).href)});` +
    `m.requireDistBuild(${JSON.stringify(relModule)}, "the fixture test");`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  return { status: res.status, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
}

test("requireDistBuild passes silently when the named compiled module is present", () => {
  const res = runGuard("../dist/src/roles/roles.js");
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
});

test("requireDistBuild names the missing module and the fix, then exits nonzero", () => {
  const res = runGuard("../dist/src/no-such-compiled-module.js");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /run `npm run build` first/);
  assert.match(res.stderr, /dist\/src\/no-such-compiled-module\.js is missing/);
});

test("distRoleIds returns the compiled catalog's role ids", async () => {
  const { distRoleIds } = await loadFixture();
  assert.deepEqual(await distRoleIds(), allRoleIds());
});

test("seedLiveFleet writes the orchestrator marker, one running state per role, and a pi log tail", async () => {
  const { seedLiveFleet } = await loadFixture();
  const root = tmpdir("live-fixture-");
  seedLiveFleet(root, ["alpha", "beta"]);

  const state = path.join(root, ".tumwater", "state");
  const marker = JSON.parse(fs.readFileSync(path.join(state, "orchestrator.json"), "utf8"));
  assert.equal(marker.pid, process.pid);

  for (const role of ["alpha", "beta"]) {
    const st = JSON.parse(fs.readFileSync(path.join(state, `${role}.json`), "utf8"));
    assert.equal(st.role, role);
    assert.equal(st.ticks, 3);
    assert.equal(st.running, true);
    assert.equal(st.phase, "pi");
    assert.ok(st.lastTickStartedAt > st.lastTickEndedAt, "a still-running tick started after the last one ended");

    const lines = fs
      .readFileSync(path.join(root, ".tumwater", "log", `${role}.pi.jsonl`), "utf8")
      .trimEnd()
      .split("\n");
    assert.equal(lines.length, 4);
    assert.equal(JSON.parse(lines[0] ?? "").type, "session");
    assert.equal(JSON.parse(lines[3] ?? "").message.usage.output, 280);
  }
});
