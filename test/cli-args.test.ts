import test from "node:test";
import assert from "node:assert/strict";
import { flagValue, parseBranchFlag, parseCountFlag, parseDurationFlag, parseGrepFlag, parsePortFlag, parsePositionFlag, parseRoleFlag, parseRoleListFlag, rejectFlagLookingValue, scanPositionArgs, tokenValueProblem, TOKEN_VALUE_ERROR } from "../src/cli/cli-args.js";
import { durationLabel, parseDurationMs } from "../src/text/duration.js";
import {
  rejectUnknownArgs,
  durationFlagSpec,
  ROLE_FLAG,
  LOGS_TRANSCRIPT_VALUE_ERROR,
  START_FLAG_SPECS,
  WAKE_IN_FLAG,
} from "../src/cli/cli-flag-specs.js";
import { allRoleIds } from "../src/roles/roles.js";
import { expectFail, expectOk } from "./helpers/exit-capture.js";

// cli/cli-args.ts's shared parsers, driven in-process (like test/cli-command-args.test.ts
// drives the command parsers) to cover branches the e2e path never exercises — duplicate
// flags (rejected with "may only be given once"), trailing valued flags (now a gate-level
// "needs a value" error), and the bare `--` token.

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

test("parseCountFlag's optional max caps the value with the shared wording", () => {
  // At or under the cap the value passes through unchanged.
  assert.equal(expectOk(() => parseCountFlag("--days", "90", 90)), 90);
  assert.equal(expectOk(() => parseCountFlag("-n", "3", 50)), 3);

  // Over the cap the message names the bound and the raw token — the wording history -n
  // and report --days previously repeated by hand.
  const r = expectFail(() => parseCountFlag("--days", "91", 90));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater: --days must be between 1 and 90 \(got "91"\)/);
});

test("parseCountFlag refuses a flag-looking value as a slipped flag, not a malformed count", () => {
  // `logs -n --json` (or any `--`-token) is a rival flag in the count's slot, never a
  // count — refuse it with rejectFlagLookingValue's shared wording instead of reporting
  // the dropped flag as a malformed count ("got \"--json\""). A single-dash token stays a
  // malformed count, so `-5` still reads as the positive-integer error.
  const r = expectFail(() => parseCountFlag("-n", "--json"));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /-n needs a value \(the next token "--json" is a flag, not a value\)/);
  const neg = expectFail(() => parseCountFlag("-n", "-5"));
  assert.match(neg.stderr, /-n needs a positive integer \(got "-5"\)/);
});

test("parsePositionFlag refuses a flag-looking value as a slipped flag, not a malformed position", () => {
  // The position twin carries the same guard: `--cancel --json` names its own slipped
  // flag rather than reporting "(got \"--json\")" as a bad position number.
  const r = expectFail(() => parsePositionFlag("--cancel", "--json", "--cancel 2"));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--cancel needs a value \(the next token "--json" is a flag, not a value\)/);
  const neg = expectFail(() => parsePositionFlag("--cancel", "-2", "--cancel 2"));
  assert.match(neg.stderr, /--cancel needs a positive integer \(got "-2"\)/);
});

// --- rejectFlagLookingValue (the shared guard the `parse*Flag` helpers funnel into) ---

test("rejectFlagLookingValue refuses a `--`-prefixed value with the shared flag-slot wording", () => {
  // The guard is the one rule every user-facing valued-flag slot applies: a `--` token in the
  // value position is a rival flag, never a value. It fails (exit 1) with the shared wording,
  // naming the caller's own flag and the JSON.stringify-quoted token that slipped into its slot.
  const r1 = expectFail(() => rejectFlagLookingValue("history --result", "--last"));
  assert.equal(r1.code, 1);
  assert.equal(r1.stderr, 'tumwater: history --result needs a value (the next token "--last" is a flag, not a value)\n');
  const r2 = expectFail(() => rejectFlagLookingValue("--file", "--x"));
  assert.equal(r2.code, 1);
  assert.equal(r2.stderr, 'tumwater: --file needs a value (the next token "--x" is a flag, not a value)\n');
});

