import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  durationLabel,
  flagValue,
  parseBranchFlag,
  parseCountFlag,
  parseDurationFlag,
  parsePortFlag,
  parseRoleFlag,
  rejectUnknownArgs,
  RUN_FLAG_SPECS,
  parseInitArgs,
  parsePromptArgs,
} from "../src/cli-args.js";
import { allRoleIds } from "../src/roles.js";
import { tmpdir } from "./repo-fixtures.js";
import { attempt } from "./exit-capture.js";

// src/cli-args.ts is the only module with no direct unit tests: until now every branch was
// reached (slowly) through a spawned CLI child in test/cli.test.ts. These tests drive the
// parsers in-process, which also covers branches the e2e path never exercises — duplicate
// flags (rejected with "may only be given once"), a trailing valued flag claiming only itself, whitespace-
// only prompt text, and the bare `--` token.

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
  for (const raw of ["abc", "0", "-5", "2.5", "", "0x10", "1e3"]) {
    const r = expectFail(() => parseCountFlag("-n", raw));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /-n needs a positive integer \(got .+\)/);
  }
});

// --- flagValue ---

/** The tri-state the valued-flag sites rely on: null means the flag is absent (the caller
 * applies its default), undefined means the flag is present but last (the parse helpers
 * fail with their `needs a value` messages), and a string — including the empty string —
 * is the value token the parse helpers validate. */
test("flagValue distinguishes absent, trailing, and present flags", () => {
  assert.equal(flagValue(["run", "--role", "feature"], "--role"), "feature");
  assert.equal(flagValue(["run", "--role"], "--role"), undefined);
  assert.equal(flagValue(["run", "--token", ""], "--token"), "");
  assert.equal(flagValue(["run", "--once"], "--role"), null);
  assert.equal(flagValue([], "--role"), null);
  // Only the first occurrence wins, matching the indexOf the call sites replaced.
  assert.equal(flagValue(["--role", "a", "--role", "b"], "--role"), "a");
});

// --- parsePortFlag ---

