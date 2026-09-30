import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  PRINCIPLES_MAX_CHARS,
  ROOT_FROM_WORKTREE,
  buildCutOffNote,
  buildDirectorPrompt,
  buildResumePrompt,
  buildSummaryRequestPrompt,
  buildTickPrompt,
  readPrinciples,
} from "../src/prompt.js";
import { worktreePath } from "../src/paths.js";
import { buildConflictPrompt, buildReviewPrompt } from "../src/gate-prompts.js";
import { todayStamp } from "../src/budget.js";
import { NOTHING_TO_DO } from "../src/reply-contract.js";
import { customRole, ROLES, roleById } from "../src/roles.js";
import { NEEDS_REVIEW_NOTE, searchGuidance } from "../src/role-guidance.js";
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
  assert.match(oneLine(prompt), /or from a scratch directory under the system temp\. Never cd to the repo root \(`\.\.\/\.\.\/\.\.`\)/);
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

// BUGS.md 2026-09-12 (fixed 2026-09-13): a quiet-killed run resumes with its session and edits
// intact — the bridge must name the real cause so the resumed session does not re-run the hung
// command unchanged, instead of lying that "the harness was restarted".
test("buildResumePrompt names a quiet-kill so the session does not re-run the hung command", () => {
  const p = buildResumePrompt("bugfix", "hung-tool");
  assert.match(p, /"bugfix"/);
  // The real cause is named: no progress long enough to trip the hang watchdog — not a restart.
  assert.match(p, /hang watchdog/i);
  assert.doesNotMatch(p, /restarted/i);
  // The killed tool call must not be re-run unchanged; its effect needs verifying.
  assert.match(p, /do not re-run it unchanged/);
  assert.match(p, /verify the effect/i);
  // Same task continues, same closing contract as every other bridge.
  assert.match(p, /Continue the SAME task/);
  assert.ok(p.includes(NOTHING_TO_DO));
});

