// `plan|bug --edit <n>` with neither text nor --file opens the entry in $VISUAL/$EDITOR and
// writes the saved buffer back through the --file path.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { cli, cliWithEnv } from "./helpers/cli-harness.js";

/** An editor stub: a node script that records the buffer it received, then runs `body`
 * (JS over `file`, the path argv[2], and `text`, its content). */
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

async function seeded(): Promise<{ repo: string; dir: string }> {
  const repo = makeRepo();
  await initProject(repo, "cli editor edit");
  await cli(repo, "plan", "Old title", "old body");
  await cli(repo, "bug", "Old symptom");
  return { repo, dir: tmpdir("tumwater-stub-") };
}

test("plan --edit <n> round-trips through the editor, keeping stamp and the show text", async () => {
  const { repo, dir } = await seeded();
  await cli(repo, "plan", "Neighbour");
  const shown = (await cli(repo, "plan", "--show", "1")).stdout;
  const s = stub(dir, "p", `fs.writeFileSync(file, "New title\\n\\nnew body line\\n");`);
  const r = await cliWithEnv(repo, s.env, ["plan", "--edit", "1"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /edited plan in PLANS\.md: New title/);
  assert.equal(fs.readFileSync(s.received, "utf8").trim(), shown.trim());
  const plans = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  assert.match(plans, /### New title \(reported by the operator \d{4}-\d{2}-\d{2}\)\n\nnew body line/);
  assert.match(plans, /### Neighbour/);
  assert.doesNotMatch(plans, /Old title/);
});

test("bug --edit <n> round-trips a bug's title and body", async () => {
  const { repo, dir } = await seeded();
  const s = stub(dir, "b", `fs.writeFileSync(file, "New symptom\\n\\nmore detail\\n");`);
  const r = await cliWithEnv(repo, s.env, ["bug", "--edit", "1"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /edited bug in BUGS\.md: New symptom/);
  assert.match(fs.readFileSync(path.join(repo, "BUGS.md"), "utf8"), /### New symptom \(reported[^\n]*\)\n\nmore detail/);
});

test("an unchanged buffer prints unchanged and writes nothing", async () => {
  const { repo, dir } = await seeded();
  const before = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  const s = stub(dir, "u", "");
  let r = await cliWithEnv(repo, s.env, ["plan", "--edit", "1"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /unchanged plan 1: Old title/);
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), before);
  r = await cliWithEnv(repo, s.env, ["plan", "--edit", "1", "--json"]);
  assert.deepEqual(JSON.parse(r.stdout), { file: "PLANS.md", title: "Old title", changed: false });
});

test("a failing or emptying editor exits non-zero and leaves the file byte-identical", async () => {
  const { repo, dir } = await seeded();
  const before = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  let r = await cliWithEnv(repo, stub(dir, "f", "process.exit(1);").env, ["plan", "--edit", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /editor exited with status 1; nothing changed/);
  r = await cliWithEnv(repo, stub(dir, "e", `fs.writeFileSync(file, "");`).env, ["plan", "--edit", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /plan needs a title/);
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), before);
});

test("VISUAL wins over EDITOR", async () => {
  const { repo, dir } = await seeded();
  const v = stub(dir, "v", `fs.writeFileSync(file, "From visual\\n");`);
  const e = stub(dir, "ed", `fs.writeFileSync(file, "From editor\\n");`);
  const r = await cliWithEnv(repo, { VISUAL: v.env.EDITOR, EDITOR: e.env.EDITOR }, ["plan", "--edit", "1"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /From visual/);
});

test("an out-of-range position fails before the editor runs", async () => {
  const { repo, dir } = await seeded();
  const marker = path.join(dir, "ran");
  const s = stub(dir, "m", `fs.writeFileSync(${JSON.stringify(marker)}, "x");`);
  const r = await cliWithEnv(repo, s.env, ["plan", "--edit", "9"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no planned feature at position 9/);
  assert.equal(fs.existsSync(marker), false);
});

test("an editor killed by a signal fails naming the signal, leaves the file alone, and removes its temp dir", async () => {
  const { repo, dir } = await seeded();
  const before = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  const where = path.join(dir, "buffer-path");
  const s = stub(dir, "k", `fs.writeFileSync(${JSON.stringify(where)}, file); process.kill(process.pid, "SIGKILL");`);
  const r = await cliWithEnv(repo, s.env, ["plan", "--edit", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /editor exited with signal SIGKILL; nothing changed/);
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), before);
  assert.ok(!fs.existsSync(path.dirname(fs.readFileSync(where, "utf8"))));
});
