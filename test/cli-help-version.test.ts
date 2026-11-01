/** The CLI's `version` command and its `--version`/`-v` spellings, plus a broken install: a
 * copied dist/ with no package.json fails `version` with the reason, and the Node-floor gate
 * stands down or blocks by what package.json declares. The help command lives in
 * cli-help.test.ts, one command's topic in cli-help-topic.test.ts, and unknown and mistyped
 * commands in cli-help-unknown.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./helpers/json-read.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

test("a broken install's version command fails with the reason, and the floor gate stands down", async () => {
  // cli.ts reads the package.json beside the compiled CLI (version.ts's PACKAGE_JSON), so an
  // install whose root package.json is missing or malformed — a half-pruned global install,
  // a hand-copied dist/ without its root — is only reachable from a copied tree: copy
  // dist/src into a temp dir and run the copy, whose package.json lookup lands in the temp
  // root. The dispatcher's broken-install paths (the version command's failure and the
  // Node-floor gate's stand-down) have no other test: the real install always answers.
  const install = tmpdir();
  fs.cpSync(fileURLToPath(new URL("../src", import.meta.url)), path.join(install, "dist", "src"), { recursive: true });
  const run = (...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [path.join(install, "dist", "src", "cli.js"), ...args],
        { cwd: install, timeout: 20_000 },
        (err, stdout, stderr) => resolve({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr }),
      );
    });
  // No package.json at all: version reports the broken install instead of a raw stack trace…
  const missing = await run("version");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /tumwater: cannot read package\.json \(the running tumwater install looks broken\)/);
  // …and the Node-floor gate stands down (no engines spec to compare against), so help still
  // answers — the gate must not block every command on a value it cannot read. version.test.ts
  // covers the sibling shape, a package.json present but without a usable version field.
  const help = await run("help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  // A package.json declaring a Node floor above the running runtime blocks every command at
  // startup with the fix, before any command does work — `help` included, the one command an
  // operator reaches for when nothing else answers.
  fs.writeFileSync(path.join(install, "package.json"), '{"engines":{"node":">=999"}}\n');
  const belowFloor = await run("help");
  assert.equal(belowFloor.code, 1);
  assert.match(belowFloor.stderr, /tumwater needs Node >=999 \(found v\d+\.\d+\.\d+\) — upgrade Node, then run tumwater again/);
});

test("version prints the package version", async () => {
  const pkg = readJson(new URL("../../package.json", import.meta.url)) as { version: string };
  const r = await cli(tmpdir(), "version");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test("--version and -v answer like `version` — the flag spellings are commands themselves", async () => {
  // The dispatcher's version case carries three entry points (`version`, `--version`, `-v`);
  // the two flag spellings are common expectations across CLIs and can drift from the worded
  // one, so they are driven here through the same child-process harness that spawns the rest
  // of the dispatcher. No ready repo is needed: version works in an empty directory like the
  // worded command.
  const pkg = readJson(new URL("../../package.json", import.meta.url)) as { version: string };
  const dir = tmpdir();
  for (const flag of ["--version", "-v"]) {
    const r = await cli(dir, flag);
    assert.equal(r.code, 0, `${flag}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), pkg.version);
  }
});
