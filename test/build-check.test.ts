import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { detectBuildCheck, runBuildCheck } from "../src/build-check.js";
import { tmpdir } from "./util.js";

// Unit coverage for the deterministic build pre-check (src/build-check.ts): detection by
// walk-up to the installed root and execution/outcome classification. The gate's integration
// with this check (a healthy build reaching the reviewer) is covered in review.test.ts, where
// it belongs — that test drives reviewAheadOfMain end-to-end.

const ROLE = "improve";

/** Scratch project: `root` has package.json + a fake toolchain in node_modules/.bin; `wt`
 * sits INSIDE it at the real worktree location (`.tumwater/worktrees/<role>`) with its own
 * tracked package.json and no install — so root is an ancestor, as detectBuildCheck requires. */
function buildCheckFixture(): { root: string; wt: string } {
  const base = tmpdir("buildcheck-");
  const root = path.join(base, "project");
  const binDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --ok" } }),
  );
  const tool = path.join(binDir, "buildcheck-tool");
  fs.writeFileSync(tool, "#!/bin/sh\necho buildcheck-ok\n");
  fs.chmodSync(tool, 0o755);

  const wt = path.join(root, ".tumwater", "worktrees", ROLE);
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --ok" } }),
  );
  return { root, wt };
}

test("runBuildCheck resolves the toolchain from the installed root when the worktree has no node_modules", async () => {
  const { root, wt } = buildCheckFixture();
  // Pre-fix this was `sh: buildcheck-tool: command not found` (exit 127) — a deterministic
  // rejection of every code change in any JS project (BUGS.md).
  const outcome = await runBuildCheck(wt, { rootDir: root, script: "build" }, 30_000);
  assert.equal(outcome.status, "passed");
});

test("runBuildCheck still classifies a genuinely failing build as failed with the output tail", async () => {
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --fail" } }),
  );
  const tool = path.join(root, "node_modules", ".bin", "buildcheck-tool");
  fs.writeFileSync(
    tool,
    "#!/bin/sh\n[ \"$1\" = \"--ok\" ] && echo ok || { echo type error TS9999: boom; exit 1; }\n",
  );
  const outcome = await runBuildCheck(wt, { rootDir: root, script: "build" }, 30_000);
  assert.equal(outcome.status, "failed");
  assert.ok((outcome.outputTail ?? []).some((l) => l.includes("TS9999")));
});

test("runBuildCheck skips (not fails closed) when the script times out", async () => {
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "sleep 5" } }),
  );
  const outcome = await runBuildCheck(wt, { rootDir: root, script: "build" }, 400);
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.skipReason, "timeout");
});

test("detectBuildCheck walks up from a worktree without node_modules to the installed project root", () => {
  const { root, wt } = buildCheckFixture();
  assert.deepEqual(detectBuildCheck(wt), { rootDir: root, script: "build" });
});
