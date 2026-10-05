import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  REPLY_ENDINGS,
  CLAIMS_RULE,
} from "../src/reply-contract.js";
import {
  ROOT_FROM_WORKTREE,
  TEST_RUNNER_RULE,
  buildDirectorPrompt,
  buildTickPrompt,
} from "../src/prompt.js";
import {
  PRINCIPLES_MAX_CHARS,
  readPrinciples,
} from "../src/principles.js";
import { buildResumePrompt } from "../src/prompt-followup.js";
import { worktreePath } from "../src/paths.js";
import { buildConflictPrompt, buildReviewPrompt } from "../src/gate-prompts.js";
import { todayStamp } from "../src/budget.js";
import { NOTHING_TO_DO } from "../src/reply-contract.js";
import { customRole, ROLES, roleById } from "../src/roles.js";
import { searchGuidance } from "../src/role-guidance.js";
import { oneLine } from "./oracles.js";
import { tmpdir } from "./repo-fixtures.js";

test("buildTickPrompt includes role, project prompt, rules, and extras", () => {
  const role = roleById("coverage");
  assert.ok(role);
  const prompt = buildTickPrompt({ role, initialPrompt: "Make a CLI.", extraInstructions: "Prefer vitest." });
  assert.match(prompt, /"coverage" loop/);
  assert.match(prompt, /Make a CLI\./);
  assert.match(prompt, /Prefer vitest\./);
  assert.match(prompt, new RegExp(NOTHING_TO_DO));
  assert.match(prompt, /SUMMARY:/);
  assert.match(prompt, /ONE focused task/);
});

test("every catalog role produces a prompt mentioning its id", () => {
  for (const role of ROLES) {
    const prompt = buildTickPrompt({ role, initialPrompt: "" });
    assert.match(prompt, new RegExp(`"${role.id}" loop`));
  }
});