test("rejectFlagLookingValue passes a normal string and a single-dash value through unchanged", () => {
  // Only a `--` token reads as a flag. A plain value returns untouched, and a single-dash token
  // (a negative number, a one-dash filter) is NOT a flag, so it passes too — refusing it would
  // break intentional one-dash filters and negative counts.
  assert.equal(expectOk(() => rejectFlagLookingValue("--branch", "release/2.0")), "release/2.0");
  assert.equal(expectOk(() => rejectFlagLookingValue("--x", "a b")), "a b");
  assert.equal(expectOk(() => rejectFlagLookingValue("history --since", "-5")), "-5");
  assert.equal(expectOk(() => rejectFlagLookingValue("--by", "-f")), "-f");
});

test("rejectFlagLookingValue passes an absent value through (null stays null, undefined stays undefined)", () => {
  // An absent value is neither refused nor fabricated: the guard returns the argument as-is,
  // so a flag left trailing still hands the caller its null/undefined to apply its own default
  // or `needs a value` error.
  assert.equal(expectOk(() => rejectFlagLookingValue("--x", undefined)), undefined);
  assert.equal(expectOk(() => rejectFlagLookingValue("--y", null)), null);
});

// --- parseGrepFlag (the shared `--grep <text>` filter parser the filtering views use) ---
// It is the deliberate inverse of rejectFlagLookingValue: a `--`- or `-`-token in the grep slot
// is the text to search, never refused. Its value token still leaves `rest` (the `--grep` flag
// token stays) so the pattern cannot be read as a rival flag or a positional, and a valueless or
// empty value fails with the caller's own wording. The views drive it only through their own
// commands; these cases pin the two load-bearing branches on their own.

test("parseGrepFlag removes the value token from rest so a pattern cannot be a rival flag or positional", () => {
  // "two" leaves the list; the `--grep` token and the trailing `-n` remain.
  const err = "logs --grep needs a value";
  const r = expectOk(() => parseGrepFlag(["--grep", "two", "-n"], err));
  assert.deepEqual(r, { rest: ["--grep", "-n"], pattern: "two" });
});

test("parseGrepFlag keeps a flag-shaped or single-dash token as the pattern text, not a refusal", () => {
  // The inverse of rejectFlagLookingValue: a `--`-token and a `-`-token in the grep slot are
  // the pattern to search (e.g. `logs --grep -f` greps for "-f"), so they are returned as
  // `pattern` and removed from `rest` — never refused as rival flags.
  const err = "logs --grep needs a value";
  const flag = expectOk(() => parseGrepFlag(["--grep", "--since"], err));
  assert.deepEqual(flag, { rest: ["--grep"], pattern: "--since" });
  const dash = expectOk(() => parseGrepFlag(["--grep", "-f"], err));
  assert.deepEqual(dash, { rest: ["--grep"], pattern: "-f" });
});

test("parseGrepFlag returns null and leaves rest unchanged when the flag is absent", () => {
  // No `--grep` token: nothing is removed and the filter reports no pattern.
  const err = "logs --grep needs a value";
  const r = expectOk(() => parseGrepFlag(["-n", "5"], err));
  assert.deepEqual(r, { rest: ["-n", "5"], pattern: null });
});

