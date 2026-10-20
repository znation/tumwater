import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  REPLY_ENDINGS,
  CLAIMS_RULE,
} from "../src/verdict/reply-contract.js";
import {
  DEFAULT_SCOPE,
  ROOT_FROM_WORKTREE,
  TEST_RUNNER_RULE,
  KILL_BY_PID_RULE,
  buildDirectorPrompt,
  buildRunPrompt,
  contextBudgetRule,
} from "../src/prompt/prompt.js";
import {
  PRINCIPLES_MAX_CHARS,
  readPrinciples,
} from "../src/prompt/principles.js";
import { buildResumePrompt } from "../src/prompt/prompt-followup.js";
import { worktreePath } from "../src/paths.js";
import { buildConflictPrompt, buildReviewPrompt } from "../src/prompt/gate-prompts.js";
import { todayStamp } from "../src/budget/budget.js";
import { NOTHING_TO_DO } from "../src/verdict/reply-contract.js";
import { customRole, ROLES, roleById } from "../src/roles/roles.js";
import { searchGuidance } from "../src/roles/role-guidance.js";
import { oneLine } from "./helpers/oracles.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

test("buildRunPrompt includes role, rules, and extras", () => {
  const role = roleById("coverage");
  assert.ok(role);
  const prompt = buildRunPrompt({ role, extraInstructions: "Prefer vitest." });
  assert.match(prompt, /"coverage" role/);
  assert.match(prompt, /Prefer vitest\./);
  assert.match(prompt, new RegExp(NOTHING_TO_DO));
  assert.match(prompt, /SUMMARY:/);
  assert.match(prompt, /ONE focused task/);
});

test("every catalog role produces a prompt mentioning its id", () => {
  for (const role of ROLES) {
    const prompt = buildRunPrompt({ role });
    assert.match(prompt, new RegExp(`"${role.id}" role`));
  }
});

// The role notebook (PLANS.md "Role notebook"): the run prompt shows the role's earlier note
// when there is one, and ALWAYS carries the instruction to write one — the first run has no
// note yet, so an instruction that lived only in the content block would never seed it.
test("a role's run prompt carries the role-notes block only when a note exists", () => {
  const role = roleById("feature")!;
  const withNote = buildRunPrompt({ role, notes: "the scheduler lives in team.ts" });
  assert.match(withNote, /<role-notes>\nthe scheduler lives in team\.ts\n<\/role-notes>/);
  assert.match(withNote, /yours, unverified/);
  for (const empty of [undefined, "", "   \n"]) {
    const prompt = buildRunPrompt({ role, notes: empty });
    assert.ok(!prompt.includes("<role-notes>"), `no block for ${JSON.stringify(empty)}`);
  }
});

