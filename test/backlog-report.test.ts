import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderBacklogMarkdown } from "../src/ui/backlog-report.js";
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
  const md = renderBacklogMarkdown(root);
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
  const md = renderBacklogMarkdown(tmpdir()); // No backlog files at all — never throws.
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

  // One format, no flags: anything after the command fails fast like every other command.
  const bad = await runCli(root, "backlog", "--json");
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /takes no arguments/);

  // No requireReadyRepo gate: a plain directory (no tumwater.json, no .git) still prints the
  // three empty sections instead of a startup error.
  const bare = await runCli(tmpdir(), "backlog");
  assert.equal(bare.code, 0);
  assert.equal(bare.out.match(/_\(none\)_/g)?.length, 3);
});

test("tumwater help lists the backlog command", async () => {
  const help = await runCli(makeRepo(), "help");
  assert.match(help.out, /^  tumwater backlog {17}Show planned features, open bugs/m);
});
