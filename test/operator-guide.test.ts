import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { guideText } from "../src/operator/operator-guide.js";
import { HELP, helpStanzas } from "../src/cli/cli-help.js";
import { VALIDATION_GAP_TAGS } from "../src/roles/role-guidance.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { gitInit, makeRepo, sh, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";

/** `tumwater guide` — the working rules an interactive agent reads to steer the backlog. The
 * static body is checked here as data (its sections, and every command name it quotes against
 * the help listing); the repo-specific `This project` section is checked through the CLI against
 * fixtures whose base branch, check command and running-team state the test itself wrote, so no
 * expectation is read back out of the code under test. */

/** The seven sections the planned entry names, in the order the guide must print them. */
const SECTIONS = [
  "What you are doing",
  "Orient first",
  "Writing a plan",
  "Writing a bug",
  "Rules",
  "Getting edits onto main",
  "Other steering",
] as const;

function sectionsOf(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3));
}

test("the static guide body carries the seven sections, in order, and no project section", () => {
  assert.deepEqual(sectionsOf(guideText()), [...SECTIONS]);
  assert.ok(!guideText().includes("## This project"));
});

test("the guide body fits 100 columns, as the planned entry wraps it", () => {
  const wide = guideText()
    .split("\n")
    .map((l, i) => [i + 1, [...l].length] as const)
    .filter(([, n]) => n > 100);
  assert.deepEqual(wide, []);
});

test("the guide names only commands `tumwater help` lists", () => {
  // The drift check the planned entry asks for: extract every `tumwater <word>` from the printed
  // guide and require each word to be a command the help lists. Prose words that follow
  // `tumwater` (the body's own "tumwater runs a development team", "tumwater.json") do not match
  // the backquoted form the rule extracts, so a renamed command does.
  const listed = new Set(helpStanzas(HELP).map((s) => s.command));
  const quoted = [...guideText().matchAll(/`tumwater ([a-z][\w-]*)/g)].map((m) => m[1] as string);
  assert.ok(quoted.length >= 10, `the guide quotes only ${quoted.length} commands`);
  assert.deepEqual(quoted.filter((c) => !listed.has(c)), []);
});

test("the guide lists the validation-gap tags from role-guidance's closed vocabulary", () => {
  // One list, not a second copy: the guide interpolates the same array the doctor's
  // `validation gaps` row checks a Fixed record against.
  const body = guideText();
  for (const tag of VALIDATION_GAP_TAGS) assert.ok(body.includes(`\`${tag}\``), `guide names ${tag}`);
});

/** A ready fixture repo: a git repo with one commit and a tumwater.json naming its own base
 * branch and its own check command, nothing installed under it. The expectations below are these
 * literals, never values read back out of the guide. */
function guideRepo(config: Record<string, unknown>): string {
  const root = makeRepo();
  writeConfig(root, config);
  return root;
}

test("guide inside a ready repo names that repo's base branch and declared check", async () => {
  // The fixture's own inputs: an explicit baseBranch and a `check.command` no npm detection
  // could produce, so a wrong lookup or an npm assumption fails here.
  const root = guideRepo({ baseBranch: "release/3", check: { command: "cargo fmt --check && cargo test" } });
  const r = await cli(root, "guide");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /## What you are doing/);
  assert.match(r.stdout, /## This project/);
  assert.match(r.stdout, /Base branch: `release\/3`/);
  assert.match(r.stdout, /Declared check: `cargo fmt --check && cargo test`/);
  // An explicit command must not be rewritten as an npm script name.
  assert.doesNotMatch(r.stdout, /Declared check: `npm run/);
  assert.match(r.stdout, /Team: no team is running here\./);
});

test("guide's project section reports a running team from the orchestrator's state file", async () => {
  // The same pid read `tumwater status` uses: this test process is recorded as the orchestrator,
  // so the only way the line can say "running" is the live pid probe.
  const root = guideRepo({ check: { command: "pytest -q" } });
  writeOrchestratorMarker(root, ["feature"]);
  const r = await cli(root, "guide");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Team: a team is running here now\./);
  assert.match(r.stdout, /Declared check: `pytest -q`/);
});

test("guide says no declared check instead of naming npm when the repo declares none", async () => {
  // No package.json here and no node_modules under it, so the npm walk-up finds nothing either.
  const root = guideRepo({});
  const r = await cli(root, "guide");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Declared check: none/);
  assert.doesNotMatch(r.stdout, /`npm run/);
});

test("guide outside any repo prints the static body alone and exits 0", async () => {
  // A plain temp dir: not a git repo, so no repo facts exist to print.
  const dir = tmpdir("guide-no-repo-");
  const r = await cli(dir, "guide");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trimEnd(), guideText());
  assert.doesNotMatch(r.stdout, /This project/);
});

test("guide works in a git repo that has no commits and no tumwater.json", async () => {
  // Half-ready is still not ready: the repo gate's own preconditions, read without failing.
  const dir = tmpdir("guide-empty-repo-");
  gitInit(dir);
  const r = await cli(dir, "guide");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trimEnd(), guideText());
});

test("guide takes no arguments: --json and any stray token fail like other no-arg commands", async () => {
  const root = guideRepo({ check: { command: "pytest -q" } });
  for (const arg of ["--json", "plan", "extra"]) {
    const r = await cli(root, "guide", arg);
    assert.equal(r.code, 1, `guide ${arg} exited ${r.code}: ${r.stdout}`);
    assert.match(r.stderr, /tumwater guide takes no arguments/);
    assert.equal(r.stdout, "");
  }
});

test("guide's help stanza lists the command and completion offers it", async () => {
  const r = await cli(tmpdir("guide-completion-"), "completion", "bash");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\bguide\b/);
});

/** The guide's own instruction to an agent: land the commit rather than merge by hand. Nothing
 * here runs it — the plan and bug bodies it names are the contract, quoted from the fixture
 * setup this file cannot reach. */
test("guide points a hand-edited entry at tumwater land, not at a merge of its own", () => {
  const body = guideText();
  assert.match(body, /tumwater land/);
  assert.match(body, /Never commit,\nmerge, or pull on the base branch in the primary checkout yourself\./);
});

test("the guide's Requires clause sits in the heading syntax it quotes", () => {
  // The claim allocator reads a series part's dependency from the heading's LAST parenthetical;
  // the guide must teach that placement, not a body line.
  assert.match(guideText(), /LAST parenthetical/);
});

/** A fixture whose primary checkout is on a branch other than its configured base branch, to pin
 * which of the two the guide names. */
function offBaseRepo(): string {
  const root = tmpdir("guide-off-base-");
  gitInit(root);
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed");
  writeConfig(root, { baseBranch: "release/3" });
  return root;
}

test("guide names the configured base branch, not the checked-out one", async () => {
  // The fixture's setup is the oracle: configured `release/3`, HEAD on `main` (gitInit's -b).
  const root = offBaseRepo();
  assert.equal(sh(root, "git", "rev-parse", "--abbrev-ref", "HEAD"), "main");
  const r = await cli(root, "guide");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Base branch: `release\/3`/);
  assert.doesNotMatch(r.stdout, /Base branch: `main`/);
});
