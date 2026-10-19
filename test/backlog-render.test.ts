import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { backlogPayload } from "../src/backlog/backlog.js";
import { readyBacklog, grepBacklog, renderBacklogMarkdown } from "../src/backlog/backlog-render.js";
import { loadLoopState, saveLoopState } from "../src/runner/runner-state.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { runCli } from "./helpers/cli-harness.js";

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

  // --json, --ready, and --grep are the command's only flags: an unknown one still fails fast
  // like every other command, whether alone or beside a valid one.
  const bad = await runCli(root, "backlog", "--nope");
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /unknown argument: --nope \(valid flags for tumwater backlog: --json, --ready, --grep <text>\)/);
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
  assert.deepEqual(JSON.parse(bare.out), {
    plans: [],
    bugs: [],
    questions: [],
    holds: { plans: [], bugs: [] },
    inProgress: { plans: [], bugs: [] },
  });
  assert.match(bare.out, /\n  "plans": \[\]/);
});

test("renderBacklogMarkdown appends holds to headings; no holds leaves the document unchanged", () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "PLANS.md"), PLANS_MD);
  fs.writeFileSync(path.join(root, "BUGS.md"), BUGS_MD);
  const payload = backlogPayload(root);
  const held = renderBacklogMarkdown({
    ...payload,
    holds: { plans: [{ blockedBy: ["Prereq 1/2"] }, "needs-review"], bugs: ["refused"] },
  });
  assert.match(held, /^### Show open bugs in the TUI \(planned 2026-09-25\) \[blocked: requires Prereq 1\/2\]$/m);
  assert.match(held, /^### Timestamp of last result \(planned 2026-09-24\) \[blocked: needs review\]$/m);
  assert.match(held, /^### Logs rotate too often \(reported 2026-09-25\) \[blocked: refused\]$/m);
  // The payload alone (no holds) renders the same document as a view whose holds are absent.
  const plain = renderBacklogMarkdown(payload);
  assert.equal(plain, renderBacklogMarkdown({ ...payload }));
  assert.match(plain, /^### Show open bugs in the TUI \(planned 2026-09-25\)$/m);
  assert.ok(!plain.includes("[blocked"), "a no-holds render carries no hold marks");
});

test("tumwater backlog marks holds in Markdown and shapes holds arrays in --json", async () => {
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    [
      "# Plans",
      "## Planned",
      "### Prereq, part 1/2: base (planned 2026-10-01)",
      "body",
      "### Later, part 2/2: x (planned 2026-10-02; requires Prereq 1/2 landed)",
      "body",
      "### Refused plan (planned 2026-10-03)",
      "**Refused 2026-10-07 by feature: no**",
      "### Ready (planned 2026-10-04)",
      "body",
      "## Done",
      "_None._",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    [
      "# Bugs",
      "## Open",
      "### Refused bug (reported 2026-10-02)",
      "**Refused 2026-10-07 by bugfix: no**",
      "### Real bug (reported 2026-10-02)",
      "repro",
      "## Fixed",
      "_None._",
    ].join("\n"),
  );
  const human = await runCli(root, "backlog");
  assert.equal(human.code, 0);
  assert.match(human.out, /^### Prereq, part 1\/2: base \(planned 2026-10-01\)$/m);
  assert.match(
    human.out,
    /^### Later, part 2\/2: x \(planned 2026-10-02; requires Prereq 1\/2 landed\) \[blocked: requires Prereq 1\/2\]$/m,
  );
  assert.match(human.out, /^### Refused plan \(planned 2026-10-03\) \[blocked: refused\]$/m);
  assert.match(human.out, /^### Refused bug \(reported 2026-10-02\) \[blocked: refused\]$/m);
  assert.match(human.out, /^### Ready \(planned 2026-10-04\)$/m);
  assert.match(human.out, /^### Real bug \(reported 2026-10-02\)$/m);

  const asJson = await runCli(root, "backlog", "--json");
  assert.equal(asJson.code, 0);
  const payload = JSON.parse(asJson.out) as {
    plans: Array<{ title: string }>;
    bugs: Array<{ title: string }>;
    holds: { plans: unknown[]; bugs: unknown[] };
  };
  assert.deepEqual(payload.holds.plans, [null, { blockedBy: ["Prereq 1/2"] }, "refused", null]);
  assert.deepEqual(payload.holds.bugs, ["refused", null]);
  // Holds are parallel to the entry arrays, which keep their fields untouched.
  assert.equal(payload.holds.plans.length, payload.plans.length);
  assert.equal(payload.holds.bugs.length, payload.bugs.length);
  assert.equal(payload.plans.length, 4);
  assert.equal(payload.bugs.length, 2);
  assert.deepEqual(Object.keys(payload.plans[0]!), ["title", "body"]);
});

test("tumwater help lists the backlog command", async () => {
  const help = await runCli(makeRepo(), "help");
  assert.match(help.out, /^  tumwater backlog \[--ready\] \[--grep <text>\] \[--json\]\n {35}Show planned features, open bugs/m);
});

test("renderBacklogMarkdown puts the working-on-it mark after the hold mark", () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "PLANS.md"), PLANS_MD);
  fs.writeFileSync(path.join(root, "BUGS.md"), BUGS_MD);
  const payload = backlogPayload(root);
  const md = renderBacklogMarkdown({
    ...payload,
    holds: { plans: [null, "needs-review"], bugs: [null] },
    inProgress: { plans: [null, "feature-2"], bugs: [null] },
  });
  assert.match(md, /^### Timestamp of last result \(planned 2026-09-24\) \[blocked: needs review\] \[working on it: feature #2\]$/m);
  assert.match(md, /^### Show open bugs in the TUI \(planned 2026-09-25\)$/m);
});

test("tumwater backlog shows the working-on-it mark and --json carries inProgress arrays", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "PLANS.md"), PLANS_MD);
  fs.writeFileSync(path.join(root, "BUGS.md"), BUGS_MD);
  saveLoopState(root, {
    ...loadLoopState(root, "feature-2"),
    claim: { file: "PLANS.md", key: "show open bugs in the tui", title: "Show open bugs in the TUI", at: 1, source: "assigned" },
  });
  const md = await runCli(root, "backlog");
  assert.match(md.out, /^### Show open bugs in the TUI \(planned 2026-09-25\) \[working on it: feature #2\]$/m);
  const doc = JSON.parse((await runCli(root, "backlog", "--json")).out) as {
    plans: unknown[];
    bugs: unknown[];
    inProgress: { plans: (string | null)[]; bugs: (string | null)[] };
  };
  assert.equal(doc.inProgress.plans.length, doc.plans.length);
  assert.equal(doc.inProgress.bugs.length, doc.bugs.length);
  assert.deepEqual(doc.inProgress.plans.filter((x) => x !== null), ["feature-2"]);
});

test("readyBacklog keeps only unheld entries and their parallel arrays", () => {
  const e = (title: string) => ({ title, body: "b" });
  const view = {
    plans: [e("A"), e("B"), e("C")],
    bugs: [e("X"), e("Y")],
    questions: [e("Q")],
    holds: { plans: ["refused" as const, null, { blockedBy: ["Foo 1/2"] }], bugs: [null, "needs-review" as const] },
    inProgress: { plans: [null, "feature-2", null], bugs: [null, null] },
  };
  const out = readyBacklog(view);
  assert.deepEqual(out.plans.map((p) => p.title), ["B"]);
  assert.deepEqual(out.holds?.plans, [null]);
  assert.deepEqual(out.inProgress?.plans, ["feature-2"]);
  assert.deepEqual(out.bugs.map((b) => b.title), ["X"]);
  assert.deepEqual(out.holds?.bugs, [null]);
  assert.deepEqual(out.questions, view.questions);
  const bare = { plans: [e("A")], bugs: [], questions: [] };
  assert.deepEqual(readyBacklog(bare), bare);
});

test("grepBacklog keeps only entries matching the pattern, with parallel arrays", () => {
  const e = (title: string, body = "b") => ({ title, body });
  const view = {
    plans: [e("One widget"), e("Two"), e("Widget three", "body with widget")],
    bugs: [e("Widget bug"), e("Other")],
    questions: [e("Q?"), e("Widget Q")],
    holds: { plans: ["refused" as const, null, null], bugs: [null, null] },
    inProgress: { plans: [null, "feature-2", null], bugs: [null, null] },
  };
  const out = grepBacklog(view, "widget");
  assert.deepEqual(out.plans.map((p) => p.title), ["One widget", "Widget three"]);
  assert.deepEqual(out.holds?.plans, ["refused", null]);
  assert.deepEqual(out.inProgress?.plans, [null, null]);
  assert.deepEqual(out.bugs.map((b) => b.title), ["Widget bug"]);
  assert.deepEqual(out.questions.map((q) => q.title), ["Widget Q"]);
  const bare = { plans: [e("No match")], bugs: [], questions: [] };
  assert.deepEqual(grepBacklog(bare, "widget").plans, []);
  assert.deepEqual(grepBacklog(bare, "No match"), bare);
});

test("tumwater backlog --ready hides held entries and counts them", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "PLANS.md"), [
    "# Plans", "## Planned",
    "### Refused plan (planned 2026-10-03)", "**Refused 2026-10-07 by feature: no**",
    "### Ready plan (planned 2026-10-04)", "body",
    "## Done", "_None._",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "BUGS.md"), [
    "# Bugs", "## Open", "### Real bug (reported 2026-10-02)", "repro", "## Fixed", "_None._",
  ].join("\n"));
  const ok = await runCli(root, "backlog", "--ready");
  assert.equal(ok.code, 0);
  assert.match(ok.out, /### Ready plan/);
  assert.match(ok.out, /### Real bug/);
  assert.doesNotMatch(ok.out, /Refused plan/);
  assert.ok(ok.out.trimEnd().endsWith("_(1 held entries hidden; run `tumwater backlog` to see them)_"));
  const json = JSON.parse((await runCli(root, "backlog", "--ready", "--json")).out);
  assert.equal(json.plans.length, 1);
  assert.deepEqual(json.holds.plans, [null]);
  assert.equal(json.bugs.length, 1);
  fs.writeFileSync(path.join(root, "PLANS.md"), "# Plans\n## Planned\n### Ready plan (planned 2026-10-04)\nbody\n## Done\n_None._\n");
  const none = await runCli(root, "backlog", "--ready");
  assert.doesNotMatch(none.out, /hidden/);
});

test("tumwater backlog --grep keeps only matching entries and composes with --ready and --json", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "PLANS.md"), [
    "# Plans", "## Planned",
    "### Refused plan (planned 2026-10-03)", "**Refused 2026-10-07 by feature: no**",
    "### Ready plan with widget (planned 2026-10-04)", "body",
    "## Done", "_None._",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "BUGS.md"), [
    "# Bugs", "## Open",
    "### Real bug (reported 2026-10-02)", "repro",
    "### Widget bug (reported 2026-10-03)", "repro",
    "## Fixed", "_None._",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "QUESTIONS.md"), [
    "# Questions", "## Open",
    "### Widget question (planned 2026-10-05)", "q",
    "## Answered", "_None._",
  ].join("\n"));
  const md = await runCli(root, "backlog", "--grep", "widget");
  assert.equal(md.code, 0);
  assert.match(md.out, /### Ready plan with widget/);
  assert.match(md.out, /### Widget bug/);
  assert.match(md.out, /### Widget question/);
  assert.doesNotMatch(md.out, /Refused plan/);
  assert.doesNotMatch(md.out, /Real bug/);
  const doc = JSON.parse((await runCli(root, "backlog", "--grep", "widget", "--json")).out) as {
    plans: { title: string }[]; bugs: { title: string }[]; questions: { title: string }[];
  };
  assert.deepEqual(doc.plans.map((p) => p.title), ["Ready plan with widget (planned 2026-10-04)"]);
  assert.deepEqual(doc.bugs.map((b) => b.title), ["Widget bug (reported 2026-10-03)"]);
  assert.deepEqual(doc.questions.map((q) => q.title), ["Widget question (planned 2026-10-05)"]);
  // --grep composes with --ready: only the unheld match stays, and the hidden count counts it.
  fs.writeFileSync(path.join(root, "PLANS.md"), [
    "# Plans", "## Planned",
    "### Refused widget (planned 2026-10-03)", "**Refused 2026-10-07 by feature: no**",
    "### Ready widget (planned 2026-10-04)", "body",
    "## Done", "_None._",
  ].join("\n"));
  const ready = await runCli(root, "backlog", "--grep", "widget", "--ready");
  assert.equal(ready.code, 0);
  assert.match(ready.out, /### Ready widget/);
  assert.doesNotMatch(ready.out, /Refused widget/);
  assert.ok(ready.out.trimEnd().endsWith("_(1 held entries hidden; run `tumwater backlog` to see them)_"));
  // No value, a repeat, and an unknown flag each fail; the unknown names --grep in the list.
  const noValue = await runCli(root, "backlog", "--grep");
  assert.equal(noValue.code, 1);
  assert.match(noValue.out, /backlog --grep needs text/);
  const repeat = await runCli(root, "backlog", "--grep", "a", "--grep", "b");
  assert.equal(repeat.code, 1);
  assert.match(repeat.out, /--grep may only be given once/);
  assert.match((await runCli(root, "backlog", "--bogus")).out, /--grep/);
  // `tumwater help backlog` names --grep.
  assert.match((await runCli(root, "help", "backlog")).out, /backlog \[--ready\] \[--grep <text>\] \[--json\]/);
});

test("renderBacklogMarkdown prints a blocked series as one heading", () => {
  const plan = (title: string) => ({ title, body: `body of ${title}` });
  const base = { bugs: [], questions: [] } as unknown as Parameters<typeof renderBacklogMarkdown>[0];
  const view = (titles: string[], holds: unknown[], inProgress?: (string | null)[]) =>
    renderBacklogMarkdown({
      ...base,
      plans: titles.map(plan),
      holds: { plans: holds, bugs: [] },
      ...(inProgress ? { inProgress: { plans: inProgress, bugs: [] } } : {}),
    } as never);
  const titles = ["Ready", "S, part 1/3: a", "S, part 2/3: b", "S, part 3/3: c", "Other"];
  const holds = [null, null, { blockedBy: ["S 1/3"] }, { blockedBy: ["S 2/3"] }, null];
  const out = view(titles, holds);
  const heading = "### S, 2 blocked parts (2/3–3/3) [blocked: each waits on an earlier part]";
  assert.equal(out.split(heading).length, 2);
  assert.ok(out.includes("  body of Ready") && out.includes("  body of S, part 1/3: a") && out.includes("  body of Other"));
  assert.ok(!out.includes("body of S, part 2/3") && !out.includes("body of S, part 3/3"));
  assert.ok(out.indexOf("body of S, part 1/3") < out.indexOf(heading));
  assert.ok(out.indexOf(heading) < out.indexOf("### Other"));
  assert.match(out, /_\(each blocked series is one heading; /);

  // A claimed part stays a full entry with its mark.
  const claimed = view(titles, holds, [null, null, "feature #2", null, null]);
  assert.match(claimed, /^### S, part 2\/3: b \[blocked: requires S 1\/3\] \[working on it: feature #2\]$/m);
  // A lone blocked part, or a refused second part, groups nothing and adds no footer.
  for (const h of [[null, null, { blockedBy: ["S 1/3"] }, null, null], [null, null, "refused", { blockedBy: ["S 2/3"] }, null]]) {
    const o = view(titles, h);
    assert.ok(!o.includes("blocked parts"));
    assert.ok(!o.includes("each blocked series"));
    assert.ok(o.includes("body of S, part 3/3"));
  }
});

test("tumwater backlog prints a blocked series once; --json still lists every part", async () => {
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    [
      "# Plans", "## Planned",
      "### Ser, part 1/3: a (planned 2026-10-01)", "body1",
      "### Ser, part 2/3: b (planned 2026-10-01; requires Ser 1/3 landed)", "body2",
      "### Ser, part 3/3: c (planned 2026-10-01; requires Ser 2/3 landed)", "body3",
      "## Done", "_None._",
    ].join("\n"),
  );
  const human = await runCli(root, "backlog");
  assert.equal(human.code, 0);
  assert.equal(human.out.split("### Ser, 2 blocked parts (2/3–3/3)").length, 2);
  assert.ok(!human.out.includes("body2"));
  const asJson = await runCli(root, "backlog", "--json");
  const payload = JSON.parse(asJson.out) as { plans: unknown[]; holds: { plans: unknown[] } };
  assert.equal(payload.plans.length, 3);
  assert.equal(payload.holds.plans.length, 3);
});
