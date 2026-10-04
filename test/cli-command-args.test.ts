/** Tests for src/cli-command-args.ts — the free-form-prompt command parsers
 * (parseInitArgs, parsePromptArgs). Driven in-process (like test/cli-args.test.ts drives
 * the shared parsers) so branches the spawned-CLI e2e path never reaches are covered:
 * duplicate flags, stray positionals beside a flag, --file validation, and the
 * equals-form refusals both parsers apply. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseInitArgs, parsePromptArgs } from "../src/cli-command-args.js";
import { tmpdir } from "./repo-fixtures.js";
import { expectFail, expectOk } from "./exit-capture.js";

// --- parseInitArgs ---

test("parseInitArgs joins positionals (single-dash tokens are content, not flags)", () => {
  assert.deepEqual(expectOk(() => parseInitArgs(["Build", "a", "todo CLI."])), {
    prompt: "Build a todo CLI.",
    branch: null,
    adopt: false,
    template: null,
    listTemplates: false,
    dryRun: false,
  });
  // Bullets and other single-dash tokens stay prompt content.
  assert.deepEqual(expectOk(() => parseInitArgs(["- Build A", "- Build B"])), {
    prompt: "- Build A - Build B",
    branch: null,
    adopt: false,
    template: null,
    listTemplates: false,
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
    template: null,
    listTemplates: false,
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

test("parseInitArgs --branch: never prompt content, combined with --file, duplicates rejected", () => {
  // The branch pair is pulled out of the prompt text; the rest stays the prompt.
  assert.deepEqual(expectOk(() => parseInitArgs(["Build", "a", "todo CLI.", "--branch", "trunk"])), {
    prompt: "Build a todo CLI.",
    branch: "trunk",
    adopt: false,
    template: null,
    listTemplates: false,
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
    template: null,
    listTemplates: false,
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
    template: null,
    listTemplates: false,
    dryRun: true,
  });
  // A boolean is valueless: the token after it stays prompt text, even beside --branch.
  assert.deepEqual(expectOk(() => parseInitArgs(["--dry-run", "--branch", "trunk", "Go."])), {
    prompt: "Go.",
    branch: "trunk",
    adopt: false,
    template: null,
    listTemplates: false,
    dryRun: true,
  });

  // With --file, the booleans are claimed alongside it — only a truly stray token fails.
  const dir = tmpdir();
  const file = path.join(dir, "prompt.md");
  fs.writeFileSync(file, "From a file.");
  assert.deepEqual(
    expectOk(() => parseInitArgs(["--adopt", "--file", file, "--dry-run", "--branch", "trunk"])),
    { prompt: "From a file.", branch: "trunk", adopt: true, template: null, listTemplates: false, dryRun: true },
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
    /valid flags for tumwater init: --file <path>, --branch <name>, --template <id>, --adopt, --dry-run, --list-templates/,
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
  assert.match(r.stderr, /valid flags for tumwater prompt: --role <id>, --list, --json, --cancel <n>, --file <path>/);
});

test("parsePromptArgs --list: exact mode, no text allowed", () => {
  assert.deepEqual(expectOk(() => parsePromptArgs(["--list"])), { mode: "list", role: null, json: false });

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
  assert.deepEqual(expectOk(() => parsePromptArgs(["--role", "qa", "--list"])), { mode: "list", role: "qa", json: false });
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

test("parseInitArgs and parsePromptArgs apply the same equals-form refusal to their own flags", () => {
  // init: a value flag and its boolean sibling, each with its own accepted spelling named.
  const branch = expectFail(() => parseInitArgs(["--branch=main", "brief text"]));
  assert.match(branch.stderr, /--branch=main is not accepted/);
  assert.match(branch.stderr, /`--branch <name>`/);
  const file = expectFail(() => parseInitArgs(["--file=prompt.md"]));
  assert.match(file.stderr, /`--file <path>`/);
  const adopt = expectFail(() => parseInitArgs(["--adopt=false", "brief text"]));
  assert.match(adopt.stderr, /--adopt takes no value/);
  // init: an equals form naming no known flag still reads as unknown argument.
  const stray = expectFail(() => parseInitArgs(["--adoptt=x", "brief text"]));
  assert.match(stray.stderr, /unknown argument: --adoptt=x/);

  // prompt: all three flags, value-taking and valueless alike.
  const role = expectFail(() => parsePromptArgs(["--role=qa", "ship it"]));
  assert.match(role.stderr, /`--role <id>`/);
  const cancel = expectFail(() => parsePromptArgs(["--cancel=2"]));
  assert.match(cancel.stderr, /`--cancel <n>`/);
  const list = expectFail(() => parsePromptArgs(["--list=true"]));
  assert.match(list.stderr, /--list takes no value/);
  const json = expectFail(() => parsePromptArgs(["--json=true"]));
  assert.match(json.stderr, /--json takes no value/);
});

test("parsePromptArgs --json: list-only, at most once, never prompt content", () => {
  // Valid with --list, alone or scoped by --role; the flag is claimed, not text.
  assert.deepEqual(expectOk(() => parsePromptArgs(["--list", "--json"])), { mode: "list", role: null, json: true });
  assert.deepEqual(expectOk(() => parsePromptArgs(["--json", "--role", "qa", "--list"])), {
    mode: "list",
    role: "qa",
    json: true,
  });

  // Alone (enqueue mode) or beside --cancel it is refused by name, never baked into text.
  const alone = expectFail(() => parsePromptArgs(["hello", "--json"]));
  assert.match(alone.stderr, /--json only applies to --list/);
  const cancel = expectFail(() => parsePromptArgs(["--cancel", "1", "--json"]));
  assert.match(cancel.stderr, /--json only applies to --list/);

  // A duplicate fails like --list/--cancel do.
  const dup = expectFail(() => parsePromptArgs(["--list", "--json", "--json"]));
  assert.match(dup.stderr, /--json may only be given once/);
});

test("parsePromptArgs --file: reads the file as the prompt, composes with --role, refuses bad shapes", () => {
  const dir = tmpdir();
  const file = path.join(dir, "note.md");
  fs.writeFileSync(file, "Refactor the parser.\nWith care.\n");

  // The file's contents are the prompt, byte for byte (no trim in the parser: the --file
  // prompt is handed whole to the enqueue path, unlike the joined-and-trimmed positional
  // path; the queue layer's own trim still applies downstream).
  assert.deepEqual(expectOk(() => parsePromptArgs(["--file", file])), {
    mode: "enqueue",
    role: null,
    text: "Refactor the parser.\nWith care.\n",
  });

  // Composes with --role; the role pair is a scope, not file content.
  assert.deepEqual(expectOk(() => parsePromptArgs(["--role", "qa", "--file", file])), {
    mode: "enqueue",
    role: "qa",
    text: "Refactor the parser.\nWith care.\n",
  });

  // A missing value fails by name, like init's.
  assert.match(expectFail(() => parsePromptArgs(["--file"])).stderr, /--file needs a path/);

  // An unreadable path names the file and its role as the prompt source.
  const missing = expectFail(() => parsePromptArgs(["--file", path.join(dir, "nope.md")]));
  assert.match(missing.stderr, /cannot read prompt file/);

  // An empty (or whitespace-only) file reads as an empty prompt — name the file.
  const empty = path.join(dir, "empty.md");
  fs.writeFileSync(empty, "   \n\n");
  const blank = expectFail(() => parsePromptArgs(["--file", empty]));
  assert.match(blank.stderr, /the prompt file .* is empty/);

  // Stray positional tokens are refused: the file IS the prompt.
  const stray = expectFail(() => parsePromptArgs(["--file", file, "extra"]));
  assert.match(stray.stderr, /unexpected argument "extra" — with --file the prompt comes from the file/);

  // The read-only and destructive modes refuse --file rather than silently ignore it.
  assert.match(expectFail(() => parsePromptArgs(["--list", "--file", file])).stderr, /--file only queues a prompt/);
  assert.match(expectFail(() => parsePromptArgs(["--cancel", "1", "--file", file])).stderr, /--file only queues a prompt/);

  // A duplicate fails like the other valued flags; the equals form names a real flag.
  assert.match(expectFail(() => parsePromptArgs(["--file", file, "--file", file])).stderr, /--file may only be given once/);
  assert.match(expectFail(() => parsePromptArgs(["--file=" + file])).stderr, /`--file <path>`/);
});

test("parseInitArgs --template: never prompt content, validated against the catalog, composes with --file", () => {
  // The template pair is pulled out of the prompt text and its id validated here, so a typo
  // fails before initProject can seed a half-formed repo.
  assert.deepEqual(expectOk(() => parseInitArgs(["Build", "a", "todo CLI.", "--template", "python-cli"])), {
    prompt: "Build a todo CLI.",
    branch: null,
    template: "python-cli",
    listTemplates: false,
    adopt: false,
    dryRun: false,
  });

  // An unknown id names the valid ones.
  const unknown = expectFail(() => parseInitArgs(["--template", "nope", "Build a thing."]));
  assert.match(unknown.stderr, /unknown template "nope" — valid templates: blank, python-cli, node-cli, static-site/);

  // A missing value fails by name, like the other valued flags.
  assert.match(expectFail(() => parseInitArgs(["--template"])).stderr, /--template needs an id/);

  // With --file, the template pair is claimed alongside the other flags.
  const dir = tmpdir();
  const file = path.join(dir, "prompt.md");
  fs.writeFileSync(file, "From a file.");
  assert.deepEqual(expectOk(() => parseInitArgs(["--file", file, "--template", "node-cli"])), {
    prompt: "From a file.",
    branch: null,
    template: "node-cli",
    listTemplates: false,
    adopt: false,
    dryRun: false,
  });

  // A duplicated pair is a mistake, like a doubled --branch.
  assert.match(expectFail(() => parseInitArgs(["--template", "a", "--template", "b"])).stderr, /--template may only be given once/);
});

test("parseInitArgs --list-templates: alone with no prompt; refuses a prompt, --file, and --template", () => {
  assert.deepEqual(expectOk(() => parseInitArgs(["--list-templates"])), {
    prompt: "",
    branch: null,
    template: null,
    listTemplates: true,
    adopt: false,
    dryRun: false,
  });

  assert.match(expectFail(() => parseInitArgs(["--list-templates", "Build a thing."])).stderr, /--list-templates takes no prompt/);
  assert.match(expectFail(() => parseInitArgs(["--list-templates", "--template", "python-cli"])).stderr, /--list-templates takes no --template/);

  const dir = tmpdir();
  const file = path.join(dir, "prompt.md");
  fs.writeFileSync(file, "From a file.");
  assert.match(expectFail(() => parseInitArgs(["--list-templates", "--file", file])).stderr, /--list-templates takes no prompt/);
});
