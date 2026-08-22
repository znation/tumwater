import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../src/init.js";
import { readInitialPrompt } from "../src/readme.js";
import { defaultConfig } from "../src/config.js";
import { dequeuePrompt, inboxSize } from "../src/inbox.js";
import { makeRepo, sh, tmpdir } from "./util.js";

// The CLI runs main() on import and reports failures via process.exit, so it is
// tested as a child process: the built dist/src/cli.js with cwd set to a temp repo.
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(cwd: string, ...args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test("help and no command print usage", async () => {
  const dir = tmpdir();
  for (const args of [[], ["help"]]) {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage:/);
    assert.match(r.stdout, /tumwater init/);
    assert.match(r.stdout, /tumwater prompt/);
  }
});

test("version prints the package version", async () => {
  const pkg = JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const r = await cli(tmpdir(), "version");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test("unknown command fails with a hint", async () => {
  const r = await cli(tmpdir(), "frobnicate");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: frobnicate/);
});

test("status refuses repos that are not ready", async () => {
  // Not a git repo.
  let r = await cli(tmpdir(), "status");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a git repository/);

  // A git repo without tumwater.json.
  const bare = makeRepo();
  r = await cli(bare, "status");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not initialized/);

  // tumwater.json present but no commits yet.
  const uncommitted = tmpdir();
  sh(uncommitted, "git", "init", "-b", "main");
  fs.writeFileSync(path.join(uncommitted, "tumwater.json"), JSON.stringify(defaultConfig()));
  r = await cli(uncommitted, "status");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no commits yet/);
});

test("init creates the harness files and is idempotent", async () => {
  const repo = makeRepo();
  let r = await cli(repo, "init", "Build a todo CLI.");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /created README\.md/);
  for (const f of ["README.md", "PLANS.md", "BUGS.md", "tumwater.json"]) {
    assert.ok(fs.existsSync(path.join(repo, f)), `${f} exists`);
  }
  r = await cli(repo, "init", "Build a todo CLI.");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /already initialized; nothing to do/);
});

test("init --file reads the prompt from a file and rejects a missing path", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "prompt.md"), "Build a thing.\nWith care.\n");
  let r = await cli(repo, "init", "--file", "prompt.md");
  assert.equal(r.code, 0);
  assert.equal(readInitialPrompt(repo), "Build a thing.\nWith care.");

  const bare = makeRepo();
  r = await cli(bare, "init", "--file");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--file needs a path/);
});

test("prompt queues for the director and logs an event; empty text fails", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt test");

  let r = await cli(repo, "prompt");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /prompt text required/);

  r = await cli(repo, "prompt", "add dark mode");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /queued for the director loop/);
  assert.equal(inboxSize(repo), 1);
  assert.equal(dequeuePrompt(repo), "add dark mode");

  // The queueing is visible in `logs`.
  r = await cli(repo, "logs", "-n", "5");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /user prompt queued: add dark mode/);
});
