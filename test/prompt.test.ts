import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  PRINCIPLES_MAX_CHARS,
  buildConflictPrompt,
  buildDirectorPrompt,
  buildRejectedReviewNote,
  buildResumePrompt,
  buildTickPrompt,
  buildReviewPrompt,
  readPrinciples,
} from "../src/prompt.js";
import { parseVerdict } from "../src/review.js";
import { NOTHING_TO_DO } from "../src/reply-contract.js";
import { PROMPT_END, PROMPT_START, readInitialPrompt, readmeTemplate } from "../src/readme.js";
import { DECOMPOSITION_GUIDANCE, ROLES, roleById } from "../src/roles.js";
import { tmpdir } from "./util.js";

test("readInitialPrompt extracts the managed block", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "README.md"), readmeTemplate("proj", "Build a thing.\nWith care."));
  assert.equal(readInitialPrompt(dir), "Build a thing.\nWith care.");
});

test("readInitialPrompt is empty without README or markers", () => {
  const dir = tmpdir();
  assert.equal(readInitialPrompt(dir), "");
  fs.writeFileSync(path.join(dir, "README.md"), "# hi\n");
  assert.equal(readInitialPrompt(dir), "");
});

// The README is edited live (readme loop, users) and read on every tick: a torn or
// hand-edited file that keeps only one marker must degrade to no prompt, not leak the
// rest of the file into every tick's prompt.

test("readInitialPrompt returns empty when only one marker survives", () => {
  const dir = tmpdir();
  // Only the start marker: without the end-marker guard, slice would return everything
  // after it (indexOf(PROMPT_END) is -1).
  fs.writeFileSync(
    path.join(dir, "README.md"),
    `# hi\n${PROMPT_START}\nthe rest of the readme must not be treated as the prompt\n`,
  );
  assert.equal(readInitialPrompt(dir), "");
  // Only the end marker: padding past index 34 keeps this observable — a dropped
  // start-marker guard would slice out the body text instead of returning empty.
  fs.writeFileSync(path.join(dir, "README.md"), `# hi\n${"LEAKED ".repeat(5)}${PROMPT_END}\n`);
  assert.equal(readInitialPrompt(dir), "");
});

test("readInitialPrompt returns empty when the markers are reversed", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "README.md"), `# hi\n${PROMPT_END}\nsome text\n${PROMPT_START}\n`);
  assert.equal(readInitialPrompt(dir), "");
});

// An end marker mentioned in prose BEFORE the managed block (e.g. README docs explaining how
// to edit the prompt) must not shadow the real section: pre-fix, indexOf(PROMPT_END) found the
// prose mention first, `end < start` bailed out, and every loop ran without its project prompt.
test("readInitialPrompt ignores an end marker that appears before the managed block", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "README.md"),
    `# proj\n\nThe managed section is closed by ${PROMPT_END} — edit only between the markers.\n\n## Initial prompt\n${PROMPT_START}\nThe real prompt.\n${PROMPT_END}\n`,
  );
  assert.equal(readInitialPrompt(dir), "The real prompt.");
});

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

