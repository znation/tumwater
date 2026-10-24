import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BRIEF_TEXT_MAX_CHARS, PROMPT_END, PROMPT_START } from "../src/brief/brief.js";
import { assertClean, initializedRepo, makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { cli, cliWithEnv } from "./helpers/cli-harness.js";

// INV-B5: `tumwater brief --file` commits the brief file on main.

const subject = (repo: string) => sh(repo, "git", "log", "-1", "--format=%s");

function promptFile(text: string): string {
  const file = path.join(tmpdir(), "p.md");
  fs.writeFileSync(file, text);
  return file;
}

test("brief --file replaces the prompt, commits on main, and a repeat is a no-op", async () => {
  const repo = await initializedRepo();
  const file = promptFile("Build a better thing.\n");
  const r = await cli(repo, "brief", "--file", file);
  assert.equal(r.code, 0);
  assertClean(repo);
  assert.equal(subject(repo), "tumwater(operator): Edit brief");
  const shown = await cli(repo, "brief");
  assert.match(shown.stdout, /Build a better thing\./);
  const json = JSON.parse((await cli(repo, "brief", "--json")).stdout);
  assert.deepEqual(json, { file: "README.md", prompt: "Build a better thing." });
  const head = sh(repo, "git", "rev-parse", "HEAD");
  const again = await cli(repo, "brief", "--file", file);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /brief unchanged/);
  assert.equal(sh(repo, "git", "rev-parse", "HEAD"), head);
});

test("brief --file --json names the successful edit with changed and committed", async () => {
  const repo = await initializedRepo();
  const r = await cli(repo, "brief", "--file", promptFile("Fresh prompt.\n"), "--json");
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { file: "README.md", changed: true, committed: true });
  assertClean(repo);
  // A repeat with the same file is an unchanged edit, reported as such in JSON.
  const again = await cli(repo, "brief", "--file", promptFile("Fresh prompt.\n"), "--json");
  assert.equal(again.code, 0);
  assert.deepEqual(JSON.parse(again.stdout), { file: "README.md", changed: false, committed: false });
});

test("brief --file on a head off the base branch rolls the edit back and reports it uncommitted", async () => {
  const repo = await initializedRepo();
  const before = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  // On a detached HEAD the primary is not the base branch, so editBriefText writes the
  // new prompt but commitOperatorBacklogEdit declines (never touching git) and rolls the file
  // back to its committed state — the brief must not claim "(committed to main)", and the
  // checkout must not be left dirty to block merges.
  sh(repo, "git", "checkout", "--detach");
  const r = await cli(repo, "brief", "--file", promptFile("Off main prompt.\n"));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /brief unchanged/);
  assert.doesNotMatch(r.stdout, /committed to main/);
  // The write was rolled back: the checkout is clean and the brief is unchanged.
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), before);
});

test("brief --file refuses empty, over-long, and marker-bearing text without touching the brief", async () => {
  const repo = await initializedRepo();
  const before = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  const head = sh(repo, "git", "rev-parse", "HEAD");
  for (const text of ["  \n", "x".repeat(BRIEF_TEXT_MAX_CHARS + 1), `a ${PROMPT_START} b`]) {
    const r = await cli(repo, "brief", "--file", promptFile(text));
    assert.notEqual(r.code, 0);
  }
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), before);
  assert.equal(sh(repo, "git", "rev-parse", "HEAD"), head);
});

test("brief edits TUMWATER.md when it owns the block, and refuses a positional", async () => {
  const repo = await initializedRepo();
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  fs.writeFileSync(path.join(repo, "TUMWATER.md"), readme);
  sh(repo, "git", "add", "TUMWATER.md");
  sh(repo, "git", "commit", "-q", "-m", "adopt");
  assert.equal((await cli(repo, "brief", "--file", promptFile("Other.\n"))).code, 0);
  assert.match(fs.readFileSync(path.join(repo, "TUMWATER.md"), "utf8"), /Other\./);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), readme);
  assertClean(repo);
  assert.notEqual((await cli(repo, "brief", "extra")).code, 0);
});