test("parseGrepFlag fails with the caller's wording when the value is valueless or empty", () => {
  // Both the trailing-no-value and the zero-length cases call the one fail(missingValueError),
  // so each writes the exact `tumwater: <err>` line and exits 1 — an absent pattern is an
  // error, not a no-op.
  const err = "logs --grep needs a value";
  const valueless = expectFail(() => parseGrepFlag(["--grep"], err));
  assert.equal(valueless.code, 1);
  assert.equal(valueless.stderr, `tumwater: ${err}\n`);
  const empty = expectFail(() => parseGrepFlag(["--grep", ""], err));
  assert.equal(empty.code, 1);
  assert.equal(empty.stderr, `tumwater: ${err}\n`);
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

// --- tokenValueProblem (the one validation of the `--token <secret>` value, shared by
// `tumwater gui` and `tumwater start --gui`) ---

test("tokenValueProblem is null when the token is absent or a normal secret", () => {
  // An absent --token is fine: the dashboard stays local.
  assert.equal(tokenValueProblem(["--port", "80"], "tumwater gui"), null);
  assert.equal(tokenValueProblem(["--token", "s3cret"], "tumwater gui"), null);
  // A single-dash secret is legitimate; only a `--` token reads as a flag.
  assert.equal(tokenValueProblem(["--token", "-x"], "tumwater gui"), null);
});

test("tokenValueProblem returns TOKEN_VALUE_ERROR for an empty or valueless --token", () => {
  assert.equal(tokenValueProblem(["--token", ""], "tumwater gui"), TOKEN_VALUE_ERROR);
  // The flag as the final argument: no value at all is a problem, not a no-op.
  assert.equal(tokenValueProblem(["--token"], "tumwater gui"), TOKEN_VALUE_ERROR);
});

test("tokenValueProblem refuses a flag-shaped secret, naming the command the operator typed", () => {
  // `--token --all-interfaces` must not serve with the literal secret "--all-interfaces".
  assert.equal(
    tokenValueProblem(["--token", "--all-interfaces"], "tumwater gui"),
    '--token got the flag-looking value "--all-interfaces" instead of a secret — write the secret as its own argument (e.g. `tumwater gui --token s3cret --all-interfaces`)',
  );
  // The same slip under the other caller names that caller in the copyable fix.
  assert.equal(
    tokenValueProblem(["--token", "--port"], "tumwater start --gui"),
    '--token got the flag-looking value "--port" instead of a secret — write the secret as its own argument (e.g. `tumwater start --gui --token s3cret --all-interfaces`)',
  );
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

  // A slipped next flag (`gui --port --json`) is refused with the shared flag-looking-value
  // wording, not reported as a malformed number.
  const slipped = expectFail(() => parsePortFlag("--json"));
  assert.equal(slipped.code, 1);
  assert.match(slipped.stderr, /--port needs a value \(the next token "--json" is a flag, not a value\)/);
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

// User-defined roles are valid --role targets once the config lists them (plans/
// user-defined-loops.md): callers pass knownRoleIds(config) as the accepted set, and an
// unknown id fails naming the customs too.

test("parseRoleFlag accepts user-defined role names from a supplied id list", () => {
  const ids = [...allRoleIds(), "docs-sync"];
  assert.equal(expectOk(() => parseRoleFlag(["--role", "docs-sync"], ids)), "docs-sync");

  // Built-ins validate against the same supplied list.
  const first = allRoleIds()[0];
  assert.ok(first, "role catalog is non-empty");
  assert.equal(expectOk(() => parseRoleFlag(["--role", first], ids)), first);

  const bogus = expectFail(() => parseRoleFlag(["--role", "bogus"], ids));
  assert.match(bogus.stderr, /unknown role: bogus \(valid ids: .+\)/);
  assert.ok(bogus.stderr.includes("docs-sync"), "the valid list names the custom role");

  // Without a supplied list the catalog alone is authoritative — a custom name is unknown.
  const strict = expectFail(() => parseRoleFlag(["--role", "docs-sync"]));
  assert.match(strict.stderr, /unknown role: docs-sync/);
});

test("parseRoleFlag refuses a flag-looking value in the id slot as a slipped value", () => {
  // `--role --json` (or any `--`-token) is a rival flag in the id slot, never a role id —
  // refuse it with rejectFlagLookingValue's shared wording instead of reporting the flag as
  // an "unknown role" that blames the wrong token.
  const r = expectFail(() => parseRoleFlag(["--role", "--json"]));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--role needs a value \(the next token "--json" is a flag, not a value\)/);
});

test("parseRoleListFlag refuses a flag-looking value in the comma-list id slot", () => {
  // The comma-list twin must apply the same guard, so `logs --role --json` names the slip
  // rather than "unknown role: --json".
  const r = expectFail(() => parseRoleListFlag(["--role", "--json"]));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--role needs a value \(the next token "--json" is a flag, not a value\)/);
});

// --- rejectUnknownArgs ---

/** The flag vocabulary each command passes in cli.ts — kept in sync with main()'s cases. */
const LOGS_SPECS = [
  { names: ["-f", "--follow"] },
  { names: ["-n"], value: true, valueName: "<count>" },
  { names: ["--role"], value: true, valueName: "<id>" },
  { names: ["--transcript"], value: true, valueName: "<id>", missingValue: LOGS_TRANSCRIPT_VALUE_ERROR },
];
const GUI_SPECS = [
  { names: ["--port"], value: true, valueName: "<n>" },
  { names: ["--all-interfaces"] },
];

test("rejectUnknownArgs accepts empty args and every known flag spelling", () => {
  expectOk(() => rejectUnknownArgs("logs", [], LOGS_SPECS));
  expectOk(() => rejectUnknownArgs("run", [], []));
  // Every accepted spelling, mixed in one line.
  expectOk(() => rejectUnknownArgs("logs", ["--follow", "-n", "3", "--transcript", "feature"], LOGS_SPECS));
  expectOk(() => rejectUnknownArgs("gui", ["--port", "8080", "--all-interfaces"], GUI_SPECS));
});

test("run's flag vocabulary accepts --branch, --once, --role and --gui and rejects everything else", () => {
  // The specs cmdStart itself passes: all spellings, combined and alone.
  expectOk(() => rejectUnknownArgs("run", ["--branch", "trunk", "--once"], START_FLAG_SPECS));
  expectOk(() => rejectUnknownArgs("run", ["--once"], START_FLAG_SPECS));
  expectOk(() => rejectUnknownArgs("run", ["--once", "--role", "feature"], START_FLAG_SPECS));
  expectOk(() => rejectUnknownArgs("run", ["--gui"], START_FLAG_SPECS));
  expectOk(() => rejectUnknownArgs("run", ["--gui", "--port", "8123"], START_FLAG_SPECS));
  // A typo'd --once must fail with the standard wording, not silently run a daemon round.
  const r = expectFail(() => rejectUnknownArgs("run", ["--onc"], START_FLAG_SPECS));
  assert.match(r.stderr, /unknown argument: --onc/);
  assert.match(
    r.stderr,
    /valid flags for tumwater run: --branch <name>, --once, --json, --gui, --port <n>, --all-interfaces, --token <secret>, --for <duration>, --role <id>/,
  );
  // The removed terminal dashboard: --tui names no flag on run either.
  const tui = expectFail(() => rejectUnknownArgs("run", ["--tui"], START_FLAG_SPECS));
  assert.match(tui.stderr, /unknown argument: --tui/);
  // --once takes no value: a following token is a stray, not its argument.
  const valued = expectFail(() => rejectUnknownArgs("run", ["--once", "yes"], START_FLAG_SPECS));
  assert.match(valued.stderr, /unknown argument: yes/);
  // run's --port shares gui's shape check: a malformed value is named by parsePortFlag, and
  // a repeated --port fails like gui's does.
  const badPort = expectFail(() => rejectUnknownArgs("run", ["--gui", "--port", "abc"], START_FLAG_SPECS));
  assert.match(badPort.stderr, /--port must be an integer between 1 and 65535/);
  const runPortDup = expectFail(() => rejectUnknownArgs("run", ["--gui", "--port", "8000", "--port", "9000"], START_FLAG_SPECS));
  assert.match(runPortDup.stderr, /--port may only be given once/);
});

test("rejectUnknownArgs adds a did-you-mean hint for a near-miss flag", () => {
  const r = expectFail(() => rejectUnknownArgs("gui", ["--portt"], GUI_SPECS));
  assert.match(r.stderr, /unknown argument: --portt/);
  assert.match(r.stderr, /did you mean `--port`\?/);
  // A token far from every accepted flag gets only the valid-flags list, no hint.
  const stray = expectFail(() => rejectUnknownArgs("logs", ["extra"], LOGS_SPECS));
  assert.ok(!stray.stderr.includes('did you mean'), "no hint for a token unlike every flag");
});

test("rejectUnknownArgs rejects unknown tokens with the command's valid flags listed", () => {
  // A misspelled --role used to be ignored: reset-counters would zero EVERY role instead of
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
  assert.match(logs.stderr, /-f\/--follow, -n <count>, --role <id>, --transcript <id>/);
});

test("rejectUnknownArgs: valued flags claim their value token; duplicates and missing values fail", () => {
  // A valued flag claims the following token even when it looks like a known flag — so this
  // is NOT an unknown-argument error (the command's own parser reports "unknown role: -f").
  expectOk(() => rejectUnknownArgs("logs", ["--transcript", "-f"], LOGS_SPECS));

  // A trailing valued flag with no value fails right here, with the spec's missingValue
  // wording — cli.ts runs this gate before the ready-repo gate, so "pause --role" outside an
  // initialized repo must name the flag, not "not a git repository".
  const bare = expectFail(() => rejectUnknownArgs("logs", ["-n"], LOGS_SPECS));
  assert.match(bare.stderr, /tumwater: -n needs a value/);
  const roleBare = expectFail(() => rejectUnknownArgs("logs", ["--follow", "--transcript"], LOGS_SPECS));
  // The exact message parseRoleFlag prints — the drift-guard below pins the two together.
  assert.equal(
    roleBare.stderr,
    expectFail(() => parseRoleFlag(["--transcript"], undefined, "--transcript", LOGS_TRANSCRIPT_VALUE_ERROR)).stderr,
    "the gate's missing-value report must be the parser's own wording",
  );
  const branchBare = expectFail(() => rejectUnknownArgs("run", ["--branch"], START_FLAG_SPECS));
  assert.equal(
    branchBare.stderr,
    expectFail(() => parseBranchFlag(["--branch"])).stderr,
    "--branch's wording is shared with parseBranchFlag too",
  );
  // The generic helpers' wording is the spec default (parseCountFlag below).
  const then = expectFail(() => parseCountFlag("-n", undefined));
  assert.equal(then.stderr, bare.stderr);

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
  expectOk(() => rejectUnknownArgs("logs", ["--transcript", "-f", "--follow"], LOGS_SPECS));
});

test("parseBranchFlag: absent returns null, a value passes, a missing value fails", () => {
  assert.equal(expectOk(() => parseBranchFlag([])), null);
  assert.equal(expectOk(() => parseBranchFlag(["run"])), null);
  assert.equal(expectOk(() => parseBranchFlag(["--branch", "release/2.0"])), "release/2.0");

  const noValue = expectFail(() => parseBranchFlag(["--branch"]));
  assert.match(noValue.stderr, /--branch needs a branch name/);

  // A `--`-token in the slot is the operator's slipped next flag, refused with the shared
  // wording that names it — the same guard every other value slot applies (parseCountFlag's
  // test pins the pairing) — rather than a missing-name message that names no value.
  const flagAsValue = expectFail(() => parseBranchFlag(["--branch", "--json"]));
  assert.match(flagAsValue.stderr, /--branch needs a value \(the next token "--json" is a flag, not a value\)/);

  // A single-dash token is a malformed name, not a slipped flag: the missing-name wording
  // still covers it, as parseCountFlag's single-dash case reads as a malformed count.
  const dashAsValue = expectFail(() => parseBranchFlag(["--branch", "-5"]));
  assert.match(dashAsValue.stderr, /--branch needs a branch name/);
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

  for (const raw of ["0", "0m", "0s", "-5m", "30", "30x", "", "m", "1.5h"]) {
    const r = expectFail(() => parseDurationFlag("--for", raw));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--for needs a duration like 45s, 90m, 1h30m, or 2d/);
  }
});

test("parseDurationFlag rejects a flag-looking value with the shared wording", () => {
  // A `--`-token in the value slot is the operator's slipped value (`start --for --json`), never a
  // duration — refuse it up front with rejectFlagLookingValue's shared wording instead of
  // reporting the next flag as a malformed duration.
  const r = expectFail(() => parseDurationFlag("start --for", "--json"));
  assert.equal(r.code, 1);
  assert.match(
    r.stderr,
    /start --for needs a value \(the next token "--json" is a flag, not a value\)/,
  );
});

test("parseDurationFlag accepts composite durations in descending unit order", () => {
  assert.equal(expectOk(() => parseDurationFlag("--for", "1h30m")), 90 * 60_000);
  assert.equal(expectOk(() => parseDurationFlag("--for", "1h30m15s")), 5_415_000);
  assert.equal(expectOk(() => parseDurationFlag("--for", "2d3h")), 2 * 86_400_000 + 3 * 3_600_000);
  assert.equal(expectOk(() => parseDurationFlag("--for", "1h15m")), 75 * 60_000);
});

test("parseDurationFlag rejects malformed composites: gaps, out-of-order and repeated units, zero components, padded counts", () => {
  for (const raw of ["1h 30m", "1h x30m", "30m1h", "1h30m1h", "1m60h", "0h30m", "1h0m", "01h30m", "007s", "1h30", "h30m"]) {
    const r = expectFail(() => parseDurationFlag("--for", raw));
    assert.equal(r.code, 1, raw);
    assert.match(r.stderr, /--for needs a duration like 45s, 90m, 1h30m, or 2d/);
  }
});

test("parseDurationFlag rejects a flag-looking value with the shared wording", () => {
  // A `--`-token in the value slot is the operator's slipped value (`start --for --json`), never a
  // duration — refuse it up front with rejectFlagLookingValue's shared wording instead of
  // reporting the next flag as a malformed duration.
  const r = expectFail(() => parseDurationFlag("start --for", "--json"));
  assert.equal(r.code, 1);
  assert.match(
    r.stderr,
    /start --for needs a value \(the next token "--json" is a flag, not a value\)/,
  );
});

test("parseDurationFlag rejects a digit run past Number's range instead of parsing to Infinity", () => {
  // "9"×400 overflows Number to Infinity; returning it made the cap check render the nonsense
  // "got Infinityms" rather than the malformed-duration message naming the token.
  const r = expectFail(() => parseDurationFlag("--for", "9".repeat(400) + "d"));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--for needs a duration like 45s, 90m, 1h30m, or 2d/);
});