test("the role-notes heading says when the notes were last saved", () => {
  const role = roleById("feature")!;
  const render = (notesSavedDay?: string) =>
    buildRunPrompt({ role, notes: "n", notesSavedDay, today: "2026-10-16" });
  assert.match(render("2026-10-16"), /\(last saved today; yours, unverified/);
  assert.match(render("2026-10-15"), /last saved 2026-10-15, 1 day ago; yours, unverified/);
  assert.match(render("2026-09-30"), /last saved 2026-09-30, 16 days ago; yours, unverified/);
  const future = render("2026-10-20");
  assert.match(future, /last saved 2026-10-20; yours/);
  assert.ok(!/2026-10-20, .* ago/.test(future), "no age for a future day");
  const none = render();
  assert.match(none, /\(yours, unverified/);
  assert.ok(!none.includes("last saved"));
  assert.match(none, /today is 2026-10-16|2026-10-16/i, "the date line uses the same day");
});

test("every role run is told to write a note, even the first one with none", () => {
  const role = roleById("feature")!;
  const prompt = buildRunPrompt({ role });
  assert.match(prompt, /tumwater-notes write <<'TUMWATER_NOTES'/);
  assert.match(prompt, /at most 4 KB/);
  assert.ok(!prompt.includes("<role-notes>"), "no note content block when there is no note");
});

test("the director prompt never carries the role-notes block or instruction", () => {
  const prompt = buildDirectorPrompt("do a thing");
  assert.ok(!prompt.includes("role-notes"), "no role-notes block");
  assert.ok(!prompt.includes("role_notes"), "no role_notes tool instruction");
});

// BUGS.md 2026-09-12 (fixed 2026-09-13): an unmatched `find /` issued from inside a
// node_modules-less worktree ran for ~20 min with no output, blocking the whole run until it
// was killed by hand. The rule names the class (unbounded scans above the worktree) and the
// remedy (the borrowed install lives at the repo root). BUGS.md 2026-09-29: the rule also
// keeps every command — the suite above all — out of the primary checkout, whose relative
// path must actually be the repo root (the old "two levels up" named .tumwater/ instead).
test("every run prompt keeps its commands inside the worktree and out of the primary checkout", () => {
  const role = roleById("bugfix");
  assert.ok(role);
  // An npm check: the node_modules borrowing sentence is only true of an npm project — it
  // names the remedy's location (the install at the repo root).
  const prompt = buildRunPrompt({
    role,
    check: { kind: "npm", rootDir: ".", script: "test" },
  });
  assert.match(oneLine(prompt), /Run commands from your worktree \(where you start; `git log` and `git show` work there\)/);
  // Scratch directories stay allowed (qa follows the README in one, bugfix reproduces there).
  assert.match(oneLine(prompt), /or a scratch directory\. Put scratch files under `\$TMPDIR`[^-]*other agents run concurrently on this machine\. - Never cd to the repo root \(`\.\.\/\.\.\/\.\.`\)/);
  assert.match(oneLine(prompt), /it is the primary checkout tumwater merges into — never build, test, or edit files there/);
  assert.match(prompt, /find \/\`/);
  assert.ok(prompt.includes("borrows `../../../node_modules`"), "the install's path from the worktree");
  assert.ok(!prompt.includes("`../../node_modules`"), "not the old path, which named .tumwater/");
  const root = "/home/op/project";
  assert.equal(path.resolve(worktreePath(root, "bugfix"), ROOT_FROM_WORKTREE), root, "the relative root is the repo root");

  // A configured check names the command verbatim, and the npm-only sentence disappears —
  // in a repo with no node_modules anywhere it is false and actively misleading.
  const configured = buildRunPrompt({
    role,
    check: { kind: "command", command: "pytest -q", cwd: "/tmp/repo", timeoutMs: 300_000 },
  });
  assert.match(configured, /verify with `pytest -q`/);
  assert.ok(!configured.includes("node_modules"), "no npm assertion in a non-npm repo's prompt");

  // A gate command: the verify rule names it and tells the agent tumwater runs the full check.
  const gated = buildRunPrompt({
    role,
    check: { kind: "npm", rootDir: ".", script: "test" },
    gateCommand: "npm run test:gate",
  });
  assert.match(gated, /verify with `npm run test:gate`/);
  assert.ok(!gated.includes("verify with `npm run test`"));
  assert.match(oneLine(gated), /Tumwater runs the full check \(`npm run test`\) itself; do not run it\./);
  assert.match(gated, /`<gate> > <scratch-dir>\/check\.log 2>&1`/);

  // No check at all: the generic wording stays, and the npm-only sentence still disappears.
  const none = buildRunPrompt({ role });
  assert.match(none, /if it has a build or test command/);
  assert.ok(!none.includes("node_modules"));
});

test("run and director prompts share one worktree + date preamble", () => {
  const role = roleById("coverage");
  assert.ok(role);
  // Both builders spread sharedPreamble(); a reworded copy in either would fail these
  // includes() checks.
  const shared = [
    "You work in a dedicated git worktree of this project; your changes will be committed and merged to main by tumwater after you finish.",
    "Stamp it on anything you record now",
  ];
  const prompts = [
    buildRunPrompt({ role }),
    buildDirectorPrompt("add dark mode"),
  ];
  for (const prompt of prompts) {
    for (const piece of shared) {
      assert.ok(prompt.includes(piece), `missing shared preamble: ${piece.slice(0, 48)}…`);
    }
  }
});

test("buildDirectorPrompt embeds the user request", () => {
  const prompt = buildDirectorPrompt("add dark mode");
  assert.match(prompt, /<user-request>\nadd dark mode\n<\/user-request>/);
  assert.match(prompt, /SUMMARY:/);
});

// PRINCIPLES.md is the project's codified taste: seeded at init, injected into every run and
// director prompt so all roles share one standard. The injection must be verbatim from the first
// bullet on (the file IS the standard; its own introduction restates the block's heading) and
// bounded (a runaway file cannot blow up every prefill).

test("readPrinciples reads PRINCIPLES.md; empty when missing", () => {
  const dir = tmpdir();
  assert.equal(readPrinciples(dir), "");
  fs.writeFileSync(path.join(dir, "PRINCIPLES.md"), "# Principles\n- prefer small changes\n");
  assert.equal(readPrinciples(dir), "# Principles\n- prefer small changes");
});

test("readPrinciples is empty, not thrown, when PRINCIPLES.md exists but cannot be read", () => {
  // The other half of the "missing or unreadable → ''" contract: a directory where the file is
  // expected stats fine, so existsSync is true, but readFileSync throws (EISDIR). Every run
  // and director prompt injects this file, so a throw here would fail the whole run; the
  // reader must degrade to no principles exactly like a missing file.
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "PRINCIPLES.md"));
  assert.equal(readPrinciples(dir), "");
});

test("readPrinciples clips a runaway file at the cap with a note", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "PRINCIPLES.md"), `# Principles\n${"x".repeat(5000)}`);
  const text = readPrinciples(dir);
  assert.ok(text.length <= PRINCIPLES_MAX_CHARS + 100, "cap plus the truncation note");
  assert.match(text, new RegExp(`truncated at ${PRINCIPLES_MAX_CHARS} chars`));
});

test("run and director prompts inject the principles' bullets verbatim in a <principles> block", () => {
  const role = roleById("coverage");
  assert.ok(role);
  const principles = "# Principles\n- prefer small changes";
  for (const prompt of [
    buildRunPrompt({ role, principles }),
    buildDirectorPrompt("add dark mode", principles),
  ]) {
    assert.ok(prompt.includes("<principles>\n- prefer small changes\n</principles>"));
    assert.match(prompt, /uphold them in everything you produce/);
  }
});

test("prompts omit the <principles> block when the project has none", () => {
  const role = roleById("coverage");
  assert.ok(role);
  for (const prompt of [
    buildRunPrompt({ role }),
    buildDirectorPrompt("add dark mode"),
  ]) {
    assert.ok(!prompt.includes("<principles>"));
  }
});

test("every role prompt keeps PRINCIPLES.md read-only for non-director/steward roles", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildRunPrompt({ role }));
  assert.match(prompt, /PRINCIPLES\.md is read-only to every role but the director and steward/);
  assert.match(prompt, /record an objection to a principle in PLANS\.md/);
});

// Prompt contract for the refusal design (plans/refusal-and-thrash.md): a fresh-session run
// has no memory of an earlier refusal except what the markdown says, so the skip rule and the
// recording shape must ride along in every prompt that picks work or routes decisions.

test("COMMON_RULES carries the Refused-note skip rule for every role", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildRunPrompt({ role }));
  assert.match(prompt, /Skip entries carrying a Refused note: never pick or re-refuse them/);
});