// The fourth resume cause — a run the tick time limit stopped while it was still making
// progress (loop.ts's quiet_killed with resumeCause "timeout"). Its bridge differs from a
// restart's in the load-bearing way: the limit will bite again, so the resumed run must
// budget against it rather than only verifying a cut-off tool call.
test("buildResumePrompt names a tick timeout and asks for a finish that fits the limit", () => {
  const p = buildResumePrompt("coverage", "timeout");
  assert.match(p, /"coverage"/);
  // The real cause is named: the tick time limit, framed as slow — not a failed run, not a
  // restart — so the resumed session does not treat its preserved work as suspect.
  assert.match(p, /tick time limit/i);
  assert.match(p, /a slow run, not a failed one/i);
  assert.doesNotMatch(p, /restarted/i);
  // The limit will bite again: finish small and within it, without re-exploring.
  assert.match(p, /budget against/i);
  assert.match(p, /smallest change that completes the task coherently/);
  assert.match(p, /Do not restart broad exploration/);
  // Same task continues, same closing contract as every other bridge.
  assert.match(p, /Finish the SAME task/);
  assert.ok(p.includes(NOTHING_TO_DO));
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

// Prompt contract for the refusal design (plans/refusal-and-thrash.md): a fresh-session tick
// has no memory of an earlier refusal except what the markdown says, so the skip rule and the
// recording shape must ride along in every prompt that picks work or routes decisions.

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

// The director is the only loop that can change customLoops — through the harness-mediated
// request file (plans/portability.md §3/7), never by editing tumwater.json. The routing bullet
// names the mechanics; the note scopes the request so a vague request cannot drift into
// retuning timeouts or disabling roles. Role tick prompts keep the blanket ban untouched.

test("the director routes loop-management requests to the config request file", () => {
  const prompt = oneLine(
    buildDirectorPrompt("add a loop named docs-sync that keeps the README examples current", "a project"),
  );
  assert.match(prompt, /A request to manage user-defined loops/);
  assert.match(prompt, /\.tumwater-config-request\.json/);
  assert.match(prompt, /\[a-z0-9_-\] no built-in role uses/);
  assert.match(prompt, /standing per-tick instruction/);
  assert.match(prompt, /array order is display\/scheduling order/);
  // Replace semantics and the worked example are pinned — a partial array would silently
  // delete loops the director forgot to repeat.
  assert.match(prompt, /REPLACES the current one/);
  assert.match(prompt, /"name": "docs"/);
});

test("the director's request-file contract replaces the tumwater.json edit exception; role prompts keep the blanket ban", () => {
  const d = oneLine(buildDirectorPrompt("add a loop named x that does y", "a project"));
  assert.match(d, /Note on one boundary above, director only/);
  assert.match(d, /applies only its customLoops array/);
  assert.match(d, /discarded with a warning/);
  // No edit exception remains: the director is told the config stays off-limits to it too.
  assert.ok(!d.includes("Exception to one boundary above"), "no tumwater.json edit exception");
  assert.ok(!d.includes("you may edit tumwater.json"), "the director never edits the config");
  // The blanket ban still stands in the director prompt — the request file sits at the
  // worktree root, so the boundary is untouched.
  assert.match(d, /Never touch the \.tumwater directory or tumwater\.json/);
  for (const role of ROLES) {
    const p = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
    assert.match(p, /Never touch the \.tumwater directory or tumwater\.json/, `${role.id} keeps the ban`);
    assert.ok(!p.includes("config-request"), `${role.id} carries no request-file contract`);
  }
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

test("the director routes answers back by moving the entry to Answered verbatim", () => {
  const prompt = oneLine(buildDirectorPrompt("answer Q3: choose SQLite", "a project"));
  assert.match(prompt, /An answer to an open question/);
  assert.match(prompt, /to ## Answered verbatim with the decision recorded/);
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

// BUGS.md 2026-09-23: qa's own GUI check left an unauthenticated `gui --all-interfaces` on the
// LAN for 7.5 hours — it exercised the flag over the network, and its cleanup killed the pid
// `cd … && node … & echo $!` recorded, which is the backgrounded list's subshell, not node's.
test("the qa prompt keeps servers on loopback and tracks background processes by their own pid", () => {
  const find = qa!.find;
  assert.match(
    find,
    /on loopback only — check a flag that widens the bind \(e\.g\. `--all-interfaces`\) from its startup banner and stop it at once/,
  );
  assert.match(find, /track each background process by its own pid/);
  assert.match(find, /in `cd dir && server & echo \$!`, `\$!` names the subshell, not the server/);
});

test("the qa prompt picks one flow per tick from the README usage menu, cheap first", () => {
  const find = qa!.find;
  assert.match(find, /README's usage section is your menu of flows/);
  assert.match(find, /cheapest-first/);
  assert.match(find, /pick ONE per tick/);
});

test("the qa prompt rotates through the coverage block and carries the FLOW contract", () => {
  const find = qa!.find;
  assert.match(find, /Flow coverage block from the fleet's own record/);
  assert.match(find, /exercise the flow at the top of that list/);
  assert.match(find, /leaves NO record in the repo — declare nothing-to-do/);
  assert.match(find, /FLOW: <name> — <passed\|bug>/);
  // The verdict is required (BUGS.md 2026-09-23): the sole FLOW producer must not be taught
  // that a bare `FLOW: <name>` counts as passed — the parser rejects exactly that form.
  assert.match(
    find,
    /verdict is required: a bare `FLOW: <name>` with no `passed\|bug` suffix is not a result and is not recorded/,
  );
  assert.doesNotMatch(find, /counts as passed/);
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

test("buildTickPrompt renders the coverage block only when one is passed", () => {
  const withCoverage = buildTickPrompt({
    role: qa!,
    initialPrompt: "",
    coverage: "Flow coverage (from this fleet's own record; least recently exercised first):\n  init — never exercised",
  });
  assert.ok(withCoverage.includes("Flow coverage (from this fleet's own record"));
  assert.match(withCoverage, /init — never exercised/);
  const without = buildTickPrompt({ role: qa!, initialPrompt: "" });
  assert.ok(!without.includes("least recently exercised first"), "no coverage block when none is supplied");
  // The injection is qa-scoped by the caller, so a non-qa prompt must not carry it either.
  const improve = buildTickPrompt({ role: roleById("improve")!, initialPrompt: "" });
  assert.ok(!improve.includes("least recently exercised first"));
});

// Prompt contract for the telemetry role (plans/telemetry-role.md): an observer that reads the
// harness's own event log — injected as a <failure-digest> block because the live log sits at the
// project root, outside its worktree — and files at most one bug in BUGS.md. Every tick is a
// fresh session, so the find text must carry the load-bearing rule (a cluster is a bug only when
// the harness's RESPONSE to it is wrong, never merely because the failure happened) and the
// dedup check; these assertions pin that contract.

const telemetry = roleById("telemetry");

test("the telemetry role exists after qa in catalog order", () => {
  assert.ok(telemetry, "roleById('telemetry') returns a role");
  const ids = ROLES.map((r) => r.id);
  assert.equal(ids[ids.indexOf("qa") + 1], "telemetry", "telemetry sits right after qa (both observers)");
  assert.equal(telemetry.title, "runtime telemetry reader");
});

test("the telemetry find text carries the harness-response rule, one bug, and the dedup check", () => {
  const find = oneLine(telemetry!.find);
  assert.match(find, /File ONE bug in BUGS\.md's ## Open section per tick/);
  assert.match(find, /ONLY when the harness's RESPONSE to it is wrong/);
  assert.match(find, /A mere infrastructure failure .* is weather, not a bug/);
  assert.match(find, /cite the cluster's normalized key plus the correlated .* commit/);
  assert.match(find, /BUGS\.md is your only write; never edit source, tests, or docs/);
  assert.match(find, /git log --grep="tumwater\(telemetry\)"/);
  assert.match(find, /no duplicate filings/);
});

test("a telemetry prompt renders the injected digest in a <failure-digest> block", () => {
  const prompt = buildTickPrompt({
    role: telemetry!,
    initialPrompt: "",
    digest: "# Failure digest\n- cluster",
  });
  assert.ok(prompt.includes("<failure-digest>\n# Failure digest\n- cluster\n</failure-digest>"));
  assert.match(prompt, /your evidence base/);
  // The block is the rendered digest, never a raw event dump.
  assert.ok(!prompt.includes(".tumwater/log/events.jsonl"));
});

test("prompts omit the <failure-digest> block when no digest is injected", () => {
  for (const id of ["qa", "feature"]) {
    const role = roleById(id);
    assert.ok(role);
    assert.ok(!buildTickPrompt({ role, initialPrompt: "" }).includes("<failure-digest>"));
  }
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

test("the readme prompt names the state-only content: summary, backlog pointer — no stamp", () => {
  const find = oneLine(readme!.find);
  assert.match(
    find,
    /one-line version\/capability summary — no command or flag lists, which belong in the usage docs/,
  );
  // Open work is pointed at, never copied: PLANS.md/BUGS.md/QUESTIONS.md are read every tick
  // anyway, so a mirrored list in the brief is duplicate prefill that drifts.
  assert.match(
    find,
    /one line pointing at PLANS\.md, BUGS\.md, and QUESTIONS\.md for open work — never a copy of their entries/,
  );
  // No freshness stamp (PLANS.md "Retire the README freshness stamp"): main's build/suite state
  // is volatile — it is reported live by `tumwater status`'s mainCheck, never committed, so a
  // landing no longer forces a README sync.
  assert.doesNotMatch(find, /[Ff]reshness stamp|Current main \(/);
  assert.match(find, /reported live by `tumwater status` \(its mainCheck\) — never stamped into the section/);
});

test("the readme prompt works from the delta since its own last commit", () => {
  const find = oneLine(readme!.find);
  // The delta anchor is the role's own last commit (found via its Tick trailer), not a stamped
  // sha in the brief — the stamp was the only thing that made the old anchor resolvable.
  assert.match(find, /git log --oneline <last readme commit>\.\.main/);
  assert.match(find, /Tick: readme #N/);
  // Sync is need-based now: a landing that touched no user-facing surface needs no sync.
  assert.match(find, /a landing that touched no user-facing surface \(commands, flags, config keys, docs\) needs no sync/);
});

test("the readme prompt forbids per-tick landing narrative; landings belong in PLANS.md/BUGS.md and git log", () => {
  const find = oneLine(readme!.find);
  assert.match(find, /No per-tick landing narrative in the section/);
  assert.match(find, /landings are recorded by their owning loops in PLANS\.md\/BUGS\.md and git log/);
  // Deleting stale narrative is part of the update — the one-off collapse at 1f70a95 must not read as loss.
  assert.match(find, /stale narrative found in the section is deleted as part of updating it/);
});

test("the readme prompt carries the ~1KB drift guard", () => {
  const find = oneLine(readme!.find);
  assert.match(
    find,
    /exceeds ~1KB it has drifted back into narrative — prune it to the state-only form/,
  );
});

test("the readme prompt keeps the brief short and moves detail into linked docs", () => {
  const find = oneLine(readme!.find);
  assert.match(find, /Keep the brief short: a summary, the status, and brief usage/);
  assert.match(find, /move detail there instead of growing the brief/);
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

// The harness attests the suite counts (PLANS.md 2026-09-29), so the VERIFIED line asks for
// what was run and observed beyond the total and no longer models a count ("182 pass") —
// authors restating counts was the top record-claim rejection at the review gate.
test("the VERIFIED line asks for observations beyond the suite total, not a count", () => {
  const p = buildSummaryRequestPrompt();
  assert.match(p, /beyond the suite total \(the harness attests the counts\)/);
  assert.match(p, /repro script showed X before, Y after/);
  assert.doesNotMatch(p, /182 pass/, "the count example is gone");
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

// Fan-out rule (PLANS.md "Tell ticks to fan out independent tool calls in one turn", planned
// 2026-09-23): each assistant turn re-sends the conversation, so turns — not tool calls — are
// the expensive unit. Independent reads/commands go out as sibling tool calls in one turn;
// anything depending on a prior result (an edit and the test that checks it) stays sequential.

test("every role prompt carries the fan-out rule: independent calls share a turn, dependent ones stay sequential", () => {
  const role = roleById("feature");
  assert.ok(role);
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  assert.match(prompt, /Each turn re-sends everything read so far/);
  assert.match(prompt, /issue them as separate tool calls in the same turn/);
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

test("the clean role names the suite's unused-export check instead of hunting internal-only exports", () => {
  const role = roleById("clean");
  assert.ok(role);
  const find = oneLine(role.find);
  assert.match(find, /test\/exports\.test\.ts/);
  assert.match(find, /do not spend a tick/);
});

test("the coverage role locates gaps from evidence, not by reading every module", () => {
  const find = oneLine(roleById("coverage")!.find);
  assert.match(find, /Locate it from evidence rather than by reading every module/);
  assert.match(find, /compare the source module list against the test files/);
  assert.match(find, /run the test runner's coverage report when it has one/);
  assert.match(find, /then read only that file and its existing tests/);
});

test("the feature role maps PLANS.md by heading, matches the reviewer's plan check, and hands oversized plans to the plan loop", () => {
  const find = oneLine(roleById("feature")!.find);
  assert.match(find, /`grep -n '\^##' PLANS\.md` gives every heading with its line number/);
  assert.match(find, /read only the chosen entry's line range and the code it names/);
  assert.match(find, /The reviewer checks your diff against the entry's files-touched list and acceptance criteria/);
  assert.match(find, /A plan too large to finish in this run is not split by you/);
  assert.ok(find.includes(NEEDS_REVIEW_NOTE), "feature embeds the marker");
  assert.match(find, /append the note .* under its heading, skip it, and implement the next available plan that fits/);
  assert.match(find, /land exactly one plan/);
  assert.match(find, /Skip entries already carrying a \*\*Needs review …\*\* note/);
  assert.ok(!/split before implementing/.test(find), "the inline-split instruction is gone");
  assert.match(find, /correct the entry in the same change instead of refusing/);
});

test("the plan role prioritizes a Needs review plan, clears the note after splitting, and stops while plans wait", () => {
  const find = oneLine(roleById("plan")!.find);
  assert.ok(find.includes(NEEDS_REVIEW_NOTE), "plan embeds the marker");
  assert.match(find, /outranks adding another plan/);
  assert.match(find, /split it into independently landable sub-plans that cross-reference each other/);
  assert.match(find, /then remove the note/);
  assert.ok(!/refining the weakest/.test(find), "the refine-the-weakest clause is gone");
  assert.match(find, /two or more plans without a Needs-review note, end with/);
  assert.ok(find.includes(NOTHING_TO_DO), "plan embeds the nothing-to-do sentinel");
  assert.match(find, /refined by the feature run that picks it up/);
});

test("the director routes a user ruling on a marked plan", () => {
  const prompt = oneLine(buildDirectorPrompt("split plan X", "a project"));
  assert.match(prompt, /A decision about a marked plan/);
  assert.match(prompt, /split it into independently landable sub-plans per PLAN_SIZING/);
  assert.match(prompt, /or clear the \*\*Needs review <YYYY-MM-DD> by feature: too large for one run\*\* note/);
});

test("the bugfix role bounds its latent-bug hunt and demands a reproduction", () => {
  const find = oneLine(roleById("bugfix")!.find);
  assert.match(find, /hunt briefly for one latent bug — at most ~10 tool calls, not a tour of the codebase/);
  assert.match(find, /read the regions changed most recently \(`git log --stat -10` on main\)/);
  assert.match(find, /Confirm a candidate is real — a failing test or a scratch reproduction — before fixing it/);
  assert.match(find, /if nothing concrete surfaces within that budget, there is nothing to do/);
});

test("the director investigates only enough to route", () => {
  const prompt = oneLine(buildDirectorPrompt("the tui flickers", "a project"));
  assert.match(prompt, /Investigate only as much as routing precisely needs/);
  assert.match(prompt, /never a survey of the codebase, and never the implementation itself/);
});

test("the readme role syncs from the git delta since its own last commit", () => {
  const find = oneLine(roleById("readme")!.find);
  assert.match(find, /`git log --oneline <last readme commit>\.\.main` names everything that landed/);
  assert.match(find, /read only what those commits touched/);
});

test("the steward maps the backlog files by heading and reads bodies only by range", () => {
  const find = oneLine(roleById("steward")!.find);
  assert.match(find, /You may see PLANS\.md and BUGS\.md whole, but do it cheaply/);
  assert.match(find, /map each file first with `grep -n '\^##' FILE`/);
  assert.match(find, /read Done\/Fixed entries by line range only where your move needs their bodies/);
  // The compressed Fixed record's `gap:` tag comes from the body's Validation gap line, so that
  // one line IS read; the old blanket "no body read required" was self-contradictory.
  assert.match(
    find,
    /except a Fixed entry's `gap:` suffix, which comes from the `\*\*Validation gap:\*\*` line in its body/,
  );
  assert.match(find, /read that one line \(`grep -n 'Validation gap' FILE`\), not the whole body/);
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
  const gatePrompts = [buildConflictPrompt("bugfix", ["a.txt"], today), review];
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
