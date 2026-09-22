import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { strict as assert } from "node:assert";

test("a test process that used tmpdir() leaves no temp dir behind at exit", () => {
  const utilPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "util.js");
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { tmpdir, makeRepo } from ${JSON.stringify(pathToFileURL(utilPath).href)};
    const dir = tmpdir();
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "leftover.txt"), "x");
    console.log(JSON.stringify({ dir, repo }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(child.error, undefined, `child failed to run: ${child.error}`);
  assert.equal(child.status, 0, `child exited ${child.status}: ${child.stderr}`);

  const { dir, repo } = JSON.parse(child.stdout.trim()) as { dir: string; repo: string };
  // Both dirs are unique, nested under one per-run root directly under the OS temp dir.
  assert.notEqual(dir, repo);
  const runRoot = path.dirname(dir);
  assert.equal(path.dirname(repo), runRoot, "tmpdir() and makeRepo() share one per-run root");
  assert.ok(
    runRoot.startsWith(path.join(os.tmpdir(), "tumwater-test-run-")),
    `run root ${runRoot} sits under the OS temp dir`,
  );
  // The exit teardown removed the whole run root — before the fix neither dir was ever removed.
  assert.equal(fs.existsSync(dir), false, `tmpdir() result survived process exit: ${dir}`);
  assert.equal(fs.existsSync(repo), false, `makeRepo() result survived process exit: ${repo}`);
  assert.equal(fs.existsSync(runRoot), false, `per-run root survived process exit: ${runRoot}`);
});
