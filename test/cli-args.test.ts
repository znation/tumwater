import test from "node:test";
import assert from "node:assert/strict";
import {
  durationLabel,
  flagValue,
  parseBranchFlag,
  parseCountFlag,
  parseDurationFlag,
  parsePortFlag,
  parseRoleFlag,
} from "../src/cli/cli-args.js";
import {
  rejectUnknownArgs,
  durationFlagSpec,
  ROLE_FLAG,
  ROLE_VALUE_ERROR,
  RUN_FLAG_SPECS,
  WAKE_IN_FLAG,
} from "../src/cli/cli-flag-specs.js";
import { allRoleIds } from "../src/roles/roles.js";
import { expectFail, expectOk } from "./exit-capture.js";

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
  { names: ["--role"], value: true, valueName: "<id>", missingValue: ROLE_VALUE_ERROR },
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
  assert.match(r.stderr, /valid flags for tumwater run: --branch <name>, --once, --for <duration>, --role <id>/);
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

test("rejectUnknownArgs: valued flags claim their value token; duplicates and missing values fail", () => {
  // A valued flag claims the following token even when it looks like a known flag — so this
  // is NOT an unknown-argument error (the command's own parser reports "unknown role: -f").
  expectOk(() => rejectUnknownArgs("logs", ["--role", "-f"], LOGS_SPECS));

  // A trailing valued flag with no value fails right here, with the spec's missingValue
  // wording — cli.ts runs this gate before the ready-repo gate, so "pause --role" outside an
  // initialized repo must name the flag, not "not a git repository".
  const bare = expectFail(() => rejectUnknownArgs("logs", ["-n"], LOGS_SPECS));
  assert.match(bare.stderr, /tumwater: -n needs a value/);
  const roleBare = expectFail(() => rejectUnknownArgs("logs", ["--follow", "--role"], LOGS_SPECS));
  // The exact message parseRoleFlag prints — the drift-guard below pins the two together.
  assert.equal(
    roleBare.stderr,
    expectFail(() => parseRoleFlag(["--role"])).stderr,
    "the gate's missing-value report must be the parser's own wording",
  );
  const branchBare = expectFail(() => rejectUnknownArgs("run", ["--branch"], RUN_FLAG_SPECS));
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
  expectOk(() => rejectUnknownArgs("logs", ["--role", "-f", "--follow"], LOGS_SPECS));
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
  const run = expectFail(() => rejectUnknownArgs("run", ["--for", "100d"], RUN_FLAG_SPECS));
  assert.match(run.stderr, /run --for is capped at 90d \(got 100d\)/);
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

// --- the --flag=value spelling ---

test("rejectUnknownArgs names the equals form of a known flag instead of 'unknown argument'", () => {
  // `--role=feature` is a real flag in a spelling this CLI does not accept: the refusal must
  // name the token and the accepted space-separated form, not misreport a misspelling.
  const valued = expectFail(() => rejectUnknownArgs("logs", ["--role=feature"], LOGS_SPECS));
  assert.equal(valued.code, 1);
  assert.match(valued.stderr, /tumwater: --role=feature is not accepted/);
  assert.match(valued.stderr, /`--role <id>`/);

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

