import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  parseCountFlag,
  parsePortFlag,
  parseRoleFlag,
  rejectUnknownArgs,
  parseInitArgs,
  parsePromptArgs,
} from "../src/cli-args.js";
import { allRoleIds } from "../src/roles.js";
import { tmpdir } from "./util.js";

// src/cli-args.ts is the only module with no direct unit tests: until now every branch was
// reached (slowly) through a spawned CLI child in test/cli.test.ts. These tests drive the
// parsers in-process, which also covers branches the e2e path never exercises — duplicate
// flags ("first occurrence wins"), a trailing valued flag claiming only itself, whitespace-
// only prompt text, and the bare `--` token.

/** Sentinel thrown by the process.exit stub so fail() paths are catchable in-process. */
class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

type Outcome<T> = { exited: true; code: number; stderr: string } | { exited: false; value: T };

/** Run fn with process.exit and process.stderr intercepted. fail() reports by writing to
 * stderr then exiting 1; this captures both instead of killing the test process, so every
 * failure branch is assertable in-process. Both globals are always restored. */
function attempt<T>(fn: () => T): Outcome<T> {
  const realExit = process.exit;
  const realWrite = (process.stderr as unknown as { write: (s: string) => boolean }).write;
  let stderr = "";
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as typeof process.exit;
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    stderr += s;
    return true;
  };
  try {
    return { exited: false, value: fn() };
  } catch (err) {
    if (err instanceof ExitError) return { exited: true, code: err.code, stderr };
    throw err;
  } finally {
    process.exit = realExit;
    (process.stderr as unknown as { write: (s: string) => boolean }).write = realWrite;
  }
}

/** Assert fn fails via fail(): exit code 1 and the captured stderr message. */
function expectFail(fn: () => unknown): { code: number; stderr: string } {
  const out = attempt(fn);
  if (!out.exited) assert.fail(`expected process.exit, but the call returned ${JSON.stringify(out.value)}`);
  return { code: out.code, stderr: out.stderr };
}

/** Assert fn succeeds (no fail): its return value. */
function expectOk<T>(fn: () => T): T {
  const out = attempt(fn);
  if (out.exited) assert.fail(`expected success, but process.exit(${out.code}) with:\n${out.stderr}`);
  return out.value;
}

// --- parseCountFlag ---

test("parseCountFlag accepts positive integers and rejects everything else", () => {
  assert.equal(expectOk(() => parseCountFlag("-n", "3")), 3);
  assert.equal(expectOk(() => parseCountFlag("-n", "50")), 50);

  // A missing value used to silently fall back to the default of 50.
  const missing = expectFail(() => parseCountFlag("-n", undefined));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /tumwater: -n needs a value/);

  // Unvalidated, NaN/0/negative limits make readEvents' slice(-limit) dump the whole log
  // (or drop leading lines). Each bad spelling is named in the error.
  for (const raw of ["abc", "0", "-5", "2.5", ""]) {
    const r = expectFail(() => parseCountFlag("-n", raw));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /-n needs a positive integer \(got .+\)/);
  }
});

// --- parsePortFlag ---

test("parsePortFlag accepts the full valid range and rejects out-of-range values", () => {
  // Boundaries: port 0 would make Node pick an ephemeral port while the CLI prints :0.
  assert.equal(expectOk(() => parsePortFlag("1")), 1);
  assert.equal(expectOk(() => parsePortFlag("7180")), 7180);
  assert.equal(expectOk(() => parsePortFlag("65535")), 65535);

  const missing = expectFail(() => parsePortFlag(undefined));
  assert.match(missing.stderr, /--port needs a value/);

  for (const raw of ["0", "-1", "65536", "abc"]) {
    const r = expectFail(() => parsePortFlag(raw));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--port must be an integer between 1 and 65535 \(got .+\)/);
  }
});

// --- parseRoleFlag ---

test("parseRoleFlag returns null when absent (even among other flags) and validates the id", () => {
  assert.equal(expectOk(() => parseRoleFlag([])), null);
  assert.equal(expectOk(() => parseRoleFlag(["-f"])), null);
  assert.equal(expectOk(() => parseRoleFlag(["-n", "3"])), null);

  const first = allRoleIds()[0];
  assert.ok(first, "role catalog is non-empty");
  assert.equal(expectOk(() => parseRoleFlag(["--role", first])), first);

  // A trailing --role with no value: the command's own parser would see undefined too, but
  // this helper names the fix instead.
  const bare = expectFail(() => parseRoleFlag(["--role"]));
  assert.match(bare.stderr, /--role needs a role id/);

  // An unknown id lists every valid one — the actionable half of the error.
  const bogus = expectFail(() => parseRoleFlag(["--role", "bogus"]));
  assert.equal(bogus.code, 1);
  assert.match(bogus.stderr, /unknown role: bogus \(valid ids: .+\)/);
  for (const id of allRoleIds()) assert.ok(bogus.stderr.includes(id), `valid list names ${id}`);
});