test("editBriefText refuses a repo with no brief and trims the text it writes", async () => {
  const { editBriefText } = await import("../src/brief/brief-edit.js");
  const none = await editBriefText(makeRepo(), "Anything.");
  assert.equal(none.ok, false);
  assert.match(none.ok ? "" : none.error, /no project brief with a prompt block found/);
  const repo = await initializedRepo();
  const done = await editBriefText(repo, "  Fresh text.  ");
  assert.equal(done.ok, true);
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  assert.match(readme, /\nFresh text\.\n/);
  assert.doesNotMatch(readme, / {2}Fresh text\./);
  assertClean(repo);
});

/** An editor stub: a node script recording the buffer it received, then running `body`. */
function editorStub(name: string, body: string): { env: NodeJS.ProcessEnv; received: string } {
  const dir = tmpdir("tumwater-stub-");
  const received = path.join(dir, `${name}.received`);
  const script = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(
    script,
    `const fs = require("fs"); const file = process.argv[2];\n` +
      `fs.writeFileSync(${JSON.stringify(received)}, fs.readFileSync(file, "utf8"));\n${body}\n`,
  );
  return { env: { EDITOR: `"${process.execPath}" "${script}"` }, received };
}

test("brief --edit saves the edited buffer as --file would; unchanged writes nothing", async () => {
  const repo = await initializedRepo();
  const before = (JSON.parse((await cli(repo, "brief", "--json")).stdout) as { prompt: string }).prompt;
  const same = editorStub("same", "");
  const head = sh(repo, "git", "rev-parse", "HEAD");
  let r = await cliWithEnv(repo, same.env, ["brief", "--edit"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /brief unchanged/);
  assert.equal(sh(repo, "git", "rev-parse", "HEAD"), head);
  r = await cliWithEnv(repo, same.env, ["brief", "--edit", "--json"]);
  assert.deepEqual(JSON.parse(r.stdout), { file: "README.md", changed: false, committed: false });
  const s = editorStub("new", `fs.writeFileSync(file, "Edited in editor.\\n");`);
  r = await cliWithEnv(repo, s.env, ["brief", "--edit"]);
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(s.received, "utf8").trim(), before);
  assert.equal(subject(repo), "tumwater(operator): Edit brief");
  assert.match((await cli(repo, "brief")).stdout, /Edited in editor\./);
});

test("brief on a ready repo with no prompt block fails with the init hint", async () => {
  const repo = await initializedRepo();
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  const start = readme.indexOf(PROMPT_START);
  const end = readme.indexOf(PROMPT_END);
  assert.ok(start >= 0 && end > start, "the template carries a managed prompt block");
  // Strip the whole managed block so no candidate file carries a well-formed one: readBrief
  // then reports null and cmdBrief must say to run init — the gate (tumwater.json, commits)
  // still passes, so this is the no-brief branch, not the not-initialized one.
  fs.writeFileSync(path.join(repo, "README.md"), readme.slice(0, start) + readme.slice(end + PROMPT_END.length));
  sh(repo, "git", "add", "README.md");
  sh(repo, "git", "commit", "-q", "-m", "drop the brief block");
  const r = await cli(repo, "brief");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no project brief with a prompt block found/);
});

test("brief --edit refuses an empty buffer, a failing editor, no editor, and --file", async () => {
  const repo = await initializedRepo();
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  let r = await cliWithEnv(repo, editorStub("empty", `fs.writeFileSync(file, "");`).env, ["brief", "--edit"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /the new brief is empty/);
  r = await cliWithEnv(repo, editorStub("bad", "process.exit(1);").env, ["brief", "--edit"]);
  assert.match(r.stderr, /editor exited with status 1; nothing changed/);
  r = await cliWithEnv(repo, { VISUAL: "", EDITOR: "" }, ["brief", "--edit"]);
  assert.match(r.stderr, /no editor: set \$VISUAL or \$EDITOR, or pass --file <path>/);
  r = await cliWithEnv(repo, editorStub("nf", "").env, ["brief", "--edit", "--file", "x"]);
  assert.match(r.stderr, /pass --edit or --file, not both/);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), readme);
});