// --- the gate-level 90-day cap (durationFlagSpec / WAKE_IN_FLAG validate) ---

test("the gate fails an over-cap --for/--in before the ready-repo gate can mask it", () => {
  // `pause --for 100d` outside an initialized repo must name the cap, not the
  // not-initialized hint the ready-repo gate would otherwise print first.
  const over = expectFail(() =>
    rejectUnknownArgs("pause", ["--role", "feature", "--for", "100d"],
      [ROLE_FLAG, durationFlagSpec("pause --for")]),
  );
  assert.match(over.stderr, /pause --for is capped at 90d \(got 100d\)/);
  const wake = expectFail(() =>
    rejectUnknownArgs("wake", ["--in", "91d"], [ROLE_FLAG, WAKE_IN_FLAG]),
  );
  assert.match(wake.stderr, /wake --in is capped at 90d \(got 91d\)/);
  const run = expectFail(() => rejectUnknownArgs("run", ["--for", "100d"], START_FLAG_SPECS));
  assert.match(run.stderr, /start --for is capped at 90d \(got 100d\)/);
  // At or under the cap the gate accepts the value; the bodies' own checks never fire.
  expectOk(() =>
    rejectUnknownArgs("pause", ["--for", "90d", "--role", "feature"],
      [ROLE_FLAG, durationFlagSpec("pause --for")]),
  );
});