// The director is the only role that can change customRoles — through the harness-mediated
// request file (plans/portability.md §3/7), never by editing tumwater.json. The routing bullet
// names the mechanics; the note scopes the request so a vague request cannot drift into
// retuning timeouts or disabling roles. Role run prompts keep the blanket ban untouched.

// Prompt contract for the questions outbox (plans/questions-outbox.md): every run reads
// QUESTIONS.md first and carries the ask-don't-guess rule; the director routes answers back.
// Same whitespace-collapsed matching as the refusal contract above — the prose is hard-wrapped
// and formatting runs reflow it, so assertions match content, not layout.

// Prompt contract for section-aware run reads: every run
// re-reads the backlog files, so the read-first rule bounds how much of each gets prefilled —
// README in full, PLANS.md/BUGS.md by the index's ranges, and the archive files that hold
// finished entries (plans/backlog-archive.md) never whole: searched, or read one entry by range.

test("every role prompt carries the section-aware read-first rule", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildRunPrompt({ role }));
  // The brief file is named; with no briefFile given it is the README.md compatibility default.
  assert.match(prompt, /First read the project brief \(README\.md\) in full/);
  assert.match(prompt, /plus QUESTIONS\.md when present/);
  // PLANS.md and BUGS.md hold open work, read by the index's ranges.
  assert.match(
    prompt,
    /PLANS\.md and BUGS\.md hold open work: the <backlog-index> block gives each actionable entry with its 1-based line range, so read only the entries you need, by range/,
  );
  // Finished entries live in the archive files, which are never read whole.
  assert.match(prompt, /Finished entries live in PLANS-DONE\.md and BUGS-FIXED\.md, newest first/);
  assert.match(prompt, /Never read those archives whole: grep them, or read one entry by its range/);
  assert.doesNotMatch(prompt, /must see them whole/, "no role reads the archive whole, the steward included");
});