// --- rejectUnknownArgs ---

/** The flag vocabulary each command passes in cli.ts — kept in sync with main()'s cases. */
const LOGS_SPECS = [
  { names: ["-f", "--follow"] },
  { names: ["-n"], value: true, valueName: "<count>" },
  { names: ["--role"], value: true, valueName: "<id>" },
];
const GUI_SPECS = [
  { names: ["--port"], value: true, valueName: "<n>" },
  { names: ["--all-interfaces"] },
];

test("rejectUnknownArgs accepts empty args and every known flag spelling", () => {
  expectOk(() => rejectUnknownArgs("logs", [], LOGS_SPECS));
  expectOk(() => rejectUnknownArgs("run", [], []));
  // Every accepted spelling, mixed in one line.
  expectOk(() => rejectUnknownArgs("logs", ["--follow", "-n", "3", "--role", "feature"], LOGS_SPECS));
  expectOk(() => rejectUnknownArgs("gui", ["--port", "8080", "--all-interfaces"], GUI_SPECS));
});

test("rejectUnknownArgs rejects unknown tokens with the command's valid flags listed", () => {
  // A misspelled --role used to be ignored: reset-counters would zero EVERY loop instead of
  // the one named. Now it fails and names what was accepted.
  const r = expectFail(() => rejectUnknownArgs("reset-counters", ["--rol", "feature"], [{ names: ["--role"], value: true, valueName: "<id>" }]));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --rol/);
  assert.match(r.stderr, /valid flags for tumwater reset-counters: --role <id>/);

  // Commands with no flags reject any argument at all — a different message.
  const none = expectFail(() => rejectUnknownArgs("run", ["--verbose"], []));
  assert.match(none.stderr, /tumwater run takes no arguments/);

  // Stray non-flag tokens are rejected too, even after valid ones.
  const stray = expectFail(() => rejectUnknownArgs("reset-counters", ["--role", "feature", "extra"], [{ names: ["--role"], value: true, valueName: "<id>" }]));
  assert.match(stray.stderr, /unknown argument: extra/);

  // The valid-flags list joins every spelling with "/" and appends the value name.
  const logs = expectFail(() => rejectUnknownArgs("logs", ["--rol"], LOGS_SPECS));
  assert.match(logs.stderr, /-f\/--follow, -n <count>, --role <id>/);
});

test("rejectUnknownArgs: valued flags claim their value token; duplicates and trailing flags pass through", () => {
  // A valued flag claims the following token even when it looks like a known flag — so this
  // is NOT an unknown-argument error (the command's own parser reports "unknown role: -f").
  expectOk(() => rejectUnknownArgs("logs", ["--role", "-f"], LOGS_SPECS));

  // A trailing valued flag with no value claims only itself, not a phantom token — the
  // command's own parser reports the missing value first (parseCountFlag below).
  expectOk(() => rejectUnknownArgs("logs", ["-n"], LOGS_SPECS));
  const then = expectFail(() => parseCountFlag("-n", undefined));
  assert.match(then.stderr, /-n needs a value/);

  // Duplicates keep their existing behavior: the first occurrence wins, so a repeated known
  // flag is not an unknown argument. (cmdLogs' indexOf takes the first -n.)
  expectOk(() => rejectUnknownArgs("logs", ["-f", "-f"], LOGS_SPECS));
  expectOk(() => rejectUnknownArgs("logs", ["-n", "3", "-n", "5"], LOGS_SPECS));
});

// --- parseInitArgs ---

test("parseInitArgs joins positionals (single-dash tokens are content, not flags)", () => {
  assert.equal(expectOk(() => parseInitArgs(["Build", "a", "todo CLI."])), "Build a todo CLI.");
  // Bullets and other single-dash tokens stay prompt content.
  assert.equal(expectOk(() => parseInitArgs(["- Build A", "- Build B"])), "- Build A - Build B");
});

test("parseInitArgs --file reads the exact file contents", () => {
  const dir = tmpdir();
  const file = path.join(dir, "prompt.md");
  fs.writeFileSync(file, "Build a thing.\nWith care.\n");
  assert.equal(expectOk(() => parseInitArgs(["--file", file])), "Build a thing.\nWith care.\n");
});

test("parseInitArgs rejects unknown double-dash tokens — including the bare `--`", () => {
  // A misspelled --file used to be baked into the initial prompt — injected into every tick
  // of every loop until someone edits README.md. Now it fails like any other unknown flag.
  const r = expectFail(() => parseInitArgs(["--fil", "prompt.md"]));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --fil/);
  assert.match(r.stderr, /valid flags for tumwater init: --file <path>/);

  // `--` is a common user habit (end-of-options marker) and must not slip through as content.
  const dd = expectFail(() => parseInitArgs(["Build", "--", "a thing"]));
  assert.match(dd.stderr, /unknown argument: --/);
});