test("durationLabel phrases a parsed duration back in the parser's vocabulary", () => {
  for (const raw of ["45s", "90m", "2h", "1d", "5m", "3d"]) {
    assert.equal(durationLabel(parseDurationFlag("--for", raw)), raw);
  }
  // A whole hour reads 1h, not 60m — the largest unit the duration divides into evenly wins.
  assert.equal(durationLabel(60 * 60_000), "1h");
  // A composite that fits no single unit decomposes greedily, largest unit first, so the
  // label names components the parser re-reads.
  assert.equal(durationLabel(90 * 60_000 + 3_000), "1h30m3s");
  assert.equal(durationLabel(2 * 86_400_000 + 3 * 3_600_000 + 5 * 60_000 + 7_000), "2d3h5m7s");
  // A sub-second remainder keeps the raw-millisecond form (computed deltas can produce it;
  // parseDurationFlag's units bottom out at seconds).
  assert.equal(durationLabel(90 * 60_000 + 3_500), "5403500ms");
});

// --- parseDurationMs (the `<n><unit>` duration grammar the CLI flags, send-later and GUI
// prompt defer all validate through — pinned here directly, not only via its callers) ---

test("parseDurationMs accepts single-unit and descending-order composites as exact ms totals", () => {
  assert.equal(parseDurationMs("45s"), 45_000);
  assert.equal(parseDurationMs("90m"), 5_400_000);
  assert.equal(parseDurationMs("30m"), 1_800_000);
  assert.equal(parseDurationMs("1h30m"), 5_400_000);
  assert.equal(parseDurationMs("1h30m15s"), 5_415_000);
  assert.equal(parseDurationMs("2d"), 172_800_000);
  assert.equal(parseDurationMs("1d12h"), 129_600_000);
});