test("both prompt builders name the resolved brief file instead of a hardcoded README.md", () => {
  const role = roleById("feature");
  assert.ok(role);
  const runText = oneLine(buildRunPrompt({ role, briefFile: "TUMWATER.md" }));
  assert.match(runText, /First read the project brief \(TUMWATER\.md\) in full/);
  assert.match(runText, /Never edit the brief block in TUMWATER\.md/);
  assert.ok(!runText.includes("in README.md"), `no README.md left in the rules: ${runText.includes("README.md")}`);

  const director = oneLine(buildDirectorPrompt("add x", undefined, undefined, "TUMWATER.md"));
  assert.match(director, /First read the project brief \(TUMWATER\.md\) in full/);
  assert.match(director, /Never edit the brief block in TUMWATER\.md/);

  // Omitted briefFile keeps the README.md compatibility default in both builders.
  const directorDefault = oneLine(buildDirectorPrompt("add x"));
  assert.match(directorDefault, /First read the project brief \(README\.md\) in full/);
  assert.match(directorDefault, /Never edit the brief block in README\.md/);
});

test("every role prompt carries the ask-don't-guess rule", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildRunPrompt({ role }));
  assert.match(prompt, /do not guess\. Append a question to QUESTIONS\.md under ## Open with context/);
  assert.match(prompt, /Never block on a question/);
});

// Prompt contract for the qa role (plans/qa-role.md): a first-time-user exerciser that never
// edits source — BUGS.md is its only write. Every run is a fresh session with no memory of
// what was tested before, so the find text must carry the flow menu, the vary rule, and the
// once-per-day guard on expensive real runs in prose; these assertions pin that contract.

// Prompt contract for the telemetry role (plans/telemetry-role.md): an observer that reads the
// harness's own event log — injected as a <failure-digest> block because the live log sits at the
// project root, outside its worktree — and files at most one bug in BUGS.md. Every run is a
// fresh session, so the find text must carry the load-bearing rule (a cluster is a bug only when
// the harness's RESPONSE to it is wrong, never merely because the failure happened) and the
// dedup check; these assertions pin that contract.

// Prompt contract for the readme role (PLANS.md "Bound README's status section — state, not
// log"):
// the status section is a state-only snapshot rewritten wholesale on each sync, never appended to,
// so it stays small by construction and cannot drift back into per-run merge narrative. Every
// role reads README.md first, so an unbounded log there would cost every run's prefill forever;
// these assertions pin the contract in the find text. Same whitespace-collapsed matching as above
// —
// the prose is hard-wrapped and formatting runs reflow it, so assertions match content, not
// layout.

// Context-ceiling handling (src/prompt/prompt.ts): half of all autonomous-era runs ended cut off
// at
// the window, almost all of it tool output from reading wholesale. The budget rule rides on
// every run; the resume bridge names the real cause; a fresh run after cut-offs carries a note.

test("every run carries the context-budget rule", () => {
  const runText = buildRunPrompt({ role: ROLES[0]! });
  assert.match(runText, /Everything you read stays in your context until the run ends/);
  assert.match(runText, /Check size first \(`wc -l`\) and read files over ~150 lines in ranges/);
  assert.match(buildDirectorPrompt("do x"), /Everything you read stays in your context until the run ends/);
  // The resume bridge restates the same rule the session's first prompt carried.
  assert.ok(buildResumePrompt("clean").includes(contextBudgetRule()));
});

