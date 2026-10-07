import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { backlogPayload } from "../src/backlog/backlog.js";
import { renderBacklogMarkdown } from "../src/backlog/backlog-render.js";
import { makeRepo, tmpdir } from "./repo-fixtures.js";
import { runCli } from "./cli-harness.js";

const PLANS_MD = `# Plans

## Planned

### Show open bugs in the TUI (planned 2026-09-25)

**Goal.** The dashboard surfaces project status.

**Approach.**
- read PLANS.md
- render it

### Timestamp of last result (planned 2026-09-24)

## Done

### An old finished plan (done 2026-09-20)

Done entries must never appear in the Planned section.
`;

const BUGS_MD = `# Bugs

## Open

### Logs rotate too often (reported 2026-09-25)

**Symptom.** The log file shrinks every minute.

## Fixed

### A fixed bug (fixed 2026-09-24)

Fixed entries must never appear in the Open section.
`;

const QUESTIONS_MD = `# Questions

## Open

_None yet._

## Answered

### Which backend? (answered 2026-09-24)

_pi's default._
`;

test("renderBacklogMarkdown lists the three sections with verbatim titles and indented bodies", () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "PLANS.md"), PLANS_MD);
  fs.writeFileSync(path.join(root, "BUGS.md"), BUGS_MD);
  fs.writeFileSync(path.join(root, "QUESTIONS.md"), QUESTIONS_MD);
  const md = renderBacklogMarkdown(backlogPayload(root));
  // The h1 plus the three section headings, in order.
  assert.match(md, /^# tumwater backlog\n/);
  assert.ok(md.indexOf("## Planned features") < md.indexOf("## Open bugs"));
  assert.ok(md.indexOf("## Open bugs") < md.indexOf("## Open questions"));
  // Titles verbatim, including the (planned …)/(reported …) suffix the dashboards show.
  assert.match(md, /^### Show open bugs in the TUI \(planned 2026-09-25\)$/m);
  assert.match(md, /^### Timestamp of last result \(planned 2026-09-24\)$/m);
  assert.match(md, /^### Logs rotate too often \(reported 2026-09-25\)$/m);
  // Bodies verbatim but indented two spaces under their heading.
  assert.match(md, /^  \*\*Goal\.\*\* The dashboard surfaces project status\.$/m);
  assert.match(md, /^  - read PLANS\.md$/m);
  assert.match(md, /^  \*\*Symptom\.\*\* The log file shrinks every minute\.$/m);
  // Done/Fixed entries never leak in.
  assert.ok(!md.includes("old finished plan"));
  assert.ok(!md.includes("A fixed bug"));
  // The placeholder question section renders _(none)_, not the placeholder text.
  assert.match(md, /## Open questions\n\n_\(none\)_/m);
  assert.ok(!md.includes("None yet"));
  assert.ok(!md.includes("Which backend"));
});

test("renderBacklogMarkdown renders three explicit empties on a bare root", () => {
  const md = renderBacklogMarkdown(backlogPayload(tmpdir())); // No backlog files at all — never throws.
  assert.equal(md.match(/_\(none\)_/g)?.length, 3);
  for (const section of ["Planned features", "Open bugs", "Open questions"]) {
    assert.match(md, new RegExp(`## ${section}\\n\\n_\\(none\\)_`));
  }
});

test("tumwater backlog prints the backlog and rejects flags; works outside a ready repo", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "BUGS.md"), BUGS_MD);
  const ok = await runCli(root, "backlog");
  assert.equal(ok.code, 0);
  assert.match(ok.out, /^# tumwater backlog$/m);
  assert.match(ok.out, /### Logs rotate too often \(reported 2026-09-25\)/);
  assert.match(ok.out, /## Planned features\n\n_\(none\)_/);

  // --json is the command's only flag: an unknown one still fails fast like every other
  // command, whether alone or beside the valid one.
  const bad = await runCli(root, "backlog", "--nope");
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /unknown argument: --nope \(valid flags for tumwater backlog: --json\)/);
  const badPair = await runCli(root, "backlog", "--json", "--nope");
  assert.notEqual(badPair.code, 0);
  assert.match(badPair.out, /unknown argument: --nope/);

  // No requireReadyRepo gate: a plain directory (no tumwater.json, no .git) still prints the
  // three empty sections instead of a startup error.
  const bare = await runCli(tmpdir(), "backlog");
  assert.equal(bare.code, 0);
  assert.equal(bare.out.match(/_\(none\)_/g)?.length, 3);
});

test("tumwater backlog --json prints the three entry arrays the Markdown view renders", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "PLANS.md"), PLANS_MD);
  fs.writeFileSync(path.join(root, "BUGS.md"), BUGS_MD);
  fs.writeFileSync(path.join(root, "QUESTIONS.md"), QUESTIONS_MD);
  const ok = await runCli(root, "backlog", "--json");
  assert.equal(ok.code, 0);
  const payload = JSON.parse(ok.out) as {
    plans: Array<{ title: string; body: string }>;
    bugs: Array<{ title: string; body: string }>;
    questions: Array<{ title: string; body: string }>;
  };
  // Same order and verbatim text as the Markdown render of these fixtures (the render test
  // above pins the titles it lists, so the two forms cannot drift apart).
  assert.deepEqual(payload.plans, [
    {
      title: "Show open bugs in the TUI (planned 2026-09-25)",
      body: "**Goal.** The dashboard surfaces project status.\n\n**Approach.**\n- read PLANS.md\n- render it",
    },
    { title: "Timestamp of last result (planned 2026-09-24)", body: "" },
  ]);
  assert.deepEqual(payload.bugs, [
    { title: "Logs rotate too often (reported 2026-09-25)", body: "**Symptom.** The log file shrinks every minute." },
  ]);
  // The questions fixture's Open section holds only the _None yet._ placeholder — no entries.
  assert.deepEqual(payload.questions, []);
  // Done/Fixed/Answered entries and the placeholder never leak in.
  assert.ok(!ok.out.includes("old finished plan"));
  assert.ok(!ok.out.includes("A fixed bug"));
  assert.ok(!ok.out.includes("Which backend"));
  assert.ok(!ok.out.includes("None yet"));

  // A directory with no backlog files prints the pretty-printed all-empty object, exits 0 —
  // a JSON document in every exit-0 case, never prose.
  const bare = await runCli(tmpdir(), "backlog", "--json");
  assert.equal(bare.code, 0);
  assert.deepEqual(JSON.parse(bare.out), { plans: [], bugs: [], questions: [] });
  assert.match(bare.out, /\n  "plans": \[\]/);
});

test("tumwater help lists the backlog command", async () => {
  const help = await runCli(makeRepo(), "help");
  assert.match(help.out, /^  tumwater backlog \[--json\] {8}Show planned features, open bugs/m);
});
