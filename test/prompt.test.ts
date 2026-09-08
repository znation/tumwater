import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  PRINCIPLES_MAX_CHARS,
  buildConflictPrompt,
  buildCutOffNote,
  buildDirectorPrompt,
  buildRejectedReviewNote,
  buildResumePrompt,
  buildReviewPrompt,
  buildSummaryRequestPrompt,
  buildTickPrompt,
  readPrinciples,
} from "../src/prompt.js";
import { parseVerdict } from "../src/review.js";
import { NOTHING_TO_DO } from "../src/reply-contract.js";
import { PROMPT_END, PROMPT_START, readInitialPrompt, readmeTemplate } from "../src/readme.js";
import { DECOMPOSITION_GUIDANCE, PLAN_SIZING, ROLES, roleById, searchGuidance } from "../src/roles.js";
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
  // oneLine so a reflow of the hard-wrapped find text cannot break this contract check.
  assert.match(oneLine(role.find), /but not PRINCIPLES\.md, which only the director and steward edit/);
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

// Prompt contract for section-aware tick reads (PLANS.md, planned 2026-09-04): every tick
// re-reads the backlog files, so the read-first rule bounds how much of each gets prefilled —
// README in full, PLANS.md/BUGS.md only at their actionable tops, older history via git log or
// a targeted read, and a carve-out for the steward, which curates those files whole.