// Prompt contract for the local-model retune (2026-09-08, Qwen-class ~27B behind a ~258k window):
// the team's transcripts showed roles with no backlog reading the codebase file by file (30+
// whole-file reads, ~300 KB of tool output per run, 277 whole-file reads against 6 ranged ones)
// and merging nothing. The rules now carry numeric budgets and literal commands, the search roles
// carry a shared candidate-hunt procedure, plans are sized to one run, and the reviewer gets a
// checklist plus the harness's own pre-check verdict. These assertions pin that contract. Same
// whitespace-collapsed matching as above.

test("every role prompt states the reading budget in numbers: size check, ranges over ~150 lines, no re-reads", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildRunPrompt({ role }));
  assert.match(prompt, /Check size first \(`wc -l`\)/);
  assert.match(prompt, /read files over ~150 lines in ranges/);
  assert.match(prompt, /Do not re-read what you already saw/);
  // The rule names the cost so the model can budget, and never uses the runner tests' cut-off
  // marker.
  assert.match(prompt, /costs ~5k tokens/);
  assert.doesNotMatch(prompt, /ran out of context/);
});

// Fan-out rule (planned
// 2026-09-23): each assistant turn re-sends the conversation, so turns — not tool calls — are
// the expensive unit. Independent reads/commands go out as sibling tool calls in one turn;
// anything depending on a prior result (an edit and the test that checks it) stays sequential.

test("every role prompt carries the fan-out rule: independent calls share a turn, dependent ones stay sequential", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildRunPrompt({ role }));
  assert.match(prompt, /stays in your context until the run ends and is re-sent on every turn/);
  assert.match(prompt, /Issue lookups that do not depend on each other as separate tool calls in the same turn; keep dependent steps sequential/);
  // Oversized tool results are bounded head+tail by the bundled pi extension; the rule tells
  // the model to follow the marker's pointer instead of retrying the same read.
  assert.match(prompt, /Oversized tool results come back as head\+tail around a marker/);
  assert.match(prompt, /follow the pointer \(re-read with `offset`\/`limit`, or open the full-output file path\)/);
  // The orientation budget is restated in turn terms; the ~15-tool-call pin stays intact.
  assert.match(prompt, /Choose the task within your first ~15 tool calls, in a handful of turns/);
  // The backlog-free roles' search guidance mirrors the same rule.
  const g = oneLine(searchGuidance("clean"));
  assert.match(g, /sibling tool calls in one turn/);
  assert.match(g, /turns, not tool calls, are the expensive unit/);
  assert.match(g, /Decide within ~15 tool calls, in a handful of turns/);
});

test("every role prompt sets a decision deadline and a task-size ceiling", () => {
  const role = roleById("clean");
  assert.ok(role);
  const prompt = oneLine(buildRunPrompt({ role }));
  assert.match(prompt, /Choose the task within your first ~15 tool calls/);
  assert.match(prompt, /more than roughly 60 tool calls, or most of the codebase in view, is too big for one run/);
});