test("buildDirectorPrompt routes work to the specialist loops instead of implementing", () => {
  const prompt = buildDirectorPrompt("add dark mode", "Make a CLI.");
  assert.match(prompt, /project-level command/);
  assert.match(prompt, /do NOT implement substantial\nwork yourself/);
  assert.match(prompt, /plan for it in PLANS\.md/);
  assert.match(prompt, /record it in BUGS\.md/);
  assert.match(prompt, /Do not build\n {2}it now/);
  assert.match(prompt, /Do not fix it now/);
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

test("director routing records standing guidance in PRINCIPLES.md first", () => {
  const prompt = buildDirectorPrompt("prefer no third-party deps", "a project");
  assert.match(prompt, /PRINCIPLES\.md first for standing design guidance and taste/);
});

test("the readme role leaves PRINCIPLES.md to the director and steward", () => {
  const role = roleById("readme");
  assert.ok(role);
  assert.match(role.find, /but not\nPRINCIPLES\.md, which only the director and steward edit/);
});

// The resume prompt is sent into the SAME pi session as an interrupted run, which already
// carries the original prompt and work — so it only bridges the gap. Its contract matters:
// without the restated sentinel/SUMMARY rules the harness could not parse a resumed tick's end.

test("buildResumePrompt tells the resumed session to finish the same task", () => {
  const p = buildResumePrompt("feature");
  // Names the role and explains why this run is different: a restart mid-run, with the
  // worktree left exactly as it was.
  assert.match(p, /"feature"/);
  assert.match(p, /restarted/i);
  // A tool call may have been cut off by the restart — verify its effect before relying on it.
  assert.match(p, /verify its effect/i);
  // Continue the interrupted task rather than picking a new one.
  assert.match(p, /Continue the SAME task/);
  // The harness contract that lets a resumed tick end cleanly is restated: one focused
  // task, no git commits by pi, and the sentinel + SUMMARY line the harness parses.
  assert.match(p, /ONE focused task/);
  assert.match(p, /Never create, amend, or revert git commits/);
  assert.ok(p.includes(NOTHING_TO_DO));
  assert.ok(
    p.includes("SUMMARY: <imperative one-line description of the change, at most 72 characters>"),
  );
});

test("buildResumePrompt differs across roles only in the role name", () => {
  const a = buildResumePrompt("feature");
  const b = buildResumePrompt("clean").replaceAll('"clean"', '"feature"');
  assert.equal(b, a, "no per-role drift in the bridge instructions");
});

// The conflict prompt drives pi's one-shot merge-conflict resolution run. Its contract is
// load-bearing in ways the loop-level fake-pi tests cannot see (the fake ignores prompt
// content): pi must know exactly which files hold markers, what "ours"/"theirs" mean, and —
// critically — that it may not touch git state itself, or its own commit/rebase would collide
// with the harness's continueRebase.

test("buildConflictPrompt names the role and lists every conflicted file", () => {
  const p = buildConflictPrompt("bugfix", ["src/git.ts", "docs/notes.md"]);
  assert.match(p, /"bugfix" loop/);
  // The situation is explained: a rebase onto main stopped on conflicts in the worktree.
  assert.match(p, /A rebase of\nyour work branch onto main stopped on conflicts/);
  // Every conflicted file is listed as its own bullet so pi knows exactly where to look —
  // the harness later re-checks markers in precisely these files.
  assert.ok(
    p.includes("Conflicted files:\n- src/git.ts\n- docs/notes.md"),
    "each conflicted file on its own line",
  );
});

test("buildConflictPrompt defines ours/theirs and asks for a combined resolution", () => {
  const p = buildConflictPrompt("feature", ["a.txt"]);
  // Picking the wrong side silently drops work: the prompt must define which side is which.
  assert.match(p, /"ours" is this branch's change/);
  assert.match(p, /"theirs" is the latest main/);
  assert.match(p, /combining the intent of BOTH sides/i);
});

test("buildConflictPrompt forbids state-changing git commands (harness concludes the rebase)", () => {
  const p = buildConflictPrompt("clean", ["a.txt"]);
  // If pi committed or continued the rebase itself, the harness's continueRebase would
  // collide with it — the prompt keeps pi to file edits only.
  assert.match(p, /Edit files only/);
  assert.match(p, /no add, commit, merge, rebase/);
  assert.match(p, /the harness concludes the rebase for you/i);
  // Reading git state stays allowed — resolving well may need it.
  assert.match(p, /Reading git state is fine/i);
});

test("buildConflictPrompt keeps the project building and ends by stopping", () => {
  const p = buildConflictPrompt("improve", ["a.txt"]);
  // The harness only re-checks conflict markers after this run; keeping the build green
  // is pi's own diligence, so the prompt must ask for it.
  assert.match(p, /Keep the project building and its tests passing/);
  // The run's only job is resolving the markers: it ends by stopping — no new task,
  // no sentinel or SUMMARY line (this flow parses neither from pi's reply).
  assert.match(p, /just stop/i);
  assert.ok(!p.includes(NOTHING_TO_DO), "no tick sentinel in a conflict run");
});

// The rejected-review note is the ONLY cross-tick memory of a failed change: every tick
// starts a fresh pi session, so if this note loses or mangles the reviewer's reasons the
// author loop retries the same rejected work with no idea why it was refused.

test("buildRejectedReviewNote carries every reason, numbered in order", () => {
  const note = buildRejectedReviewNote(["violates zero-deps principle", "half-done: no tests"]);
  assert.match(note, /rejected in review/);
  assert.ok(note.includes("1. violates zero-deps principle\n2. half-done: no tests"), "numbered list");
  assert.match(note, /Address the objections or take a different approach/);
});

test("buildRejectedReviewNote degrades to a placeholder when no reasons were recorded", () => {
  const note = buildRejectedReviewNote([]);
  assert.ok(note.includes("(no reasons recorded)"), "says so rather than listing nothing");
  assert.match(note, /rejected in review/);
});

test("director routing includes the shared decomposition guidance", () => {
  const prompt = buildDirectorPrompt("add import and export features", "a project");
  assert.ok(prompt.includes(DECOMPOSITION_GUIDANCE));
  assert.match(prompt, /independent subparts/);
  assert.match(prompt, /keep a single entry/);
});

test("plan and bugfix role prompts include the shared decomposition guidance", () => {
  for (const id of ["plan", "bugfix"]) {
    const role = roleById(id);
    assert.ok(role, `role ${id} exists`);
    const prompt = buildTickPrompt({ role, initialPrompt: "" });
    assert.ok(prompt.includes(DECOMPOSITION_GUIDANCE), `${id} prompt carries the guidance`);
  }
});

test("the perf role hunts measured wins and refuses speculative micro-optimization", () => {
  const role = roleById("perf");
  assert.ok(role, "perf role exists");
  assert.equal(role.title, "performance optimizer");
  const prompt = buildTickPrompt({ role, initialPrompt: "" });
  assert.match(prompt, /"perf" loop/);
  assert.match(prompt, /CLEAR performance win/);
  assert.match(prompt, /measure or reason from actual data/);
  assert.match(prompt, /Do NOT micro-optimize cold paths/);
  assert.match(prompt, /nothing to do/);
});

test("guidance is a single shared constant, not drifting copies", () => {
  // Both consumers embed the exported constant verbatim; a reworded copy would fail the
  // includes() checks above. This guards the constant itself against becoming trivial.
  assert.ok(DECOMPOSITION_GUIDANCE.length > 100);
  assert.match(DECOMPOSITION_GUIDANCE, /cross-references/);
});

// Prompt contract for the refusal design (plans/refusal-and-thrash.md): a fresh-session tick
// has no memory of an earlier refusal except what the markdown says, so the skip rule and the
// recording shape must ride along in every prompt that picks work or routes decisions.
// The prose is hard-wrapped and formatting ticks reflow it, so assertions match content with
// whitespace collapsed — a phrase wrapped across lines must not break a contract check (the
// first landing of these tests did exactly that: four red unit tests on main).

const oneLine = (s: string) => s.replace(/\s+/g, " ");

test("COMMON_RULES carries the Refused-note skip rule for every role", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  assert.match(prompt, /skip entries carrying a Refused note — do not pick them and do not re-refuse them/);
});

test("the feature find text refuses rather than forces and skips refused plans", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  assert.match(prompt, /A plan that resists implementation is a finding/);
  assert.match(prompt, /refuse it with the objection recorded rather than forcing it/);
  assert.match(prompt, /Skip plans whose entry carries a Refused note/);
});

test("the bugfix find text refuses harmful fixes and skips refused bugs", () => {
  const role = roleById("bugfix");
  assert.ok(role);
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  assert.match(prompt, /A "bug" whose fix would harm the project is refused, not force-fixed/);
  assert.match(prompt, /Skip BUGS\.md entries carrying a Refused note/);
});

test("the director routes refusal decisions by clearing the Refused note", () => {
  const prompt = oneLine(buildDirectorPrompt("clear the refusal on plan X", "a project"));
  assert.match(prompt, /A decision about a refused entry/);
  assert.match(prompt, /clear its \*\*Refused …\*\* note from PLANS\.md\/BUGS\.md/);
  assert.match(prompt, /so loops can pick it up again/);
});

// Prompt contract for the questions outbox (plans/questions-outbox.md): every tick reads
// QUESTIONS.md first and carries the ask-don't-guess rule; the director routes answers back.
// Same whitespace-collapsed matching as the refusal contract above — the prose is hard-wrapped
// and formatting ticks reflow it, so assertions match content, not layout.

test("every role prompt lists QUESTIONS.md in the read-first list", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  assert.match(prompt, /First read README\.md, PLANS\.md, BUGS\.md, and QUESTIONS\.md/);
});