test("every role prompt carries the section-aware read-first rule", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  // README is read in full; QUESTIONS.md keeps its place in the read set.
  assert.match(prompt, /First read README\.md in full/);
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

// Prompt contract for the steward role (plans/steward-role.md): a markdown-only curation
// role on a slow clock. Every tick is a fresh session with no memory of earlier curation
// moves, so the find text must carry the move list, the markdown-only restriction, and its
// deletion/principles powers in prose; these assertions pin that contract. Same whitespace-
// collapsed matching as the refusal and questions contracts above — the prose is hard-wrapped
// and formatting ticks reflow it, so assertions match content, not layout.

const steward = roleById("steward");

test("the steward role exists last in catalog order", () => {
  assert.ok(steward, "roleById('steward') returns a role");
  const ids = ROLES.map((r) => r.id);
  // The director is appended separately by allRoleIds(), so within the catalog the steward
  // sits right after improve — exactly the lowest tie-break priority planned.
  assert.equal(ids[ids.indexOf("improve") + 1], "steward", "steward sits right after improve");
  assert.equal(steward.title, "project steward");
});

test("the steward prompt makes ONE curation move from the planned list", () => {
  const find = oneLine(steward!.find);
  // It re-reads the durable state first — QUESTIONS.md only conditionally (init seeds it,
  // but older repos may not have it).
  assert.match(find, /Re-read the initial prompt, PRINCIPLES\.md, PLANS\.md, BUGS\.md/);
  assert.match(find, /and QUESTIONS\.md if it exists/);
  assert.match(find, /skim the codebase's shape \(sizes, module list, test count\)/);
  // One move per tick, and the four planned moves: prune plans (with an epitaph), flag
  // drift as a PLANS.md note, tighten or update a principle or complexity budget in
  // PRINCIPLES.md, record a structural risk in BUGS.md.
  assert.match(find, /make ONE curation move, the most valuable one/);
  assert.match(
    find,
    /delete or merge stale\/duplicative\/superseded PLANS\.md entries \(with a one-line epitaph in the entry's place or in Done\)/,
  );
  assert.match(find, /flag drift between what is being built and the initial prompt as a PLANS\.md note/);
  assert.match(find, /tighten or update a principle or complexity budget in PRINCIPLES\.md/);
  assert.match(find, /record a structural risk in BUGS\.md/);
});

test("the steward prompt restricts writes to markdown", () => {
  // Markdown-only is what keeps the role review-exempt (the gate's *.md exemption) and
  // safe on a slow clock: its diffs can never break the build.
  const find = oneLine(steward!.find);
  assert.match(find, /You edit only markdown — never source\./);
});

// Prompt contract for PLANS.md Done-section curation (PLANS.md, planned 2026-09-04): ## Done
// is bounded by construction — a ten-entry verbatim window, older entries compressed to
// one-line epitaphs carrying title, dates, and landing hashes. Every steward tick is a fresh
// session with no memory of earlier curation moves, so the find text must carry the whole
// policy in prose; these assertions pin that contract. Same whitespace-collapsed matching as
// above — the prose is hard-wrapped and formatting ticks reflow it, so assertions match
// content, not layout.

test("the steward prompt bounds PLANS.md's Done section to a ten-entry verbatim window", () => {
  const find = oneLine(steward!.find);
  assert.match(find, /PLANS\.md's ## Done section is curated to stay bounded/);
  assert.match(
    find,
    /keep the ten most recent entries verbatim \(newest first, by position in file\)/,
  );
});

test("the steward prompt compresses older Done entries to one-line epitaphs with title, dates, and hashes", () => {
  const find = oneLine(steward!.find);
  assert.match(find, /compress older ones to one line each/);
  // The exact one-line form: title, planned/done dates, landing commit(s).
  assert.match(
    find,
    /`- <title> \(planned YYYY-MM-DD, done YYYY-MM-DD; commit\(s\) <sha>\[, <sha>\]\)`/,
  );
  assert.match(find, /title and dates from the entry's heading/);
});

test("the steward prompt sources epitaph hashes from landing citations or git log, never verification references", () => {
  const find = oneLine(steward!.find);
  // Priority: an explicit landing citation in the body, else git log on main.
  assert.match(find, /an explicit landing citation in the entry body/);
  assert.match(find, /else git log on main/);
  // A Done note's "against main <sha>" is a base reference — never the record's hash; when no
  // landing commit exists, omit the field rather than guess.
  assert.match(
    find,
    /never use a verification or base reference \("Verified … against main `<sha>`", "at HEAD `<sha>`"\)/,
  );
  assert.match(find, /omit the commit\(s\) field rather than guess/);
});

test("the steward prompt never compresses Done entries carrying a Refused note", () => {
  const find = oneLine(steward!.find);
  assert.match(find, /Never compress an entry carrying a standing \*\*Refused …\*\* note/);
  assert.match(find, /such entries stay full \(they are rare\)/);
});

test("the steward prompt treats Done compression as lossy with git history as the archive", () => {
  const find = oneLine(steward!.find);
  assert.match(
    find,
    /lossy on purpose: pre-compression text stays in git history — no archive file/,
  );
});

// Prompt contract for BUGS.md Fixed-section curation (PLANS.md, planned 2026-09-04): ## Fixed is
// bounded by construction — a ten-entry verbatim window, older entries compressed to one-line
// records carrying the symptom headline, the heading's own date clause as-is, and the landing
// commit where resolvable. Same whitespace-collapsed matching as above — the prose is
// hard-wrapped and formatting ticks reflow it, so assertions match content, not layout.

test("the steward prompt bounds BUGS.md's Fixed section to a ten-entry verbatim window", () => {
  const find = oneLine(steward!.find);
  assert.match(
    find,
    /BUGS\.md's ## Fixed section is curated to stay bounded by the same policy/,
  );
  // The Done paragraph says "(newest first, by position in file)"; this clause is the Fixed
  // one — both windows are ten entries.
  assert.match(
    find,
    /keep the ten most recent entries verbatim \(newest first\) and compress older ones to one line each/,
  );
});

test("the steward prompt compresses older Fixed entries to one-line records with headline and date clause as-is", () => {
  const find = oneLine(steward!.find);
  // The exact one-line form: symptom headline, the heading's own date clause, landing commit.
  assert.match(
    find,
    /`- <symptom headline> \(<the heading's own date clause>; commit <sha>\)`/,
  );
  assert.match(find, /The headline comes from the entry's heading/);
  // The date clause is copied verbatim: BUGS.md headings vary across found/reported/re-recorded
  // × fixed/closed/resolved and may carry notes inside their parentheses.
  assert.match(find, /the date clause is copied from that heading as-is/);
  assert.match(
    find,
    /headings vary across found\/reported\/re-recorded × fixed\/closed\/resolved/,
  );
  assert.match(find, /do not normalize or fabricate dates/);
  // A heading without dates drops the date part rather than inventing one.
  assert.match(
    find,
    /when a heading carries no dates at all, omit that part of the line/,
  );
});

test("the steward prompt sources Fixed-record commits from landing citations or git log, never verification references", () => {
  const find = oneLine(steward!.find);
  assert.match(
    find,
    /The commit is the entry's LANDING commit — the one that merged the fix to main/,
  );
  // Priority: an explicit landing citation in the body (the "tick N (`sha`)" form naming the
  // fix commit itself), else git log on main.
  assert.match(
    find,
    /an explicit landing citation in the entry body \(the "tick N \(`<sha>`\)" form naming the fix commit itself\), else git log on main/,
  );
  // A verification reference is main's state at check time, not the fix; bodies citing several
  // shas need the one cited as having landed the fix.
  assert.match(
    find,
    /never use a verification reference \("Verified … on main `<sha>`", "at HEAD `<sha>`"\) as the record's hash/,
  );
  assert.match(find, /bodies citing several shas need the one cited as having landed the fix/);
  // Entries closed without code change have no landing commit — omit rather than guess.
  assert.match(
    find,
    /when no landing commit exists \(an entry closed without code change says so in its \*\*Resolution:\*\* note\) omit the `commit` field rather than guess/,
  );
});

test("the steward prompt never compresses Fixed entries carrying a Refused note", () => {
  const find = oneLine(steward!.find);
  // The Done paragraph uses an em-dash after "note"; the semicolon form is the Fixed clause.
  assert.match(
    find,
    /Never compress an entry carrying a standing \*\*Refused …\*\* note; such entries stay full/,
  );
});

test("the steward prompt carries the shared curation rules over to Fixed compression", () => {
  const find = oneLine(steward!.find);
  assert.match(
    find,
    /The same rules carry over: compression is lossy on purpose with git history as the archive, and one curation move per tick still holds/,
  );
});

test("buildTickPrompt for steward carries the find text plus the shared rules", () => {
  const prompt = buildTickPrompt({ role: steward!, initialPrompt: "" });
  assert.match(prompt, /"steward" loop \(project steward\)/);
  assert.ok(prompt.includes(steward!.find.trim()), "the full find text is embedded");
});

// Prompt contract for the readme role (PLANS.md "Bound README's status section — state, not log"):
// the status section is a state-only snapshot rewritten wholesale on each sync, never appended to,
// so it stays small by construction and cannot drift back into per-tick landing narrative. Every
// loop reads README.md first, so an unbounded log there would cost every tick's prefill forever;
// these assertions pin the contract in the find text. Same whitespace-collapsed matching as above —
// the prose is hard-wrapped and formatting ticks reflow it, so assertions match content, not layout.

const readme = roleById("readme");

test("the readme prompt rewrites the status section wholesale instead of appending", () => {
  const find = oneLine(readme!.find);
  assert.match(find, /describes CURRENT STATE ONLY/);
  assert.match(find, /rewrite it wholesale on each sync — never append to it/);
});

test("the readme prompt names the state-only content: summary, open items, freshness stamp", () => {
  const find = oneLine(readme!.find);
  assert.match(
    find,
    /one-line version\/capability summary \(which commands exist, which roles are enabled\)/,
  );
  assert.match(
    find,
    /open items — planned features not yet done, open bugs, open questions — one line each or "none"/,
  );
  // The freshness-stamp convention verbatim: main's sha plus build/suite state.
  assert.match(find, /Current main \(`<sha>`\): build clean, suite N\/N/);
});

test("the readme prompt forbids per-tick landing narrative; landings belong in PLANS.md/BUGS.md and git log", () => {
  const find = oneLine(readme!.find);
  assert.match(find, /No per-tick landing narrative in the section/);
  assert.match(find, /landings are recorded by their owning loops in PLANS\.md\/BUGS\.md and git log/);
  // Deleting stale narrative is part of the update — the one-off collapse at 1f70a95 must not read as loss.
  assert.match(find, /stale narrative found in the section is deleted as part of updating it/);
});

test("the readme prompt carries the ~8KB drift guard", () => {
  const find = oneLine(readme!.find);
  assert.match(
    find,
    /exceeds ~8KB it has drifted back into narrative — prune it to the state-only form/,
  );
});

test("buildTickPrompt for readme carries the find text plus the shared rules", () => {
  const prompt = buildTickPrompt({ role: readme!, initialPrompt: "" });
  assert.match(prompt, /"readme" loop \(README maintainer\)/);
  assert.ok(prompt.includes(readme!.find.trim()), "the full find text is embedded");
});

// Context-ceiling handling (src/prompt.ts): half of all autonomous-era ticks ended cut off at
// the window, almost all of it tool output from reading wholesale. The budget rule rides on
// every run; the resume bridge names the real cause; a fresh tick after cut-offs carries a note.

test("every run carries the context-budget rule", () => {
  const tick = buildTickPrompt({ role: ROLES[0]!, initialPrompt: "x" });
  assert.match(tick, /context window is finite/);
  assert.match(tick, /check size before reading \(`wc -l`\) and read\s+files over ~300 lines in ranges/);
  assert.match(buildDirectorPrompt("do x", "x"), /context window is finite/);
  assert.match(buildResumePrompt("clean"), /context window is finite/);
});

test("buildResumePrompt names a context-ceiling cut-off and asks for the smallest finish", () => {
  const p = buildResumePrompt("clean", "cut-off");
  assert.match(p, /"clean"/);
  assert.match(p, /ran out of context before it could finish/);
  assert.match(p, /compacted the session/);
  assert.match(p, /Do NOT re-read the codebase/);
  assert.match(p, /smallest change that\s+completes it/);
  assert.match(p, /scope it down to what is\s+already complete/);
  assert.doesNotMatch(p, /restarted/, "a cut-off is not a restart — the bridge must not claim one");
  // The harness contract is restated on both bridges.
  assert.match(p, /ONE focused task/);
  assert.match(p, /Never create, amend, or revert git commits/);
  assert.ok(p.includes(NOTHING_TO_DO));
  assert.ok(p.includes("SUMMARY: <imperative one-line description of the change, at most 72 characters>"));
  assert.equal(buildResumePrompt("clean"), buildResumePrompt("clean", "restart"), "restart is the default cause");
});

test("buildCutOffNote counts the failed runs and offers nothing-to-do as the honest exit", () => {
  const one = buildCutOffNote(1);
  assert.match(one, /^Your previous run as this loop ran out of context before landing anything/);
  assert.match(one, /grep first, read in ranges, cap\s+command output/);
  assert.ok(one.includes(NOTHING_TO_DO));
  assert.match(buildCutOffNote(3), /^Your previous 3 runs as this loop/);
});


test("buildSummaryRequestPrompt asks for exactly the closing block and nothing else", () => {
  // The follow-up for a changed tick whose reply lacked SUMMARY (src/loop.ts requestSummary):
  // it must name every label the commit-message parser reads and forbid further tool use.
  const p = buildSummaryRequestPrompt();
  assert.match(p, /did not include the required closing block/);
  assert.match(p, /no tool calls, no other text/);
  for (const label of ["SUMMARY:", "WHY:", "RISK:", "VERIFIED:"]) assert.ok(p.includes(label), label);
  assert.doesNotMatch(p, /VERDICT/, "must never read as a reviewer run");
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
  assert.match(prompt, /check size before reading \(`wc -l`\)/);
  assert.match(prompt, /read files over ~300 lines in ranges/);
  assert.match(prompt, /re-read only a region you edited/);
  // The rule names the cost so the model can budget, and never uses the loop tests' cut-off marker.
  assert.match(prompt, /costs ~5k tokens/);
  assert.doesNotMatch(prompt, /ran out of context/);
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

test("the backlog-free roles carry the shared search guidance with a role-specific git log filter", () => {
  for (const id of ["organize", "clean", "dry", "perf", "improve"]) {
    const role = roleById(id);
    assert.ok(role, `role ${id} exists`);
    assert.ok(role.find.includes(searchGuidance(id)), `${id} embeds searchGuidance(${id})`);
    assert.ok(role.find.includes(`--grep="tumwater(${id})"`), `${id} names its own commit subjects`);
  }
  // The guidance itself: cheap signals, a shortlist cap, a whole-file size cap, a decision deadline.
  const g = oneLine(searchGuidance("clean"));
  assert.match(g, /do not read the codebase file by file/);
  assert.match(g, /`git log --stat -15`/);
  assert.match(g, /Shortlist at most five candidate files/);
  assert.match(g, /open a file whole only when it is under ~300 lines/);
  assert.match(g, /Decide within ~15 tool calls/);
  assert.match(g, /there is nothing to do — searching longer rarely changes the answer/);
  // Roles with a backlog to point at do not need it.
  for (const id of ["feature", "bugfix", "plan", "readme", "qa", "steward"]) {
    assert.ok(!roleById(id)!.find.includes("How to search:"), `${id} has no search guidance`);
  }
});

test("the coverage role locates gaps from evidence, not by reading every module", () => {
  const find = oneLine(roleById("coverage")!.find);
  assert.match(find, /Locate it from evidence rather than by reading every module/);
  assert.match(find, /compare the source module list against the test files/);
  assert.match(find, /run the test runner's coverage report when it has one/);
  assert.match(find, /then read only that file and its existing tests/);
});

test("the feature role maps PLANS.md by heading, matches the reviewer's plan check, and splits oversized plans", () => {
  const find = oneLine(roleById("feature")!.find);
  assert.match(find, /`grep -n '\^##' PLANS\.md` gives every heading with its line number/);
  assert.match(find, /read only the chosen entry's line range and the code it names/);
  assert.match(find, /The reviewer checks your diff against the entry's files-touched list and acceptance criteria/);
  assert.match(find, /A plan too large to finish in this run is split before implementing/);
  assert.match(find, /then implement one of them completely/);
});

test("the bugfix role bounds its latent-bug hunt and demands a reproduction", () => {
  const find = oneLine(roleById("bugfix")!.find);
  assert.match(find, /hunt briefly for one latent bug — at most ~10 tool calls, not a tour of the codebase/);
  assert.match(find, /read the regions changed most recently \(`git log --stat -10` on main\)/);
  assert.match(find, /Confirm a candidate is real — a failing test or a scratch reproduction — before fixing it/);
  assert.match(find, /if nothing concrete surfaces within that budget, there is nothing to do/);
});

test("the plan role and the director size plans to one implementation run via the shared constant", () => {
  assert.ok(roleById("plan")!.find.includes(PLAN_SIZING), "plan role embeds PLAN_SIZING");
  assert.ok(buildDirectorPrompt("add dark mode", "a project").includes(PLAN_SIZING), "director embeds PLAN_SIZING");
  const sizing = oneLine(PLAN_SIZING);
  assert.match(sizing, /Size every plan to ONE implementation run by a mid-sized model working alone/);
  assert.match(sizing, /at most a few hundred lines of change including tests/);
  assert.match(sizing, /split into independently landable sub-plans/);
  // The plan role also grounds plans in the code and checks for duplicates first.
  const find = oneLine(roleById("plan")!.find);
  assert.match(find, /confirm with grep that the capability does not already exist/);
  assert.match(find, /name the actual files and functions it touches, having looked at them in ranges/);
});

test("the director investigates only enough to route", () => {
  const prompt = oneLine(buildDirectorPrompt("the tui flickers", "a project"));
  assert.match(prompt, /Investigate only as much as routing precisely needs/);
  assert.match(prompt, /never a survey of the codebase, and never the implementation itself/);
});

test("the readme role syncs from the git delta since its stamp", () => {
  const find = oneLine(roleById("readme")!.find);
  assert.match(find, /`git log --oneline <stamped sha>\.\.main` names everything that landed since the last sync/);
  assert.match(find, /read only what those commits touched/);
});

test("the steward maps the backlog files by heading and reads bodies only by range", () => {
  const find = oneLine(roleById("steward")!.find);
  assert.match(find, /You may see PLANS\.md and BUGS\.md whole, but do it cheaply/);
  assert.match(find, /map each file first with `grep -n '\^##' FILE`/);
  assert.match(find, /read Done\/Fixed entries by line range only where your move needs their bodies/);
  assert.match(find, /no body read required/);
});

test("buildReviewPrompt carries the reviewer checklist and a reading budget", () => {
  const prompt = oneLine(buildReviewPrompt("diff body"));
  assert.match(prompt, /read only what the diff touches: the changed functions, their callers, and the tests that cover them/);
  assert.match(prompt, /Check, in this order: 1\. Does the diff do exactly what the summary and WHY claim/);
  assert.match(prompt, /2\. Are the VERIFIED claims consistent with the diff/);
  assert.match(prompt, /3\. Do new or changed tests exercise the new behavior — would they fail without the change\?/);
  assert.match(prompt, /4\. For a planned feature or recorded bug, does the change deliver what its PLANS\.md\/BUGS\.md entry promises/);
  assert.match(prompt, /5\. Does anything violate a principle above/);
  assert.match(prompt, /Reject only for concrete, verifiable defects you can name/);
  // A scratch copy under temp is allowed (reviewers measure there); the worktree stays untouched.
  assert.match(prompt, /a scratch copy under the system temp directory is fine/);
  assert.match(prompt, /Do not edit any file in the worktree/);
});

test("buildReviewPrompt names the harness's green pre-check when given, and omits the section otherwise", () => {
  const withCheck = buildReviewPrompt("diff", undefined, undefined, undefined, undefined, "`npm run test` passed");
  assert.match(
    withCheck,
    /The harness already ran the project's own check on this exact tree and it passed:\n`npm run test` passed\./,
  );
  assert.match(oneLine(withCheck), /Do not spend your run re-running it/);
  const without = buildReviewPrompt("diff");
  assert.ok(!without.includes("The harness already ran"), "no pre-check section without a verdict");
  // The verdict-form contract survives the extra section: still exactly the two advertised forms.
  const advertised = [...oneLine(withCheck).matchAll(/VERDICT:\s*(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(advertised, ["approve", "reject"]);
});

test("the cut-off resume bridge carries a numeric re-reading budget and the plain-text ending rule", () => {
  const p = oneLine(buildResumePrompt("feature", "cut-off"));
  assert.match(p, /at most ~10 tool calls of re-reading, and never the same file twice/);
  assert.match(p, /Your last message is plain text — never a tool call or an announcement of a next step/);
  // The restart bridge shares the ending rule but never the cut-off text.
  const restart = oneLine(buildResumePrompt("feature"));
  assert.match(restart, /Your last message is plain text/);
  assert.doesNotMatch(restart, /ran out of context/);
});

test("buildConflictPrompt bounds reading to the conflicted files", () => {
  const p = oneLine(buildConflictPrompt("dry", ["src/a.ts"]));
  assert.match(p, /Read only the conflicted files and what they directly reference/);
  assert.match(p, /`grep -n '<<<<<<<' FILE`/);
});