test("parseDurationMs refuses every other spelling with null", () => {
  // A zero count is not a component, even when a nonzero component follows.
  assert.equal(parseDurationMs("0s"), null);
  assert.equal(parseDurationMs("0h30m"), null);
  // The spelling must fill the whole string: no gap between, or padding around, components.
  assert.equal(parseDurationMs("1h 30m"), null);
  assert.equal(parseDurationMs(" 45s"), null);
  assert.equal(parseDurationMs("45s "), null);
  // A bare digit after a component is trailing junk, not a duration.
  assert.equal(parseDurationMs("1s0"), null);
  // Units descend d → h → m → s and never repeat.
  assert.equal(parseDurationMs("30m1h"), null);
  assert.equal(parseDurationMs("1h30m1h"), null);
  assert.equal(parseDurationMs("1h1h"), null);
  // A digit run past Number's range would overflow the sum to Infinity; refuse it.
  assert.equal(parseDurationMs("9".repeat(400) + "s"), null);
  // No valid component at all: empty, junk, a number without a unit, a unit without a number.
  assert.equal(parseDurationMs(""), null);
  assert.equal(parseDurationMs("abc"), null);
  assert.equal(parseDurationMs("1"), null);
  assert.equal(parseDurationMs("s"), null);
});

// --- the --flag=value spelling ---

