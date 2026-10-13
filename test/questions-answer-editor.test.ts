// Bare `questions answer <n>` opens the question in $VISUAL/$EDITOR and records the text above
// the cut line as the decision.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { initProject } from "../src/init/init.js";
import { ANSWER_EDITOR_CUT } from "../src/cli/question-commands.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { cliWithEnv } from "./helpers/cli-harness.js";

function stub(dir: string, name: string, body: string): { env: NodeJS.ProcessEnv; received: string } {
  const received = path.join(dir, `${name}.received`);
  const script = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(
    script,
    `const fs = require("fs"); const file = process.argv[2]; const text = fs.readFileSync(file, "utf8");\n` +
      `fs.writeFileSync(${JSON.stringify(received)}, text);\n${body}\n`,
  );
  return { env: { EDITOR: `"${process.execPath}" "${script}"` }, received };
}

const OPEN = "### First question\n\nOption A or B?\n\n### Second question\n\nWhich cap?\n";

async function seeded(): Promise<{ repo: string; dir: string; qpath: string }> {
  const repo = makeRepo();
  await initProject(repo, "answer editor");
  const qpath = path.join(repo, "QUESTIONS.md");
  fs.writeFileSync(qpath, `# Questions\n\n## Open\n\n${OPEN}\n## Answered\n\n_None yet._\n`);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "seed questions"], { cwd: repo });
  return { repo, dir: tmpdir("tumwater-stub-"), qpath };
}

test("bare questions answer records the lines above the cut and commits", async () => {
  const { repo, dir, qpath } = await seeded();
  const s = stub(dir, "a", `fs.writeFileSync(file, "Go with option B.\\nKeep the cap.\\n" + text);`);
  const r = await cliWithEnv(repo, s.env, ["questions", "answer", "1"]);
  assert.equal(r.code, 0, r.stderr);
  const got = fs.readFileSync(s.received, "utf8");
  assert.ok(got.includes(ANSWER_EDITOR_CUT));
  assert.ok(got.includes("### First question") && got.includes("Option A or B?"));
  const md = fs.readFileSync(qpath, "utf8");
  const answered = md.slice(md.indexOf("## Answered"));
  assert.match(answered, /### First question[\s\S]*Go with option B\.\nKeep the cap\./);
  assert.doesNotMatch(answered.split("Keep the cap.")[1] ?? "", /Option A or B/);
  assert.match(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }), /tumwater\(operator\): Answer question: First question/);
});

test("an unchanged buffer or a failing editor changes nothing", async () => {
  const { repo, dir, qpath } = await seeded();
  const before = fs.readFileSync(qpath, "utf8");
  const blank = await cliWithEnv(repo, stub(dir, "b", "").env, ["questions", "answer", "1"]);
  assert.notEqual(blank.code, 0);
  assert.match(blank.stderr, /editor left it blank/);
  const bad = await cliWithEnv(repo, stub(dir, "c", "process.exit(1);").env, ["questions", "answer", "1"]);
  assert.notEqual(bad.code, 0);
  assert.equal(fs.readFileSync(qpath, "utf8"), before);
});

test("a missing position never runs the editor; no editor is reported", async () => {
  const { repo, dir } = await seeded();
  const marker = path.join(dir, "ran");
  const s = stub(dir, "d", `fs.writeFileSync(${JSON.stringify(marker)}, "x");`);
  const r = await cliWithEnv(repo, s.env, ["questions", "answer", "9"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no question at position 9 \(2 open\)/);
  assert.equal(fs.existsSync(marker), false);
  const none = await cliWithEnv(repo, {}, ["questions", "answer", "1"]);
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /no editor: set \$VISUAL or \$EDITOR, or pass a decision or --file <path>/);
});

test("a heading line in the decision is refused and the file stays unchanged", async () => {
  const { repo, dir, qpath } = await seeded();
  const before = fs.readFileSync(qpath, "utf8");
  const s = stub(dir, "e", `fs.writeFileSync(file, "ok\\n## Sneaky\\n" + text);`);
  const r = await cliWithEnv(repo, s.env, ["questions", "answer", "1"]);
  assert.notEqual(r.code, 0);
  assert.equal(fs.readFileSync(qpath, "utf8"), before);
});

test("a list that shifts while editing is refused with the new title", async () => {
  const { repo, dir, qpath } = await seeded();
  const q = JSON.stringify(qpath);
  const s = stub(
    dir,
    "f",
    `fs.writeFileSync(file, "Decision\\n" + text);\n` +
      `const md = fs.readFileSync(${q}, "utf8"); fs.writeFileSync(${q}, md.replace("## Open\\n\\n", "## Open\\n\\n### Newcomer\\n\\nfresh\\n\\n"));`,
  );
  const r = await cliWithEnv(repo, s.env, ["questions", "answer", "1"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /is now "Newcomer"/);
  assert.match(fs.readFileSync(qpath, "utf8"), /## Open\n\n### Newcomer/);
  assert.doesNotMatch(fs.readFileSync(qpath, "utf8").split("## Answered")[1] ?? "", /Decision/);
});
