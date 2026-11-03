/** mainTipGateVerdict itself (Hourly full check part 1a/4): the gate command run fresh at
 * main's tip in the `_gate-main` mirror, for a twice-failed gate check that names no test. Green
 * when the gate command passes at the tip, red with the named tests when it fails, unavailable
 * when the check is skipped. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mainTipGateVerdict } from "../src/baseline/main-red.js";
import { defaultConfig } from "../src/config/config.js";
import { projManifest } from "./fakes/fake-commands.js";
import { makeRepo, sh } from "./fixtures/repo-fixtures.js";

async function mainRepo(build: string | null): Promise<string> {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ build }));
  sh(root, "git", "add", "package.json");
  sh(root, "git", "commit", "-m", "declare the check");
  return root;
}

test("mainTipGateVerdict is green when the gate command passes at main's tip", async () => {
  const root = await mainRepo("exit 0");
  const v = await mainTipGateVerdict(root, "feature", "main", defaultConfig());
  assert.equal(v.status, "green");
});

test("mainTipGateVerdict is red with the failing tests when the gate command fails at main's tip", async () => {
  const root = await mainRepo("echo '✖ X (1ms)'; exit 1");
  const v = await mainTipGateVerdict(root, "feature", "main", defaultConfig());
  assert.equal(v.status, "red");
  assert.deepEqual(v.failingTests, ["X"]);
});

test("mainTipGateVerdict is unavailable when the check is skipped (no declared check)", async () => {
  const root = await mainRepo(null);
  const v = await mainTipGateVerdict(root, "feature", "main", defaultConfig());
  assert.equal(v.status, "unavailable");
});