// BUGS.md 2026-09-12 (fixed 2026-09-13): an unmatched `find /` issued from inside a
// node_modules-less worktree ran for ~20 min with no output, blocking the whole tick until it
// was killed by hand. The rule names the class (unbounded scans above the worktree) and the
// remedy (the borrowed install lives at the repo root). BUGS.md 2026-09-29: the rule also
// keeps every command — the suite above all — out of the primary checkout, whose relative
// path must actually be the repo root (the old "two levels up" named .tumwater/ instead).
test("every tick prompt keeps its commands inside the worktree and out of the primary checkout", () => {
  const role = roleById("bugfix");
  assert.ok(role);
  // An npm check: the node_modules borrowing sentence is only true of an npm project — it
  // names the remedy's location (the install at the repo root).
  const prompt = buildTickPrompt({
    role,
    initialPrompt: "",
    check: { kind: "npm", rootDir: ".", script: "test" },
  });
  assert.match(prompt, /Stay inside your worktree: run commands from it/);
  // Scratch directories stay allowed (qa follows the README in one, bugfix reproduces there).
  assert.match(oneLine(prompt), /or from a scratch directory under the system temp\. - Never cd to the repo root \(`\.\.\/\.\.\/\.\.`\)/);
  assert.match(oneLine(prompt), /its dist\/ is the code the running fleet executes — never build, test, or edit files in that checkout/);
  assert.match(prompt, /find \/\`/);
  assert.ok(prompt.includes("(`../../../node_modules`)"), "the install's path from the worktree");
  assert.ok(!prompt.includes("`../../node_modules`"), "not the old path, which named .tumwater/");
  const root = "/home/op/project";
  assert.equal(path.resolve(worktreePath(root, "bugfix"), ROOT_FROM_WORKTREE), root, "the relative root is the repo root");

  // A configured check names the command verbatim, and the npm-only sentence disappears —
  // in a repo with no node_modules anywhere it is false and actively misleading.
  const configured = buildTickPrompt({
    role,
    initialPrompt: "",
    check: { kind: "command", command: "pytest -q", cwd: "/tmp/repo", timeoutMs: 300_000 },
  });
  assert.match(configured, /verify with `pytest -q`/);
  assert.ok(!configured.includes("node_modules"), "no npm assertion in a non-npm repo's prompt");

  // No check at all: the generic wording stays, and the npm-only sentence still disappears.
  const none = buildTickPrompt({ role, initialPrompt: "" });
  assert.match(none, /if it has a build or test command/);
  assert.ok(!none.includes("node_modules"));
});

test("tick and director prompts share one worktree + initial-prompt preamble", () => {
  const role = roleById("coverage");
  assert.ok(role);
  // Both builders spread sharedPreamble(initialPrompt); a reworded copy in either would
  // fail these includes() checks.
  const shared = [
    "You work in a dedicated git worktree of this project; your changes will be committed and merged to main by the harness after you finish.",
    "<project-prompt>\nMake a CLI.\n</project-prompt>",
  ];
  const prompts = [
    buildTickPrompt({ role, initialPrompt: "Make a CLI." }),
    buildDirectorPrompt("add dark mode", "Make a CLI."),
  ];
  for (const prompt of prompts) {
    for (const piece of shared) {
      assert.ok(prompt.includes(piece), `missing shared preamble: ${piece.slice(0, 48)}…`);
    }
  }
});

test("buildDirectorPrompt embeds the user request", () => {
  const prompt = buildDirectorPrompt("add dark mode", "Make a CLI.");
  assert.match(prompt, /<user-request>\nadd dark mode\n<\/user-request>/);
  assert.match(prompt, /SUMMARY:/);
});

// PRINCIPLES.md is the project's codified taste: seeded at init, injected into every tick and
// director prompt so all loops share one standard. The injection must be verbatim (the file IS
// the standard) and bounded (a runaway file cannot blow up every prefill).

test("readPrinciples reads PRINCIPLES.md; empty when missing", () => {
  const dir = tmpdir();
  assert.equal(readPrinciples(dir), "");
  fs.writeFileSync(path.join(dir, "PRINCIPLES.md"), "# Principles\n- prefer small changes\n");
  assert.equal(readPrinciples(dir), "# Principles\n- prefer small changes");
});

test("readPrinciples is empty, not thrown, when PRINCIPLES.md exists but cannot be read", () => {
  // The other half of the "missing or unreadable → ''" contract: a directory where the file is
  // expected stats fine, so existsSync is true, but readFileSync throws (EISDIR). Every tick
  // and director prompt injects this file, so a throw here would fail the whole tick; the
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

test("tick and director prompts inject principles verbatim in a <principles> block", () => {
  const role = roleById("coverage");
  assert.ok(role);
  const principles = "# Principles\n- prefer small changes";
  for (const prompt of [
    buildTickPrompt({ role, initialPrompt: "Make a CLI.", principles }),
    buildDirectorPrompt("add dark mode", "Make a CLI.", principles),
  ]) {
    assert.ok(prompt.includes(`<principles>\n${principles}\n</principles>`));
    assert.match(prompt, /uphold them in everything you produce/);
  }
});

test("prompts omit the <principles> block when the project has none", () => {
  const role = roleById("coverage");
  assert.ok(role);
  for (const prompt of [
    buildTickPrompt({ role, initialPrompt: "Make a CLI." }),
    buildDirectorPrompt("add dark mode", "Make a CLI."),
  ]) {
    assert.ok(!prompt.includes("<principles>"));
  }
});

test("every loop prompt keeps PRINCIPLES.md read-only for non-director/steward roles", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = buildTickPrompt({ role, initialPrompt: "" });
  assert.match(prompt, /only the director and steward/);
  assert.match(prompt, /Treat it as read-only/);
});

// Prompt contract for the refusal design (plans/refusal-and-thrash.md): a fresh-session tick
// has no memory of an earlier refusal except what the markdown says, so the skip rule and the
// recording shape must ride along in every prompt that picks work or routes decisions.

test("COMMON_RULES carries the Refused-note skip rule for every role", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  assert.match(prompt, /skip entries carrying a Refused note — do not pick them and do not re-refuse them/);
});

// The director is the only loop that can change customLoops — through the harness-mediated
// request file (plans/portability.md §3/7), never by editing tumwater.json. The routing bullet
// names the mechanics; the note scopes the request so a vague request cannot drift into
// retuning timeouts or disabling roles. Role tick prompts keep the blanket ban untouched.

// Prompt contract for the questions outbox (plans/questions-outbox.md): every tick reads
// QUESTIONS.md first and carries the ask-don't-guess rule; the director routes answers back.
// Same whitespace-collapsed matching as the refusal contract above — the prose is hard-wrapped
// and formatting ticks reflow it, so assertions match content, not layout.

// Prompt contract for section-aware tick reads (PLANS.md, planned 2026-09-04): every tick
// re-reads the backlog files, so the read-first rule bounds how much of each gets prefilled —
// README in full, PLANS.md/BUGS.md only at their actionable tops, older history via git log or
// a targeted read, and a carve-out for the steward, which curates those files whole.

test("every role prompt carries the section-aware read-first rule", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  // The brief file is named; with no briefFile given it is the README.md compatibility default.
  assert.match(prompt, /First read the project brief \(README\.md\) in full/);
  assert.match(prompt, /plus QUESTIONS\.md when present/);
  // PLANS.md and BUGS.md are never read wholesale — their actionable sections come first by
  // template convention, so only the top of each file is read.
  assert.match(prompt, /never read them wholesale/);
  assert.match(prompt, /## Planned before ## Done; ## Open before ## Fixed/);
  assert.match(prompt, /Planned plus recent Done entries, Open plus recent Fixed ones/);
  // Older history is consulted only when a specific entry is needed.
  assert.match(
    prompt,
    /Consult older history via git log or a targeted read only when a specific entry is needed/,
  );
  // The steward curates those files and must see them whole.
  assert.match(prompt, /The steward role is the exception: it curates those files and must see them whole/);
});

test("both prompt builders name the resolved brief file instead of a hardcoded README.md", () => {
  const role = roleById("feature");
  assert.ok(role);
  const tick = oneLine(buildTickPrompt({ role, initialPrompt: "", briefFile: "TUMWATER.md" }));
  assert.match(tick, /First read the project brief \(TUMWATER\.md\) in full/);
  assert.match(tick, /Never edit the initial prompt block in TUMWATER\.md/);
  assert.ok(!tick.includes("in README.md"), `no README.md left in the rules: ${tick.includes("README.md")}`);

  const director = oneLine(buildDirectorPrompt("add x", "a project", undefined, undefined, "TUMWATER.md"));
  assert.match(director, /First read the project brief \(TUMWATER\.md\) in full/);
  assert.match(director, /Never edit the initial prompt block in TUMWATER\.md/);

  // Omitted briefFile keeps the README.md compatibility default in both builders.
  const directorDefault = oneLine(buildDirectorPrompt("add x", "a project"));
  assert.match(directorDefault, /First read the project brief \(README\.md\) in full/);
  assert.match(directorDefault, /Never edit the initial prompt block in README\.md/);
});

test("every role prompt carries the ask-don't-guess rule", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  assert.match(prompt, /do not guess: append a question to QUESTIONS\.md under ## Open with context/);
  assert.match(prompt, /Never block on an unanswered question/);
});

// Prompt contract for the qa role (plans/qa-role.md): a first-time-user exerciser that never
// edits source — BUGS.md is its only write. Every tick is a fresh session with no memory of
// what was tested before, so the find text must carry the flow menu, the vary rule, and the
// once-per-day guard on expensive real runs in prose; these assertions pin that contract.

// Prompt contract for the telemetry role (plans/telemetry-role.md): an observer that reads the
// harness's own event log — injected as a <failure-digest> block because the live log sits at the
// project root, outside its worktree — and files at most one bug in BUGS.md. Every tick is a
// fresh session, so the find text must carry the load-bearing rule (a cluster is a bug only when
// the harness's RESPONSE to it is wrong, never merely because the failure happened) and the
// dedup check; these assertions pin that contract.

// Prompt contract for the readme role (PLANS.md "Bound README's status section — state, not log"):
// the status section is a state-only snapshot rewritten wholesale on each sync, never appended to,
// so it stays small by construction and cannot drift back into per-tick landing narrative. Every
// loop reads README.md first, so an unbounded log there would cost every tick's prefill forever;
// these assertions pin the contract in the find text. Same whitespace-collapsed matching as above —
// the prose is hard-wrapped and formatting ticks reflow it, so assertions match content, not layout.

// Context-ceiling handling (src/prompt.ts): half of all autonomous-era ticks ended cut off at
// the window, almost all of it tool output from reading wholesale. The budget rule rides on
// every run; the resume bridge names the real cause; a fresh tick after cut-offs carries a note.

test("every run carries the context-budget rule", () => {
  const tick = buildTickPrompt({ role: ROLES[0]!, initialPrompt: "x" });
  assert.match(tick, /context window is finite/);
  assert.match(tick, /check size before reading \(`wc -l`\) and read\s+files over ~300 lines in ranges/i);
  assert.match(buildDirectorPrompt("do x", "x"), /context window is finite/);
  assert.match(buildResumePrompt("clean"), /context window is finite/);
});


// Prompt contract for the local-model retune (2026-09-08, Qwen-class ~27B behind a ~258k window):
// the fleet's transcripts showed roles with no backlog reading the codebase file by file (30+
// whole-file reads, ~300 KB of tool output per tick, 277 whole-file reads against 6 ranged ones)
// and landing nothing. The rules now carry numeric budgets and literal commands, the search roles
// carry a shared candidate-hunt procedure, plans are sized to one run, and the reviewer gets a
// checklist plus the harness's own pre-check verdict. These assertions pin that contract. Same
// whitespace-collapsed matching as above.

test("every role prompt states the reading budget in numbers: size check, ranges over ~300 lines, no re-reads", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  assert.match(prompt, /check size before reading \(`wc -l`\)/i);
  assert.match(prompt, /read files over ~300 lines in ranges/);
  assert.match(prompt, /re-read only a region you edited/);
  // The rule names the cost so the model can budget, and never uses the loop tests' cut-off marker.
  assert.match(prompt, /costs ~5k tokens/);
  assert.doesNotMatch(prompt, /ran out of context/);
});

// Fan-out rule (PLANS.md "Tell ticks to fan out independent tool calls in one turn", planned
// 2026-09-23): each assistant turn re-sends the conversation, so turns — not tool calls — are
// the expensive unit. Independent reads/commands go out as sibling tool calls in one turn;
// anything depending on a prior result (an edit and the test that checks it) stays sequential.

test("every role prompt carries the fan-out rule: independent calls share a turn, dependent ones stay sequential", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  assert.match(prompt, /Each turn re-sends everything read so far/);
  assert.match(prompt, /lookups that do not depend on each other .* as separate tool calls in the same turn/);
  assert.match(prompt, /do not batch an edit with the test that checks it/);
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
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  assert.match(prompt, /Choose the task within your first ~15 tool calls/);
  assert.match(prompt, /more than roughly 60 tool calls, or most of the codebase in view, is too big for one run/);
});

test("every role prompt skips the baseline suite run and verifies after the change", () => {
  const role = roleById("dry");
  assert.ok(role);
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  assert.match(prompt, /do not run the build or test suite just to establish a baseline/);
  assert.match(prompt, /run it after your change and fix what you broke/);
  assert.match(prompt, /Pipe its output through `tail`/);
});

test("every role prompt ends with the reply contract: plain text last, no announced next step, no repeated reads", () => {
  const role = roleById("improve");
  assert.ok(role);
  const prompt = buildTickPrompt({ role, initialPrompt: "" });
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
  assert.match(find, /`git log --oneline <last readme commit>\.\.main` names everything that landed/);
  assert.match(find, /read only what those commits touched/i);
});

// No prompt used to say what day it is (BUGS.md "Loops are never told the date…"), so every
// "(found by … YYYY-MM-DD)" heading, Fixed date, and Needs-review marker was inferred from the
// newest dates in the repo — and the fleet stamped entries days into the future. Every pi prompt
// now states the local day once; tick and director (the roles that write dated records) are also
// told to date them from it. An explicit `today` pins the date so these checks are exact.

test("every tick, director, conflict, and review prompt states the given date exactly once", () => {
  const today = "2031-02-03";
  const line = "Today's date is 2031-02-03 (local time).";
  const role = roleById("bugfix");
  assert.ok(role);
  const loopPrompts = [
    buildTickPrompt({ role, initialPrompt: "Make a CLI.", today }),
    buildDirectorPrompt("the tui flickers", "Make a CLI.", undefined, undefined, undefined, today),
  ];
  const review = buildReviewPrompt("diff body", undefined, undefined, undefined, undefined, undefined, today);
  const gatePrompts = [buildConflictPrompt("bugfix", ["a.txt"], undefined, today), review];
  for (const p of [...loopPrompts, ...gatePrompts]) {
    assert.ok(p.includes(line), `missing the date line: ${p.slice(0, 60)}…`);
    assert.equal(p.split("Today's date is").length - 1, 1, "the date is stated once, in one place");
  }
  // The roles that write dated records are told to use it — once, in the shared preamble, so no
  // role text repeats it — and never to infer one from the repo's own (drifting) dates.
  for (const p of loopPrompts) {
    assert.match(
      oneLine(p),
      /Today's date is 2031-02-03 \(local time\)\. Stamp it on anything you record now — a new BUGS\.md or PLANS\.md heading's "\(found by … YYYY-MM-DD\)", a Fixed or Done date, a Refused or Needs-review note — and count plan deadlines from it; never infer the date from the repo\./,
    );
  }
  // The verdict contract survives the extra line: still exactly the two advertised forms.
  assert.equal([...review.matchAll(/VERDICT:/g)].length, 2);
});

// BUGS.md 2026-10-05: agents guessed `npx vitest` 19 times in a week in this node:test repo, and
// vitest killed the compiled tests mid-run. Every prompt whose run may run tests says not to: the
// tick and director rules (right after the verify bullet), the conflict resolver, and the
// reviewer, with or without a verified pre-check — one shared bullet, stated once in each.
test("every tick, director, conflict, and review prompt carries the test-runner rule exactly once", () => {
  const prompts = [
    ...ROLES.map((role) => buildTickPrompt({ role, initialPrompt: "" })),
    buildDirectorPrompt("add x", "a project"),
    buildConflictPrompt("feature", ["a.txt"]),
    buildReviewPrompt("diff body"),
    buildReviewPrompt("diff body", undefined, undefined, undefined, undefined, "`npm run test` passed"),
  ];
  for (const p of prompts) {
    assert.equal(p.split(TEST_RUNNER_RULE).length - 1, 1, `the rule once, verbatim: ${p.slice(0, 60)}…`);
  }
  // Project-neutral: it defers to the declared check or the framework in use, whatever the
  // ecosystem, and its one runner example is framed as a mismatch, not a recommendation.
  assert.match(oneLine(TEST_RUNNER_RULE), /only through the project's declared check or the test framework it already uses/);
  assert.match(oneLine(TEST_RUNNER_RULE), /never a runner you guessed \(say, `npx vitest` in a suite written for node:test\)/);
  const tick = buildTickPrompt({ role: roleById("bugfix")!, initialPrompt: "" });
  assert.match(tick, /only the failures matter\.\n- Run tests only through the project's declared check/, "it follows the verify bullet");
});

test("an omitted date defaults to todayStamp's local day — the daily budget window's own day", () => {
  const role = roleById("feature");
  assert.ok(role);
  // Stamps read on both sides of the builds, so a run straddling local midnight still passes.
  const before = todayStamp();
  const prompts = [
    buildTickPrompt({ role, initialPrompt: "" }),
    buildDirectorPrompt("add x", "a project"),
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

// --- User-defined loops (plans/user-defined-loops.md, PLANS.md "User-defined loops 1/3") ---

test("a user-defined loop's tick prompt identifies it and carries its task as the run task", () => {
  const role = customRole("docs-auditor", "Keep the docs current.");
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  // The title is what identifies the loop inside its own prompt and commit context.
  assert.match(prompt, /"docs-auditor" loop \(user-defined loop\)/);
  // The task IS the role-specific find-something-to-do text — no catalog prose around it.
  assert.ok(prompt.includes("Keep the docs current."), "the task rides in as the run's task");
  // COMMON_RULES ride along with every tick prompt — including the blanket tumwater.json ban
  // (only the director writes that file, and only its customLoops key).
  assert.match(prompt, new RegExp(NOTHING_TO_DO));
  assert.match(prompt, /Never touch the \.tumwater directory or tumwater\.json/);
});

test("customRole yields the pinned shape while built-in prompts keep their catalog titles", () => {
  const custom = customRole("docs-auditor", "Keep the docs current.");
  assert.deepEqual(custom, { id: "docs-auditor", title: "user-defined loop", find: "Keep the docs current." });
  // Invariant: built-ins are byte-identical — the customs fallback in tickPrompt only fires
  // on a catalog miss, so a built-in's prompt is exactly what the catalog role renders.
  const feature = roleById("feature");
  assert.ok(feature);
  const p = oneLine(buildTickPrompt({ role: feature, initialPrompt: "" }));
  assert.match(p, /"feature" loop \(feature implementer\)/);
});

// PLANS.md "Per-role prompts 1/2": a queued per-role prompt renders as a clearly labeled block
// near the top of the role's task text — steering, not a bypass of the role's own rules.
test("buildTickPrompt renders a per-role user request as a labeled block", () => {
  const role = roleById("qa");
  assert.ok(role);
  const withRequest = buildTickPrompt({ role, initialPrompt: "", userRequest: "check the flow\nend to end" });
  assert.match(withRequest, /An explicit request from the user, aimed at this loop/);
  assert.match(withRequest, /<user-request>\ncheck the flow\nend to end\n<\/user-request>/);
  // With nothing queued the block is absent entirely — no empty scaffolding.
  const without = buildTickPrompt({ role, initialPrompt: "" });
  assert.ok(!without.includes("<user-request>"));
});

// Claim discipline (2026-10-01): the budgeted model's review record showed false or unchecked
// claims — "untested", "byte-identical", "all references updated", suite counts — as the leading
// rejection cause, and edits made after the last green run as the next. Every authoring prompt
// carries the rules, right before the reply contract they govern.
test("every authoring prompt carries the claim-discipline rules ahead of the reply contract", () => {
  for (const role of ROLES) {
    const prompt = buildTickPrompt({ role, initialPrompt: "" });
    const flat = oneLine(prompt);
    assert.ok(prompt.includes(CLAIMS_RULE), `${role.id} carries the rules`);
    assert.match(flat, /keep what your change says about itself accurate\. Code changes are checked against the code by an adversarial reviewer/);
    assert.match(flat, /a small, correct change is welcome/);
    assert.match(flat, /Back each universal word — "all", "every", "only", "none remain", "untested", "byte-identical"/);
    assert.match(flat, /Never state test or suite counts: say what you ran and what you saw/);
    // No presumption that a check or a reviewer exists: verification points at the check-aware
    // "Leave the project working" bullet, and a doc-only diff skips the review gate.
    assert.match(flat, /Verify after your LAST edit, per "Leave the project working" above/);
    assert.ok(!flat.includes("the harness runs the check and attests"), "no claim that a check always runs");
    assert.ok(prompt.indexOf(CLAIMS_RULE) < prompt.indexOf("How to end your reply"), `${role.id}: rules precede the ending`);
  }
  assert.ok(buildDirectorPrompt("add x", "a project").includes(CLAIMS_RULE), "the director carries them too");
  assert.ok(!CLAIMS_RULE.includes("VERDICT"), "no review-verdict form outside the review prompt");
});

test("the three endings are one shared list, used by fresh and resumed runs alike", () => {
  const tick = buildTickPrompt({ role: roleById("bugfix")!, initialPrompt: "" });
  assert.ok(tick.includes(REPLY_ENDINGS), "tick prompt carries the shared list");
  assert.ok(buildDirectorPrompt("x", "y").includes(REPLY_ENDINGS), "director prompt carries it");
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
test("the ask rule tells every loop to check QUESTIONS.md for answers at the start of each tick", () => {
  const flat = oneLine(buildTickPrompt({ role: roleById("feature")!, initialPrompt: "" }));
  assert.match(flat, /check QUESTIONS\.md for answers at the start of each tick and act on one that unblocks your work/);
});
