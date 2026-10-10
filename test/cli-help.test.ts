import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./helpers/json-read.js";
import { initProject } from "../src/init/init.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

// The CLI runs main() on import and reports failures via process.exit, so it is tested as a
// child process — the spawn helpers (CLI, cli, cliWithEnv, spawnCli, exitCode) live in
// cli-harness.ts, beside the run-to-completion capture they share.
//
// This file holds the dispatcher and its help/version surface: usage with no command or
// `help`, the `<command> --help` topic convention, the unknown-command and mistyped-topic
// suggestions, and `version`. Split out of cli.test.ts — which keeps the command bodies
// (status, init, run's branch validation) — so node --test runs the two halves in parallel
// processes, nearly every test here spawning the CLI. The other child-process CLI tests live
// in their command's topic file: cli-prompt-queue.test.ts (prompt queue), cli-preflight.test.ts
// (run's startup preflight), cli-arg-strictness.test.ts (argument strictness), cli-gui.test.ts
// (gui), cli-run-live.test.ts (run's lifecycle), doctor.test.ts, report.test.ts, and
// tui.test.ts.

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

test("--help and -h answer like `help` — the flag spellings are commands themselves", async () => {
  // The <command> --help interception deliberately skips a command that IS --help/-h: those
  // fall through to the help dispatcher, where a following token is read as a topic name.
  // Bare, they print the full listing; with a token, the token's topic — so `tumwater --help
  // status` and `tumwater help status` print the same stanza, and a mistyped token gets the
  // dispatcher's no-topic error instead of silently printing the full list.
  const dir = tmpdir();
  for (const flag of ["--help", "-h"]) {
    const bare = await cli(dir, flag);
    assert.equal(bare.code, 0);
    assert.match(bare.stdout, /Usage:/);
    assert.match(bare.stdout, /tumwater init/);

    const topic = await cli(dir, flag, "status");
    assert.equal(topic.code, 0);
    assert.match(topic.stdout, /tumwater status/);

    const mistyped = await cli(dir, flag, "statis");
    assert.equal(mistyped.code, 1);
    assert.match(mistyped.stderr, /no help topic: statis — did you mean `status`\?/);
  }
});

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
  assert.match(missing.stderr, /tumwater: cannot read package\.json \(the running harness's install looks broken\)/);
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

test("unknown command fails with a hint", async () => {
  const r = await cli(tmpdir(), "frobnicate");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: frobnicate/);
});

test("a mistyped command suggests the closest listed one", async () => {
  const r = await cli(tmpdir(), "statis");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: statis — did you mean `status`\?/);
});

test("a mistyped help topic suggests the closest command too", async () => {
  const r = await cli(tmpdir(), "help", "statu");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no help topic: statu — did you mean `status`\?/);
});

test("<command> --help prints that command's help topic", async () => {
  const dir = tmpdir();
  // Both spellings, and --help riding alongside other flags (help wins, like every CLI).
  // No ready repo is needed: the topic is answered before status's startup gate, so the
  // same invocation outside a git repo still prints usage instead of refusing.
  for (const args of [["status", "--help"], ["pause", "-h"], ["diff", "--role", "x", "--help"]]) {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`tumwater ${args[0]}`));
  }
  const bare = await cli(tmpdir(), "status", "--help");
  assert.equal(bare.code, 0);
  assert.doesNotMatch(bare.stderr, /not a git repository/);
});

test("help --help prints the help command's own topic", async () => {
  // The convention covers every command, help included: `help --help`/`help -h` must answer
  // with the help topic, not fall through to a topic lookup for the literal flag text
  // (exit 1, "no help topic: --help — did you mean `help`?").
  for (const args of [["help", "--help"], ["help", "-h"]]) {
    const r = await cli(tmpdir(), ...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, /tumwater help \[<command>\]/);
  }
});

test("help <command> prints that command's topic without a ready repo", async () => {
  // The dispatch itself (cli.ts's `help` case), not just the topic parser: README documents
  // `tumwater help <command>` as the way to read one command's usage, so the primary spelling
  // must answer like `--help` does — same topic text, exit 0, and no ready-repo gate (help is
  // how an operator diagnoses a repo that is not ready in the first place).
  const dir = tmpdir();
  for (const name of ["status", "report", "help"]) {
    const r = await cli(dir, "help", name);
    assert.equal(r.code, 0, `help ${name}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`tumwater ${name}`));
    assert.doesNotMatch(r.stderr, /not a git repository/);
  }
});

test("help takes at most one command name", async () => {
  // Two tokens are never a topic: the arity failure must come from the help dispatcher
  // itself, before any topic lookup could misread the second token as a flag of the first.
  const r = await cli(tmpdir(), "help", "status", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /help takes at most one command name/);
});

test("--help does not rescue an unknown command", async () => {
  const r = await cli(tmpdir(), "frobnicate", "--help");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: frobnicate/);
});

test("a free-form text command carrying a --help token files the text, not the help topic", async () => {
  // The <command> --help interception answers a flag-shaped help request, but the free-form
  // position commands (init, prompt, bug, plan) read their positionals as operator text — a
  // text containing a standalone --help/-h token (`tumwater bug the TUI mishandles --help
  // output`) used to be swallowed whole: the topic printed, exit 0, the text gone with no
  // trace. When such a command carries any non-flag token (real text), the interception must
  // stand down and let the command read the text; with only flags present (`tumwater bug
  // --help`, `prompt --role qa --help`) the topic still answers.
  const dir = tmpdir();
  await initProject(dir, "test fleet");
  const filed = await cli(dir, "bug", "the", "TUI", "mishandles", "--help", "output");
  assert.equal(filed.code, 0, `bug --help text: ${filed.stderr}`);
  assert.doesNotMatch(filed.stdout, /Usage:/);
  assert.match(fs.readFileSync(path.join(dir, "BUGS.md"), "utf8"), /the TUI mishandles --help output/);

  const prompted = await cli(dir, "prompt", "fix", "the", "--help", "flag");
  // prompt (and init) read flag values, so a help token beside text is ambiguous there —
  // the parser's named error answers instead of either silently queuing or printing help.
  assert.equal(prompted.code, 1);
  assert.match(prompted.stderr, /unknown argument: --help/);
  assert.doesNotMatch(prompted.stderr, /Usage:/);

  // Flag-only invocations keep the topic answer.
  for (const args of [["bug", "--help"], ["prompt", "--role", "qa", "--help"], ["init", "--help"]]) {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`tumwater ${args[0]}`));
  }
});
