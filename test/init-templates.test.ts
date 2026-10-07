import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { cmdInit } from "../src/cli/cli-run.js";
import { INIT_TEMPLATES, getTemplate, templateCatalog, templateIds } from "../src/init/init-templates.js";
import { parseEntryDetails } from "../src/backlog/backlog-md.js";
import { parseInitArgs } from "../src/cli/cli-command-args.js";
import { INITIAL_PROMPT_MAX_CHARS, readInitialPrompt } from "../src/brief.js";
import { makeRepo, tmpdir, assertClean, sh } from "./repo-fixtures.js";
import { attempt, expectFail } from "./exit-capture.js";

test("the template catalog has exactly four ids; blank is inert, the rest are complete seeds", () => {
  assert.deepEqual(templateIds(), ["blank", "python-cli", "node-cli", "static-site"]);
  for (const t of INIT_TEMPLATES) {
    assert.ok(t.description.length > 0 || t.id === "blank", `${t.id} has a description`);
    assert.ok(t.briefPreamble.length > 0 || t.id === "blank", `${t.id} has a preamble`);
    assert.ok(
      t.id === "blank" || (t.starterPlans.length >= 3 && t.starterPlans.length <= 5),
      `${t.id} carries 3-5 starter plans`,
    );
    for (const dir of t.starterDirs) {
      assert.ok(!dir.includes("/"), `${t.id}'s starter dir ${dir} is a top-level directory`);
    }
    assert.ok(getTemplate(t.id), `${t.id} resolves through getTemplate`);
  }
  // blank is the no-op template: today's behavior.
  const blank = getTemplate("blank")!;
  assert.equal(blank.briefPreamble, "");
  assert.deepEqual(blank.starterPlans, []);
  assert.deepEqual(blank.starterDirs, []);
  // getTemplate misses unknown ids; the catalog pairs each id with its description.
  assert.equal(getTemplate("nope"), null);
  assert.deepEqual(templateCatalog()[0], { id: "blank", description: blank.description });
});