test("rejectUnknownArgs names the equals form of a known flag instead of 'unknown argument'", () => {
  // `--role=feature` is a real flag in a spelling this CLI does not accept: the refusal must
  // name the token and the accepted space-separated form, not misreport a misspelling.
  const valued = expectFail(() => rejectUnknownArgs("logs", ["--transcript=feature"], LOGS_SPECS));
  assert.equal(valued.code, 1);
  assert.match(valued.stderr, /tumwater: --transcript=feature is not accepted/);
  assert.match(valued.stderr, /`--transcript <id>`/);

  // Valueless flags get their own phrasing: there is no value to separate.
  const valueless = expectFail(() => rejectUnknownArgs("gui", ["--all-interfaces=true"], GUI_SPECS));
  assert.match(valueless.stderr, /--all-interfaces=true is not accepted/);
  assert.match(valueless.stderr, /--all-interfaces takes no value/);

  // An equals form naming NO known flag is still the generic unknown argument, with the
  // valid flags listed — the original wording is unchanged for true misspellings.
  const unknown = expectFail(() => rejectUnknownArgs("logs", ["--rol=feature"], LOGS_SPECS));
  assert.match(unknown.stderr, /unknown argument: --rol=feature/);
  assert.match(unknown.stderr, /valid flags for tumwater logs/);
});

test("rejectUnknownArgs hints `--role <id>` for a bare role id on a --role command", () => {
  const exact = expectFail(() => rejectUnknownArgs("wake", ["feature"], [ROLE_FLAG]));
  assert.match(exact.stderr, /unknown argument: feature \(valid flags for tumwater wake: .*\) — did you mean `--role feature`\?/);
  const near = expectFail(() => rejectUnknownArgs("pause", ["featuer"], [ROLE_FLAG]));
  assert.match(near.stderr, /did you mean `--role feature`\?$/m);
  const far = expectFail(() => rejectUnknownArgs("diff", ["bogus"], [ROLE_FLAG]));
  assert.ok(!far.stderr.includes("did you mean"));
  const role = expectFail(() => rejectUnknownArgs("role", ["bugfix"], [ROLE_FLAG]));
  assert.ok(!role.stderr.includes("--role bugfix"));
  const typo = expectFail(() => rejectUnknownArgs("reset-counters", ["--rol", "feature"], [ROLE_FLAG]));
  assert.match(typo.stderr, /unknown argument: --rol/);
  assert.match(typo.stderr, /did you mean `--role`\?/);
  const noRole = expectFail(() => rejectUnknownArgs("queue", ["feature"], []));
  assert.ok(!noRole.stderr.includes("--role"));
});