test("every role prompt carries the ask-don't-guess rule", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  assert.match(prompt, /do not guess: append a question to QUESTIONS\.md under ## Open with context/);
  assert.match(prompt, /Never block on an unanswered question/);
});

test("the director routes answers back by moving the entry to Answered verbatim", () => {
  const prompt = oneLine(buildDirectorPrompt("answer Q3: choose SQLite", "a project"));
  assert.match(prompt, /An answer to an open question/);
  assert.match(prompt, /to ## Answered verbatim with the decision recorded/);
});

// Prompt contract for the review gate (src/review.ts): the reviewer is told to end with
// exactly one VERDICT line, and a reply without a parseable line fails the review closed —
// three such failures discard the commit. If the form the prompt advertises ever drifts from
// what parseVerdict accepts, every real merge starts failing; no e2e test can catch it because
// the fake pi emits whatever the test tells it to.

test("buildReviewPrompt advertises exactly the verdict forms parseVerdict accepts", () => {
  const prompt = oneLine(buildReviewPrompt("diff body"));
  assert.match(prompt, /End your reply with exactly one line in this form/);
  // The instruction names both forms as line-start "VERDICT: <word>" tokens — nothing else.
  const advertised = [...prompt.matchAll(/VERDICT:\s*(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(advertised, ["approve", "reject"]);
  // A reply written exactly as instructed — preamble, the final line in the advertised form,
  // then numbered reasons — must parse to that verdict with its reasons in order.
  for (const v of ["approve", "reject"]) {
    const reply = `I checked the diff against the principles.\nVERDICT: ${v}\n1. build passes\n2. no new deps`;
    assert.deepEqual(parseVerdict(reply), { verdict: v, reasons: ["build passes", "no new deps"] });
  }
});

test("buildReviewPrompt embeds diff, summary, commit body, and principles verbatim", () => {
  const prompt = buildReviewPrompt(
    "diff-body-marker",
    "summary-marker",
    "body-marker",
    "principles-marker",
  );
  assert.ok(prompt.includes("<diff>\ndiff-body-marker\n</diff>"));
  assert.match(prompt, /The author's summary of the change:\nsummary-marker/);
  assert.match(prompt, /claimed motivation, risk, verification — check these claims against the diff\):\nbody-marker/);
  assert.ok(prompt.includes("<principles>\nprinciples-marker\n</principles>"));
});

test("buildReviewPrompt omits optional sections when their arguments are absent", () => {
  const prompt = buildReviewPrompt("diff-only");
  assert.ok(!prompt.includes("The author's summary of the change:"), "no empty summary section");
  assert.ok(!prompt.includes("The author's commit body"), "no empty commit-body section");
  assert.ok(!prompt.includes("<principles>"), "no principles block without a file");
});

// Prompt contract for the qa role (plans/qa-role.md): a first-time-user exerciser that never
// edits source — BUGS.md is its only write. Every tick is a fresh session with no memory of
// what was tested before, so the find text must carry the flow menu, the vary rule, and the
// once-per-day guard on expensive real runs in prose; these assertions pin that contract.

const qa = roleById("qa");

test("the qa role exists after perf in catalog order", () => {
  assert.ok(qa, "roleById('qa') returns a role");
  const ids = ROLES.map((r) => r.id);
  assert.equal(ids[ids.indexOf("perf") + 1], "qa", "qa sits right after perf (tie-break priority)");
  assert.equal(qa.title, "product QA");
});

test("the qa prompt is a first-time-user exercise of the README in a scratch dir", () => {
  const find = qa!.find;
  assert.match(find, /first-time user/);
  assert.match(find, /README's usage instructions literally/);
  assert.match(find, /scratch directory under the system temp/);
  assert.match(find, /never inside this worktree or \.tumwater\//);
  assert.match(find, /build the product fresh per its README/);
  assert.match(find, /endpoints via curl/);
  assert.match(find, /check outputs against what the docs promise/);
  assert.match(find, /Delete the scratch dir when the flow is done/);
});

test("the qa prompt restricts writes to BUGS.md", () => {
  const find = qa!.find;
  assert.match(find, /record ONE reproducible bug in BUGS\.md/);
  assert.match(find, /exact commands, expected vs actual/);
  assert.match(find, /never edit source, tests, or docs — BUGS\.md is your only write/);
  assert.match(find, /If the flow works as documented, there is nothing to do/);
});

test("the qa prompt carries the safety rails for launched processes", () => {
  const find = qa!.find;
  assert.match(find, /every process gets a hard time limit and an explicit kill/);
  assert.match(find, /ephemeral high ports, never the product's documented default port/);
  assert.match(find, /no listening process may outlive your tick/);
});

test("the qa prompt picks one flow per tick from the README usage menu, cheap first", () => {
  const find = qa!.find;
  assert.match(find, /README's usage section is your menu of flows/);
  assert.match(find, /cheapest-first/);
  assert.match(find, /pick ONE per tick/);
});

test("the qa prompt varies across ticks and leaves no record for passing cheap flows", () => {
  const find = qa!.find;
  assert.match(find, /prefer a flow not recently exercised/);
  assert.match(find, /BUGS\.md filings and Verified notes show/);
  assert.match(find, /leaves NO record — declare nothing-to-do/);
});

test("the qa prompt guards the expensive real run: constrained, capped, once per day", () => {
  // Prefer a deterministic offline mode when the project documents one.
  const find = qa!.find;
  assert.match(find, /prefer a deterministic offline mode \(a fake\/shim\)/);
  // Otherwise ONE real bounded run — minimal scope (constrained nested fleet), wall-capped,
  // and killed with its whole process tree so no orphaned child survives the tick.
  assert.match(find, /exactly one enabled role and maxConcurrent 1/);
  assert.match(find, /wall-cap it \(~10 min including prefill\)/);
  assert.match(find, /kill its whole process tree when done/);
  // The once-per-day guard is self-enforcing across fresh sessions through the Verified note.
  assert.match(find, /only when the newest Verified note for the flow is older than a day/);
  assert.match(find, /## Verified section at the end of BUGS\.md/);
  assert.match(find, /- 2026-08-28 run \(real\): init \+ one tick landed; status\/logs confirm/);
});

test("buildTickPrompt for qa carries the find text plus the shared rules", () => {
  const prompt = buildTickPrompt({ role: qa!, initialPrompt: "" });
  assert.match(prompt, /"qa" loop \(product QA\)/);
  assert.ok(prompt.includes(qa!.find.trim()), "the full find text is embedded");
  assert.match(prompt, /TUMWATER_NOTHING_TO_DO/);
});