test("initProject default (blank) is byte-identical to the pre-templates output", async () => {
  const repo = makeRepo();
  const result = await initProject(repo, "Build a todo CLI.");
  assert.equal(result.template, "blank");
  assert.deepEqual(
    [...result.created].sort(),
    [".gitignore", "BUGS.md", "PLANS.md", "PRINCIPLES.md", "QUESTIONS.md", "README.md", "tumwater.json"],
  );
  assert.equal(readInitialPrompt(repo), "Build a todo CLI.");
  const plans = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  // The placeholder survives verbatim: no starter plans were seeded.
  assert.match(plans, /## Planned\n\n_None yet\._/);
  assert.equal(parseEntryDetails(plans, "Planned").length, 0);
  // No starter directories: blank seeds files only.
  assert.ok(!fs.existsSync(path.join(repo, "src")));
});

test("initProject --template python-cli seeds preamble+plans+dirs and reports the template", async () => {
  const repo = makeRepo();
  const tpl = getTemplate("python-cli")!;
  const result = await initProject(repo, "A markdown-to-html converter.", undefined, {
    template: "python-cli",
  });
  assert.equal(result.template, "python-cli");
  assert.ok(result.committed);
  assertClean(repo);

  // The brief carries the preamble first, the operator's words last.
  const brief = readInitialPrompt(repo);
  assert.ok(brief.startsWith(tpl.briefPreamble + "\n\n"));
  assert.ok(brief.endsWith("A markdown-to-html converter."));

  // The seeded PLANS.md holds one `### ` entry per starter plan under ## Planned.
  const plans = fs.readFileSync(path.join(repo, "PLANS.md"), "utf8");
  const entries = parseEntryDetails(plans, "Planned");
  assert.equal(entries.length, tpl.starterPlans.length);
  for (const [i, entry] of entries.entries()) assert.equal(entry.title, tpl.starterPlans[i]);

  // The starter directories exist and are empty.
  for (const dir of tpl.starterDirs) {
    assert.ok(fs.statSync(path.join(repo, dir)).isDirectory());
    assert.equal(fs.readdirSync(path.join(repo, dir)).length, 0);
  }
});

test("initProject --template leaves existing starter directories alone and reports them as leftAlone", async () => {
  const repo = makeRepo();
  // A repo that already carries the template's starter directories — with real content in
  // them, since the fleet's own ticks would have written code there. Init must not mkdir
  // over them, must not empty them, and must report them the way it reports existing files:
  // leftAlone, not created.
  fs.mkdirSync(path.join(repo, "src"));
  fs.mkdirSync(path.join(repo, "tests"));
  fs.writeFileSync(path.join(repo, "src", "main.py"), "print('hi')\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own starter dirs");

  const result = await initProject(repo, "A markdown-to-html converter.", undefined, {
    template: "python-cli",
  });
  assert.ok(result.committed);
  assert.deepEqual(result.created.filter((f) => f === "src" || f === "tests"), []);
  assert.ok(result.leftAlone.includes("src") && result.leftAlone.includes("tests"));
  assert.equal(fs.readFileSync(path.join(repo, "src", "main.py"), "utf8"), "print('hi')\n");
  assertClean(repo);

  // A dry run on the same shape reports the same leftAlone and creates nothing new.
  const dry = tmpdir();
  fs.mkdirSync(path.join(dry, "src"));
  fs.writeFileSync(path.join(dry, "src", "main.py"), "print('hi')\n");
  const dryRun = await initProject(dry, "A markdown-to-html converter.", undefined, {
    template: "python-cli",
    dryRun: true,
  });
  assert.ok(dryRun.dryRun);
  assert.ok(dryRun.leftAlone.includes("src"));
  assert.ok(dryRun.created.includes("tests")); // would create
  assert.ok(!fs.existsSync(path.join(dry, "tests")));
});

test("an unknown template id and an overflowing preamble fail before any side effect", async () => {
  const repo = makeRepo();
  await assert.rejects(
    () => initProject(repo, "brief", undefined, { template: "nope" }),
    /unknown template "nope" — valid templates: blank, python-cli, node-cli, static-site/,
  );
  // An empty prompt with a template still seeds (the preamble alone is a legitimate brief);
  // only unknown ids and an overflowing combined brief are refused here.
  assert.deepEqual(
    fs.readdirSync(repo).filter((n) => n !== ".git" && n !== "seed.txt"),
    [],
  );

  // The preamble pushes the combined brief over the cap: refuse before writing anything.
  const long = "x".repeat(INITIAL_PROMPT_MAX_CHARS);
  await assert.rejects(
    () => initProject(repo, long, undefined, { template: "python-cli" }),
    /initial prompt with the python-cli template's preamble is \d+ chars/,
  );
  assert.deepEqual(
    fs.readdirSync(repo).filter((n) => n !== ".git" && n !== "seed.txt"),
    [],
  );
});

test("cmdInit --list-templates prints the catalog and exits 0 without touching the repo", () => {
  const repo = tmpdir();
  // Safe under the in-process exit stub: the --list-templates branch returns before
  // cmdInit's git work begins, so no child spawn falls inside the capture window.
  const out = attempt(() => cmdInit(repo, ["--list-templates"]));
  assert.ok(!out.exited, `--list-templates must succeed: ${out.exited ? out.stderr : ""}`);
  const lines = out.stdout.trimEnd().split("\n");
  assert.equal(lines.length, INIT_TEMPLATES.length);
  for (const [i, line] of lines.entries()) {
    const t = INIT_TEMPLATES[i];
    assert.ok(t, `line ${i} has a template`);
    assert.match(line, new RegExp(`^${t.id} — .+`));
  }
  // Nothing was written: the listing is read-only.
  assert.equal(fs.readdirSync(repo).length, 0);
});

test("parseInitArgs rejects an unknown --template id with the catalog listed", () => {
  const r = expectFail(() => parseInitArgs(["--template", "nope", "Build a thing."]));
  assert.match(r.stderr, /unknown template "nope"/);
  assert.match(r.stderr, /blank, python-cli, node-cli, static-site/);
});