// --- scanPositionArgs (the shared scan every queue-style command shell repeats) ---

test("scanPositionArgs consumes the position flag's value token and sets --json in one pass", () => {
  // The value token is claimed by the position flag's skip, so it never reaches rest; --json
  // sets the boolean. No extra booleans were named, so flags stays empty.
  const r = expectOk(() => scanPositionArgs(["--cancel", "2", "--json"], "--cancel", "--cancel 2"));
  assert.deepEqual(r, { json: true, flags: {}, position: 2, rest: [] });

  // A lone valued flag: the position is parsed, everything else is absent.
  const lone = expectOk(() => scanPositionArgs(["--show", "3"], "--show", "--show 2"));
  assert.deepEqual(lone, { json: false, flags: {}, position: 3, rest: [] });
});

test("scanPositionArgs collects the extra boolean edge flags in flags", () => {
  const r = expectOk(() =>
    scanPositionArgs(["--show", "3", "--done", "--json"], "--show", "--show 2", ["--done"]),
  );
  assert.deepEqual(r, { json: true, flags: { "--done": true }, position: 3, rest: [] });
});

test("scanPositionArgs drops --help and -h instead of collecting them in rest", () => {
  const help = expectOk(() => scanPositionArgs(["--show", "3", "--help"], "--show", "--show 2"));
  assert.deepEqual(help, { json: false, flags: {}, position: 3, rest: [] });
  const short = expectOk(() => scanPositionArgs(["--show", "3", "-h"], "--show", "--show 2"));
  assert.deepEqual(short, { json: false, flags: {}, position: 3, rest: [] });
});

test("scanPositionArgs collects unrecognised tokens in rest for the caller's rejectUnknownArgs", () => {
  const r = expectOk(() => scanPositionArgs(["--show", "3", "extra"], "--show", "--show 2"));
  assert.equal(r.position, 3);
  assert.equal(r.json, false);
  assert.deepEqual(r.flags, {});
  assert.deepEqual(r.rest, ["extra"]);
});

test("scanPositionArgs fails a repeated --json, a repeated extra boolean, and a repeated position flag with the shared once wording", () => {
  const json = expectFail(() => scanPositionArgs(["--json", "--json"], "--cancel", "--cancel 2"));
  assert.equal(json.code, 1);
  assert.match(json.stderr, /--json may only be given once/);

  const extra = expectFail(() => scanPositionArgs(["--done", "--done"], "--show", "--show 2", ["--done"]));
  assert.equal(extra.code, 1);
  assert.match(extra.stderr, /--done may only be given once/);

  // The first occurrence's value token is consumed by the skip, so the second occurrence is
  // a bare repeat and reaches rejectRepeatFlag through the position's own seen-check.
  const position = expectFail(() => scanPositionArgs(["--show", "1", "--show", "2"], "--show", "--show 2"));
  assert.equal(position.code, 1);
  assert.match(position.stderr, /--show may only be given once/);
});

test("scanPositionArgs composes parsePositionFlag's value rule: valueless, flag-shaped, and non-integer values each fail", () => {
  // A position flag as the final argument has no value token at all.
  const valueless = expectFail(() => scanPositionArgs(["--cancel"], "--cancel", "--cancel 2"));
  assert.equal(valueless.code, 1);
  assert.match(valueless.stderr, /--cancel needs a position number/);

  // A `--` token in the value slot is a slipped flag, named by the shared guard.
  const slipped = expectFail(() => scanPositionArgs(["--cancel", "--json"], "--cancel", "--cancel 2"));
  assert.equal(slipped.code, 1);
  assert.match(slipped.stderr, /--cancel needs a value \(the next token "--json" is a flag, not a value\)/);

  // A non-integer value fails with the positive-integer wording and the raw token.
  const bad = expectFail(() => scanPositionArgs(["--cancel", "x"], "--cancel", "--cancel 2"));
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--cancel needs a positive integer \(got "x"\)/);
});