test("parsePortFlag accepts the full valid range and rejects out-of-range values", () => {
  // Boundaries: port 0 would make Node pick an ephemeral port while the CLI prints :0.
  assert.equal(expectOk(() => parsePortFlag("1")), 1);
  assert.equal(expectOk(() => parsePortFlag("7180")), 7180);
  assert.equal(expectOk(() => parsePortFlag("65535")), 65535);

  const missing = expectFail(() => parsePortFlag(undefined));
  assert.match(missing.stderr, /--port needs a value/);

  for (const raw of ["0", "-1", "65536", "abc", "0x1F90"]) {
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

// User-defined loops are valid --role targets once the config lists them (plans/
// user-defined-loops.md): callers pass knownRoleIds(config) as the accepted set, and an
// unknown id fails naming the customs too.

test("parseRoleFlag accepts user-defined loop names from a supplied id list", () => {
  const ids = [...allRoleIds(), "docs-sync"];
  assert.equal(expectOk(() => parseRoleFlag(["--role", "docs-sync"], ids)), "docs-sync");

  // Built-ins validate against the same supplied list.
  const first = allRoleIds()[0];
  assert.ok(first, "role catalog is non-empty");
  assert.equal(expectOk(() => parseRoleFlag(["--role", first], ids)), first);

  const bogus = expectFail(() => parseRoleFlag(["--role", "bogus"], ids));
  assert.match(bogus.stderr, /unknown role: bogus \(valid ids: .+\)/);
  assert.ok(bogus.stderr.includes("docs-sync"), "the valid list names the custom loop");

  // Without a supplied list the catalog alone is authoritative — a custom name is unknown.
  const strict = expectFail(() => parseRoleFlag(["--role", "docs-sync"]));
  assert.match(strict.stderr, /unknown role: docs-sync/);
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

test("run's flag vocabulary accepts --branch, --once, and --role and rejects everything else", () => {
  // The specs cmdRun itself passes: all spellings, combined and alone.
  expectOk(() => rejectUnknownArgs("run", ["--branch", "trunk", "--once"], RUN_FLAG_SPECS));
  expectOk(() => rejectUnknownArgs("run", ["--once"], RUN_FLAG_SPECS));
  expectOk(() => rejectUnknownArgs("run", ["--once", "--role", "feature"], RUN_FLAG_SPECS));
  // A typo'd --once must fail with the standard wording, not silently run a daemon round.
  const r = expectFail(() => rejectUnknownArgs("run", ["--onc"], RUN_FLAG_SPECS));
  assert.match(r.stderr, /unknown argument: --onc/);
  assert.match(r.stderr, /valid flags for tumwater run: --branch <name>, --once, --role <id>/);
  // --once takes no value: a following token is a stray, not its argument.
  const valued = expectFail(() => rejectUnknownArgs("run", ["--once", "yes"], RUN_FLAG_SPECS));
  assert.match(valued.stderr, /unknown argument: yes/);
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

  // wake takes the same single --role flag; a misspelling fails with the accepted flag named.
  const wake = expectFail(() => rejectUnknownArgs("wake", ["--rol", "feature"], [{ names: ["--role"], value: true, valueName: "<id>" }]));
  assert.match(wake.stderr, /unknown argument: --rol/);
  assert.match(wake.stderr, /valid flags for tumwater wake: --role <id>/);

  // The valid-flags list joins every spelling with "/" and appends the value name.
  const logs = expectFail(() => rejectUnknownArgs("logs", ["--rol"], LOGS_SPECS));
  assert.match(logs.stderr, /-f\/--follow, -n <count>, --role <id>/);
});

test("rejectUnknownArgs: valued flags claim their value token; duplicates fail, trailing flags pass through", () => {
  // A valued flag claims the following token even when it looks like a known flag — so this
  // is NOT an unknown-argument error (the command's own parser reports "unknown role: -f").
  expectOk(() => rejectUnknownArgs("logs", ["--role", "-f"], LOGS_SPECS));

  // A trailing valued flag with no value claims only itself, not a phantom token — the
  // command's own parser reports the missing value first (parseCountFlag below).
  expectOk(() => rejectUnknownArgs("logs", ["-n"], LOGS_SPECS));
  const then = expectFail(() => parseCountFlag("-n", undefined));
  assert.match(then.stderr, /-n needs a value/);

  // A repeated flag fails instead of silently keeping the first occurrence — the same
  // "may only be given once" rule parseInitArgs and parsePromptArgs apply, keyed by spec
  // so -f and --follow count as one flag. (The command parsers read flags with indexOf,
  // so the first occurrence used to win and the operator's later value never took effect.)
  const dup = expectFail(() => rejectUnknownArgs("logs", ["-n", "3", "-n", "5"], LOGS_SPECS));
  assert.match(dup.stderr, /-n may only be given once/);
  const alias = expectFail(() => rejectUnknownArgs("logs", ["-f", "--follow"], LOGS_SPECS));
  assert.match(alias.stderr, /-f may only be given once/);
  const guiDup = expectFail(() => rejectUnknownArgs("gui", ["--port", "8000", "--port", "9000"], GUI_SPECS));
  assert.match(guiDup.stderr, /--port may only be given once/);
  // A flag-shaped VALUE is not a repeat: the first --role claims "-f" as its value token,
  // so the --follow after it is this line's first --follow occurrence.
  expectOk(() => rejectUnknownArgs("logs", ["--role", "-f", "--follow"], LOGS_SPECS));
});

// --- parseInitArgs ---

test("parseInitArgs joins positionals (single-dash tokens are content, not flags)", () => {
  assert.deepEqual(expectOk(() => parseInitArgs(["Build", "a", "todo CLI."])), {
    prompt: "Build a todo CLI.",
    branch: null,
    adopt: false,
    dryRun: false,
  });
  // Bullets and other single-dash tokens stay prompt content.
  assert.deepEqual(expectOk(() => parseInitArgs(["- Build A", "- Build B"])), {
    prompt: "- Build A - Build B",
    branch: null,
    adopt: false,
    dryRun: false,
  });
});

test("parseInitArgs --file reads the exact file contents", () => {
  const dir = tmpdir();
  const file = path.join(dir, "prompt.md");
  fs.writeFileSync(file, "Build a thing.\nWith care.\n");
  assert.deepEqual(expectOk(() => parseInitArgs(["--file", file])), {
    prompt: "Build a thing.\nWith care.\n",
    branch: null,
    adopt: false,
    dryRun: false,
  });
});

test("parseInitArgs rejects unknown double-dash tokens — including the bare `--`", () => {
  // A misspelled --file used to be baked into the initial prompt — injected into every tick
  // of every loop until someone edits README.md. Now it fails like any other unknown flag.
  const r = expectFail(() => parseInitArgs(["--fil", "prompt.md"]));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --fil/);
  assert.match(r.stderr, /valid flags for tumwater init: --file <path>, --branch <name>/);

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

  // An empty file reads as an empty prompt, which the bare-init path silently treats as
  // "re-seed from README.md" — the operator's --file argument ignored. Name the file like
  // every other bad --file shape (a whitespace-only file is the same failure).
  const emptyFile = path.join(dir, "empty.md");
  fs.writeFileSync(emptyFile, "");
  const empty = expectFail(() => parseInitArgs(["--file", emptyFile]));
  assert.match(empty.stderr, /is empty/);
  assert.ok(empty.stderr.includes(JSON.stringify(emptyFile)), `names the given path:\n${empty.stderr}`);

  const blankFile = path.join(dir, "blank.md");
  fs.writeFileSync(blankFile, "   \n\n  ");
  assert.match(expectFail(() => parseInitArgs(["--file", blankFile])).stderr, /is empty/);
});

test("parseBranchFlag: absent returns null, a value passes, a missing value fails", () => {
  assert.equal(expectOk(() => parseBranchFlag([])), null);
  assert.equal(expectOk(() => parseBranchFlag(["run"])), null);
  assert.equal(expectOk(() => parseBranchFlag(["--branch", "release/2.0"])), "release/2.0");

  const noValue = expectFail(() => parseBranchFlag(["--branch"]));
  assert.match(noValue.stderr, /--branch needs a branch name/);

  // A `-`-leading token is another flag, not a branch name — the same rule a missing value
  // follows: fall back to the checked-out branch is the one thing a typo must never do.
  const flagAsValue = expectFail(() => parseBranchFlag(["--branch", "--json"]));
  assert.match(flagAsValue.stderr, /--branch needs a branch name/);
});

test("parseInitArgs --branch: never prompt content, combined with --file, duplicates rejected", () => {
  // The branch pair is pulled out of the prompt text; the rest stays the prompt.
  assert.deepEqual(expectOk(() => parseInitArgs(["Build", "a", "todo CLI.", "--branch", "trunk"])), {
    prompt: "Build a todo CLI.",
    branch: "trunk",
    adopt: false,
    dryRun: false,
  });

  // Both flags at once: the file is the prompt, the branch the initial branch.
  const dir = tmpdir();
  const file = path.join(dir, "prompt.md");
  fs.writeFileSync(file, "From a file.");
  assert.deepEqual(expectOk(() => parseInitArgs(["--file", file, "--branch", "trunk"])), {
    prompt: "From a file.",
    branch: "trunk",
    adopt: false,
    dryRun: false,
  });

  // A doubled --branch is a mistake, not a name collision.
  const dup = expectFail(() => parseInitArgs(["--branch", "a", "--branch", "b"]));
  assert.match(dup.stderr, /--branch may only be given once/);

  // With --file, anything besides the two flag pairs is a stray token.
  const stray = expectFail(() => parseInitArgs(["--file", file, "--branch", "trunk", "extra"]));
  assert.match(stray.stderr, /unexpected argument "extra"/);
});

test("parseInitArgs --adopt/--dry-run: valueless, never prompt content, combine with --file, duplicates rejected", () => {
  // Both booleans are stripped before the join, wherever they sit — `init --adopt "brief"`
  // must not bake "--adopt" into the brief every tick reads.
  assert.deepEqual(expectOk(() => parseInitArgs(["--adopt", "Build", "--dry-run", "a thing."])), {
    prompt: "Build a thing.",
    branch: null,
    adopt: true,
    dryRun: true,
  });
  // A boolean is valueless: the token after it stays prompt text, even beside --branch.
  assert.deepEqual(expectOk(() => parseInitArgs(["--dry-run", "--branch", "trunk", "Go."])), {
    prompt: "Go.",
    branch: "trunk",
    adopt: false,
    dryRun: true,
  });

  // With --file, the booleans are claimed alongside it — only a truly stray token fails.
  const dir = tmpdir();
  const file = path.join(dir, "prompt.md");
  fs.writeFileSync(file, "From a file.");
  assert.deepEqual(
    expectOk(() => parseInitArgs(["--adopt", "--file", file, "--dry-run", "--branch", "trunk"])),
    { prompt: "From a file.", branch: "trunk", adopt: true, dryRun: true },
  );
  const stray = expectFail(() => parseInitArgs(["--file", file, "--adopt", "extra"]));
  assert.match(stray.stderr, /unexpected argument "extra"/);

  // A doubled boolean fails by name, like the valued flags.
  assert.match(
    expectFail(() => parseInitArgs(["--adopt", "x", "--adopt"])).stderr,
    /--adopt may only be given once/,
  );
  assert.match(
    expectFail(() => parseInitArgs(["--dry-run", "--dry-run", "x"])).stderr,
    /--dry-run may only be given once/,
  );

  // The unknown-flag message lists every valid flag.
  assert.match(
    expectFail(() => parseInitArgs(["--adpot", "x"])).stderr,
    /valid flags for tumwater init: --file <path>, --branch <name>, --adopt, --dry-run/,
  );
});

// --- parsePromptArgs ---

test("parsePromptArgs enqueues free-form text (trimmed; single-dash tokens are content)", () => {
  const r = expectOk(() => parsePromptArgs(["add", "dark mode"]));
  assert.deepEqual(r, { mode: "enqueue", role: null, text: "add dark mode" });

  // Surrounding whitespace is trimmed so a queued prompt never starts/ends with padding.
  const padded = expectOk(() => parsePromptArgs(["  hello  "]));
  assert.deepEqual(padded, { mode: "enqueue", role: null, text: "hello" });

  // Only double-dash tokens are flags; a leading single dash is free-form content.
  const dash = expectOk(() => parsePromptArgs(["-x"]));
  assert.deepEqual(dash, { mode: "enqueue", role: null, text: "-x" });
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
  assert.match(r.stderr, /valid flags for tumwater prompt: --role <id>, --list, --cancel <n>/);
});

test("parsePromptArgs --list: exact mode, no text allowed", () => {
  assert.deepEqual(expectOk(() => parsePromptArgs(["--list"])), { mode: "list", role: null });

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
  assert.deepEqual(expectOk(() => parsePromptArgs(["--cancel", "2"])), { mode: "cancel", role: null, position: 2 });

  // A missing value is its own error (distinct from a bad number).
  const bare = expectFail(() => parsePromptArgs(["--cancel"]));
  assert.match(bare.stderr, /--cancel needs a position number \(e\.g\. `--cancel 2`\)/);

  // A flag-looking value is named in the got-value message like every sibling count flag,
  // not swallowed into the bare text — the reachable case is a scoped cancel whose position
  // was forgotten (`--cancel --role feature`); bare `--cancel --role` trips --role's own
  // missing-value check first.
  const flagValue = expectFail(() => parsePromptArgs(["--cancel", "--role", "feature"]));
  assert.equal(flagValue.code, 1);
  assert.match(flagValue.stderr, /--cancel needs a positive integer \(got "--role"\)/);

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

test("parsePromptArgs --role: accepted in every mode, never prompt content", () => {
  // The raw value rides out unvalidated — cli.ts checks it against the live config, since
  // this parser has no config to read.
  assert.deepEqual(
    expectOk(() => parsePromptArgs(["--role", "qa", "check", "the flow"])),
    { mode: "enqueue", role: "qa", text: "check the flow" },
  );
  // The flag pair is never prompt content — before or after the text.
  assert.deepEqual(
    expectOk(() => parsePromptArgs(["hello", "--role", "qa", "world"])),
    { mode: "enqueue", role: "qa", text: "hello world" },
  );
  assert.deepEqual(expectOk(() => parsePromptArgs(["--role", "qa", "--list"])), { mode: "list", role: "qa" });
  assert.deepEqual(expectOk(() => parsePromptArgs(["--cancel", "2", "--role", "qa"])), {
    mode: "cancel",
    role: "qa",
    position: 2,
  });

  // A missing or flag-like value is its own error, not prompt content.
  const bare = expectFail(() => parsePromptArgs(["--role"]));
  assert.match(bare.stderr, /--role needs a role id/);
  const flaggish = expectFail(() => parsePromptArgs(["--role", "--list"]));
  assert.match(flaggish.stderr, /--role needs a role id/);

  // At most one --role, and it is still a stray alongside --list/--cancel.
  const dup = expectFail(() => parsePromptArgs(["--role", "qa", "--role", "docs", "hi"]));
  assert.match(dup.stderr, /--role may only be given once/);
  const stray = expectFail(() => parsePromptArgs(["--list", "--role", "qa", "extra"]));
  assert.match(stray.stderr, /unexpected argument "extra" — with --list there is no prompt text/);
});

// --- parseDurationFlag (the timed pause's `--for <duration>`) ---

test("parseDurationFlag accepts <n><s|m|h|d> and rejects zero, negative, unit-less, unknown-unit, and missing values", () => {
  assert.equal(expectOk(() => parseDurationFlag("--for", "45s")), 45_000);
  assert.equal(expectOk(() => parseDurationFlag("--for", "90m")), 90 * 60_000);
  assert.equal(expectOk(() => parseDurationFlag("--for", "2h")), 2 * 3_600_000);
  assert.equal(expectOk(() => parseDurationFlag("--for", "1d")), 86_400_000);

  const missing = expectFail(() => parseDurationFlag("--for", undefined));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--for needs a value/);

  for (const raw of ["0", "0m", "0s", "-5m", "30", "30x", "", "m", "1.5h", "1h30m"]) {
    const r = expectFail(() => parseDurationFlag("--for", raw));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--for needs a duration like 45s, 90m, 2h, or 1d/);
  }
});

test("durationLabel phrases a parsed duration back in the parser's vocabulary", () => {
  for (const raw of ["45s", "90m", "2h", "1d", "5m", "3d"]) {
    assert.equal(durationLabel(parseDurationFlag("--for", raw)), raw);
  }
  // A whole hour reads 1h, not 60m — the largest unit the duration divides into evenly wins.
  assert.equal(durationLabel(60 * 60_000), "1h");
});
