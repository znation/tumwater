import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { tmpdir } from "./fixtures/repo-fixtures.js";

test("a compiled fake-commands copied outside the checkout refuses to import instead of leaving every fake a dangling symlink", () => {
  // BUGS.md 2026-09-30: SCRIPT_SHIM resolves relative to the compiled file
  // (../../../test/fixtures/script-shim), which exists only when the compiled tests sit inside
  // the checkout. A tree compiled to an --outDir elsewhere (the coverage loop's /tmp build)
  // resolved it to a path that was not there, writeScript symlinked every fake to the missing
  // shim anyway, and PATH lookups fell through to the REAL binaries — 291 real `pi` agents
  // against a live backend. The module must fail on its first import with the rule, loudly.
  const compiled = fileURLToPath(new URL("./fakes/fake-commands.js", import.meta.url));
  // Three levels deep, like dist/test/fakes/ inside a checkout — so the ../../.. climb lands
  // outside.
  const relocatedDir = path.join(tmpdir("relocated-fakes-"), "dist", "test", "fakes");
  fs.mkdirSync(relocatedDir, { recursive: true });
  const relocated = path.join(relocatedDir, "fake-commands.js");
  fs.copyFileSync(compiled, relocated);

  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(relocated).href)});`],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(child.error, undefined, `child failed to run: ${child.error}`);
  assert.notEqual(child.status, 0, "the relocated module must refuse to import");
  assert.match(child.stderr, /test fixtures not found/);
  assert.match(child.stderr, /dangling symlink/);
  assert.match(child.stderr, /inside the checkout/);
});