test("parseInitArgs --file validation: missing path, duplicates, stray positionals, unreadable file", () => {
  const dir = tmpdir();
  const a = path.join(dir, "a.md");
  fs.writeFileSync(a, "From a.");

  // Trailing --file with no path.
  assert.match(expectFail(() => parseInitArgs(["--file"])).stderr, /--file needs a path/);

  // A doubled --file used to silently use the first file.
  const dup = expectFail(() => parseInitArgs(["--file", a, "--file", a]));
  assert.match(dup.stderr, /--file may only be given once/);

  // Stray prompt text alongside --file used to be silently ignored.
  const stray = expectFail(() => parseInitArgs(["--file", a, "extra words"]));
  assert.match(stray.stderr, /unexpected argument "extra words"/);

  // An unreadable path names the file's role instead of a bare ENOENT — quoting exactly
  // the path as given (absolute or relative).
  const missingFile = path.join(dir, "missing.md");
  const missing = expectFail(() => parseInitArgs(["--file", missingFile]));
  assert.match(missing.stderr, /cannot read prompt file/);
  assert.ok(missing.stderr.includes(JSON.stringify(missingFile)), `names the given path:\n${missing.stderr}`);
});

// --- parsePromptArgs ---

test("parsePromptArgs enqueues free-form text (trimmed; single-dash tokens are content)", () => {
  const r = expectOk(() => parsePromptArgs(["add", "dark mode"]));
  assert.deepEqual(r, { mode: "enqueue", text: "add dark mode" });

  // Surrounding whitespace is trimmed so a queued prompt never starts/ends with padding.
  const padded = expectOk(() => parsePromptArgs(["  hello  "]));
  assert.deepEqual(padded, { mode: "enqueue", text: "hello" });

  // Only double-dash tokens are flags; a leading single dash is free-form content.
  const dash = expectOk(() => parsePromptArgs(["-x"]));
  assert.deepEqual(dash, { mode: "enqueue", text: "-x" });
});

test("parsePromptArgs rejects empty and whitespace-only text", () => {
  // `tumwater prompt` with nothing to queue used to enqueue an empty string.
  for (const args of [[], ["   "]]) {
    const r = expectFail(() => parsePromptArgs(args));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /prompt text required/);
  }
});

test("parsePromptArgs rejects unknown double-dash flags instead of baking them into content", () => {
  // Before this parser existed, `tumwater prompt --foo text` enqueued "--foo text" as the
  // prompt — the same class of hole parseInitArgs closed. The flag must fail and name what
  // was accepted.
  const r = expectFail(() => parsePromptArgs(["--foo", "text"]));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --foo/);
  assert.match(r.stderr, /valid flags for tumwater prompt: --list, --cancel <n>/);
});

test("parsePromptArgs --list: exact mode, no text allowed", () => {
  assert.deepEqual(expectOk(() => parsePromptArgs(["--list"])), { mode: "list" });

  // A stray positional — before or after the flag — would otherwise be silently ignored.
  for (const args of [["--list", "extra"], ["extra", "--list"]]) {
    const r = expectFail(() => parsePromptArgs(args));
    assert.match(r.stderr, /unexpected argument "extra" — with --list there is no prompt text/);
  }

  // A second --list is always an error (the modes are exclusive; first-wins does not apply).
  const dup = expectFail(() => parsePromptArgs(["--list", "--list"]));
  assert.match(dup.stderr, /--list may only be given once/);
});

test("parsePromptArgs --cancel: position validation and exclusivity", () => {
  assert.deepEqual(expectOk(() => parsePromptArgs(["--cancel", "2"])), { mode: "cancel", position: 2 });

  // A missing value is its own error (distinct from a bad number).
  const bare = expectFail(() => parsePromptArgs(["--cancel"]));
  assert.match(bare.stderr, /--cancel needs a position number/);

  // Non-numeric or non-positive values are rejected by the parser before any file is touched.
  for (const bad of ["0", "abc", "1.5"]) {
    const r = expectFail(() => parsePromptArgs(["--cancel", bad]));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--cancel needs a positive integer \(got .+\)/);
  }

  // The position is the only token --cancel may carry.
  const stray = expectFail(() => parsePromptArgs(["--cancel", "1", "extra"]));
  assert.match(stray.stderr, /unexpected argument "extra" — with --cancel there is no prompt text/);

  const dup = expectFail(() => parsePromptArgs(["--cancel", "1", "--cancel", "2"]));
  assert.match(dup.stderr, /--cancel may only be given once/);

  // The two modes are mutually exclusive.
  const both = expectFail(() => parsePromptArgs(["--list", "--cancel", "1"]));
  assert.match(both.stderr, /--list and --cancel are mutually exclusive/);
});