test("organize states its own scope in place of the shared small-task rules; every other role keeps them", () => {
  const organize = roleById("organize");
  assert.ok(organize?.scope, "organize carries a scope override");
  const prompt = oneLine(buildRunPrompt({ role: organize }));
  assert.match(prompt, /yours need not be small or self-contained/);
  assert.match(prompt, /more than roughly 150 tool calls/);
  // Its own Scope section replaces the shared one rather than sitting beside it: the two
  // would contradict each other.
  assert.doesNotMatch(prompt, /Small, complete, and correct beats big and half-done/);
  assert.doesNotMatch(prompt, /more than roughly 60 tool calls/);
  // The decision deadline is not size policy — organize keeps it.
  assert.match(prompt, /Choose the task within your first ~15 tool calls/);
  // A major refactor is allowed but must be argued whole, in the WHY the reviewer checks.
  assert.match(prompt, /a major refactor .* is welcome, but only a well-considered one/);
  assert.match(prompt, /Put those three statements in your WHY/);
  assert.match(prompt, /write it as a plan in PLANS\.md under ## Planned/);

  for (const role of ROLES) {
    if (role.id === "organize") continue;
    assert.equal(role.scope, undefined, `${role.id} uses the shared scope`);
    const p = buildRunPrompt({ role });
    assert.ok(p.includes(DEFAULT_SCOPE), `${role.id} carries DEFAULT_SCOPE verbatim`);
  }
  assert.ok(buildDirectorPrompt("Do a thing.").includes(DEFAULT_SCOPE), "the director keeps the shared scope");
});

test("every role prompt skips the baseline suite run and verifies after the change", () => {
  const role = roleById("dedupe");
  assert.ok(role);
  const prompt = oneLine(buildRunPrompt({ role }));
  assert.match(prompt, /do not run the build or test suite for a baseline/);
  assert.match(prompt, /run it after your change and fix what you broke/);
  assert.match(prompt, /check.log 2>&1/);
  assert.match(prompt, /re-run the check only after an edit changes the tree/);
});

test("every role prompt ends with the reply contract: plain text last, no announced next step, no repeated reads", () => {
  const role = roleById("improve");
  assert.ok(role);
  const prompt = buildRunPrompt({ role });
  const flat = oneLine(prompt);
  assert.match(flat, /Your last message is plain text: never a tool call, and never an announcement of what you would do next/);
  assert.match(flat, /If a tool result only repeats what you already have, do not call it again/);
  // The closing contract is the LAST thing in the prompt — a small model attends to the tail.
  const endSection = prompt.indexOf("How to end your reply");
  assert.ok(endSection > 0, "the ending section exists");
  assert.ok(prompt.indexOf(NOTHING_TO_DO, endSection) > endSection, "sentinel sits in the ending section");
  assert.ok(prompt.indexOf("SUMMARY:", endSection) > endSection, "SUMMARY block sits in the ending section");
  assert.ok(prompt.trimEnd().endsWith("write none when nothing was run>"), "the SUMMARY block closes the prompt");
});

test("the readme role syncs from the git delta since its own last commit", () => {
  const find = oneLine(roleById("readme")!.find);
  assert.match(find, /`git log --oneline <last readme commit>\.\.main` names everything that merged/);
  assert.match(find, /read only what those commits touched/i);
});

// No prompt used to say what day it is (BUGS.md "Roles are never told the date…"), so every
// "(found by … YYYY-MM-DD)" heading, Fixed date, and Needs-review marker was inferred from the
// newest dates in the repo — and the team stamped entries days into the future. Every pi prompt
// now states the local day once; run and director (the roles that write dated records) are also
// told to date them from it. An explicit `today` pins the date so these checks are exact.

test("every run, director, conflict, and review prompt states the given date exactly once", () => {
  const today = "2031-02-03";
  const line = "Today's date is 2031-02-03 (local time).";
  const role = roleById("bugfix");
  assert.ok(role);
  const rolePrompts = [
    buildRunPrompt({ role, today }),
    buildDirectorPrompt("the tui flickers", undefined, undefined, undefined, today),
  ];
  const review = buildReviewPrompt("diff body", undefined, undefined, undefined, undefined, undefined, today);
  const gatePrompts = [buildConflictPrompt("bugfix", ["a.txt"], undefined, undefined, today), review];
  for (const p of [...rolePrompts, ...gatePrompts]) {
    assert.ok(p.includes(line), `missing the date line: ${p.slice(0, 60)}…`);
    assert.equal(p.split("Today's date is").length - 1, 1, "the date is stated once, in one place");
  }
  // The roles that write dated records are told to use it — once, in the shared preamble, so no
  // role text repeats it — and never to infer one from the repo's own (drifting) dates.
  for (const p of rolePrompts) {
    assert.match(
      oneLine(p),
      /Today's date is 2031-02-03 \(local time\)\. Stamp it on anything you record now — a new BUGS\.md heading ends "\(found by the <role> role YYYY-MM-DD\)", a closing date reads "— fixed YYYY-MM-DD by the <role> role", a new PLANS\.md heading reads "\(planned YYYY-MM-DD by the <role> role …\)", and a Refused or Needs-review note carries the date too — and count plan deadlines from it; never infer the date from the repo\./,
    );
  }
  // The verdict contract survives the extra line: still exactly the two advertised forms.
  assert.equal([...review.matchAll(/VERDICT:/g)].length, 2);
});

// BUGS.md 2026-10-05: agents guessed `npx vitest` 19 times in a week in this node:test repo, and
// vitest killed the compiled tests mid-run. Every prompt whose run may run tests says not to: the
// run and director rules (right after the verify bullet), the conflict resolver, and the
// reviewer, with or without a verified pre-check — one shared bullet, stated once in each.
test("every run, director, conflict, and review prompt carries the test-runner rule exactly once", () => {
  const prompts = [
    ...ROLES.map((role) => buildRunPrompt({ role })),
    buildDirectorPrompt("add x"),
    buildConflictPrompt("feature", ["a.txt"]),
    buildReviewPrompt("diff body"),
  ];
  for (const p of prompts) {
    assert.equal(p.split(TEST_RUNNER_RULE).length - 1, 1, `the rule once, verbatim: ${p.slice(0, 60)}…`);
  }
  // Project-neutral: it defers to the declared check or the framework in use, whatever the
  // ecosystem, and its one runner example is framed as a mismatch, not a recommendation.
  assert.match(oneLine(TEST_RUNNER_RULE), /only through the project's declared check or the test framework it already uses/);
  assert.match(oneLine(TEST_RUNNER_RULE), /never a runner you guessed \(say, `npx vitest` in a suite written for node:test\)/);
  const runText = buildRunPrompt({ role: roleById("bugfix")! });
  assert.match(runText, /re-run the check only after an edit changes the tree\.\n- Run tests only through the project's declared check/, "it follows the verify bullet");
});

// BUGS.md 2026-10-18: agents' `pkill -f "npm run test"` and `pkill -f "dist/test/test-runner.js"`
// killed sibling roles' runs and reviews on the shared host. Every prompt whose run may run
// commands says to kill only its own processes by PID: the run rules (assigned or not), the
// director, the conflict resolver, and the reviewer — one shared sentence, stated once in each.
test("every run, director, conflict, and review prompt carries the kill-by-PID rule exactly once", () => {
  const prompts = [
    ...ROLES.map((role) => buildRunPrompt({ role })),
    ...ROLES.map((role) => buildRunPrompt({ role, assigned: true })),
    buildDirectorPrompt("add x"),
    buildConflictPrompt("feature", ["a.txt"]),
    buildReviewPrompt("diff body"),
  ];
  for (const p of prompts) {
    assert.equal(p.split(KILL_BY_PID_RULE).length - 1, 1, `the rule once, verbatim: ${p.slice(0, 60)}…`);
  }
  assert.match(oneLine(KILL_BY_PID_RULE), /Never kill processes by name or pattern \(`pkill`, `killall`, `pgrep … \| xargs kill`\)/);
  assert.match(oneLine(KILL_BY_PID_RULE), /stop only a process you started, by its PID/);
});

test("an omitted date defaults to todayStamp's local day — the daily budget window's own day", () => {
  const role = roleById("feature");
  assert.ok(role);
  // Stamps read on both sides of the builds, so a run straddling local midnight still passes.
  const before = todayStamp();
  const prompts = [
    buildRunPrompt({ role }),
    buildDirectorPrompt("add x"),
    buildConflictPrompt("feature", ["a.txt"]),
    buildReviewPrompt("diff body"),
  ];
  const after = todayStamp();
  for (const p of prompts) {
    assert.ok(
      p.includes(`Today's date is ${before} (local time).`) || p.includes(`Today's date is ${after} (local time).`),
      `no default date line: ${p.slice(0, 60)}…`,
    );
  }
});

// --- User-defined roles (plans/user-defined-loops.md) ---

test("a user-defined role's run prompt identifies it and carries its task as the run task", () => {
  const role = customRole("docs-auditor", "Keep the docs current.");
  const prompt = oneLine(buildRunPrompt({ role }));
  // The title is what identifies the role inside its own prompt and commit context.
  assert.match(prompt, /"docs-auditor" role \(custom role\)/);
  // The task IS the role-specific find-something-to-do text — no catalog prose around it.
  assert.ok(prompt.includes("Keep the docs current."), "the task rides in as the run's task");
  // COMMON_RULES ride along with every run prompt — including the blanket tumwater.json ban
  // (only the director writes that file, and only its customRoles key).
  assert.match(prompt, new RegExp(NOTHING_TO_DO));
  assert.match(prompt, /Never touch the \.tumwater directory or tumwater\.json/);
});

test("customRole yields the pinned shape while built-in prompts keep their catalog titles", () => {
  const custom = customRole("docs-auditor", "Keep the docs current.");
  assert.deepEqual(custom, {
    id: "docs-auditor",
    title: "custom role",
    find: "Keep the docs current.",
    tier: "default",
  });
  // Invariant: built-ins are byte-identical — the customs fallback in runPrompt only fires
  // on a catalog miss, so a built-in's prompt is exactly what the catalog role renders.
  const feature = roleById("feature");
  assert.ok(feature);
  const p = oneLine(buildRunPrompt({ role: feature }));
  assert.match(p, /"feature" role \(feature implementer\)/);
});

// a queued per-role prompt renders as a clearly labeled block
// near the top of the role's task text — steering, not a bypass of the role's own rules.
test("buildRunPrompt renders a per-role user request as a labeled block", () => {
  const role = roleById("qa");
  assert.ok(role);
  const withRequest = buildRunPrompt({ role, userRequest: "check the flow\nend to end" });
  assert.match(withRequest, /An explicit request from the user, aimed at this role/);
  assert.match(withRequest, /<user-request>\ncheck the flow\nend to end\n<\/user-request>/);
  // With nothing queued the block is absent entirely — no empty scaffolding.
  const without = buildRunPrompt({ role });
  assert.ok(!without.includes("<user-request>"));
});

// Claim discipline (2026-10-01): the budgeted model's review record showed false or unchecked
// claims — "untested", "byte-identical", "all references updated", suite counts — as the
// leading
// rejection cause, and edits made after the last green run as the next. Every authoring prompt
// carries the rules, right before the reply contract they govern.
test("every authoring prompt carries the claim-discipline rules ahead of the reply contract", () => {
  for (const role of ROLES) {
    const prompt = buildRunPrompt({ role });
    const flat = oneLine(prompt);
    assert.ok(prompt.includes(CLAIMS_RULE), `${role.id} carries the rules`);
    assert.match(flat, /Claims — a reviewer checks your change against the code before it merges, and an inaccurate claim gets it rejected/);
    assert.match(flat, /a small, correct change is welcome/);
    assert.match(flat, /Back each universal word \("all", "every", "only", "none remain", "untested", "byte-identical", "unchanged"\) with the check that proves it/);
    assert.match(flat, /Never state test or suite counts: say what you ran and what you saw/);
    // No presumption that a check always runs: the run verifies after its last edit itself.
    assert.match(flat, /Verify after your LAST edit, backlog files included: an edit after the last green run is unverified/);
    assert.ok(!flat.includes("tumwater runs the check and attests"), "no claim that a check always runs");
    assert.ok(prompt.indexOf(CLAIMS_RULE) < prompt.indexOf("How to end your reply"), `${role.id}: rules precede the ending`);
  }
  assert.ok(buildDirectorPrompt("add x").includes(CLAIMS_RULE), "the director carries them too");
  assert.ok(!CLAIMS_RULE.includes("VERDICT"), "no review-verdict form outside the review prompt");
});

test("the three endings are one shared list, used by fresh and resumed runs alike", () => {
  const runText = buildRunPrompt({ role: roleById("bugfix")! });
  assert.ok(runText.includes(REPLY_ENDINGS), "run prompt carries the shared list");
  assert.ok(buildDirectorPrompt("x").includes(REPLY_ENDINGS), "director prompt carries it");
  for (const cause of ["restart", "cut-off", "hung-tool", "timeout", "budget-resumed"] as const) {
    const resume = buildResumePrompt("clean", cause);
    assert.ok(resume.trimEnd().endsWith(REPLY_ENDINGS.trimEnd()), `${cause} bridge ends with the shared list`);
  }
  // "End your reply with", not "reply with the single line": the director's answer to a question
  // and qa's FLOW line go above the sentinel.
  const flat = oneLine(REPLY_ENDINGS);
  assert.match(flat, /make no changes, and end your reply with the line TUMWATER_NOTHING_TO_DO — anything your task asks you to report \(an answer, a FLOW line\) goes above it/);
  assert.ok(!flat.includes("reply with the single line"));
});
test("the ask rule has every unassigned role read QUESTIONS.md first and act on an answer", () => {
  const flat = oneLine(buildRunPrompt({ role: roleById("feature")! }));
  assert.match(flat, /First read the project brief \(README\.md\) in full, plus QUESTIONS\.md when present/);
  assert.match(flat, /act on an answer that unblocks your work/);
});
