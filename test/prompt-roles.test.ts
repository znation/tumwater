import test from "node:test";
import assert from "node:assert/strict";
import { buildDirectorPrompt, buildTickPrompt } from "../src/prompt/prompt.js";
import { NOTHING_TO_DO, SUMMARY_BLOCK } from "../src/verdict/reply-contract.js";
import { ROLES, roleById } from "../src/roles/roles.js";
import { NEEDS_REPLAN_NOTE, NEEDS_REVIEW_NOTE } from "../src/roles/role-guidance.js";
import { oneLine } from "./helpers/oracles.js";

// What each role's own prompt says: the per-role find text and content contracts (qa,
// telemetry, readme, clean, coverage, feature, bugfix, plan, steward) and the director's
// routing text — the wording a specific loop carries. How prompts are assembled and the rules
// every prompt shares stay in prompt.test.ts.
test("buildDirectorPrompt routes work to the specialist loops instead of implementing", () => {
  const prompt = buildDirectorPrompt("add dark mode", "Make a CLI.");
  assert.match(prompt, /project-level command/);
  assert.match(prompt, /do NOT implement substantial\nwork yourself/);
  assert.match(prompt, /plan for it in PLANS\.md/);
  assert.match(prompt, /record it in BUGS\.md/);
  assert.match(prompt, /Do not build\n {2}it now/);
  assert.match(prompt, /Do not fix it now/);
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
test("the perf role hunts measured wins and refuses speculative micro-optimization", () => {
  const role = roleById("perf");
  assert.ok(role, "perf role exists");
  assert.equal(role.title, "performance optimizer");
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  assert.match(prompt, /"perf" loop/);
  assert.match(prompt, /CLEAR performance win/);
  assert.match(prompt, /measure or reason from actual data/);
  assert.match(prompt, /Do NOT micro-optimize cold paths/);
  assert.match(prompt, /nothing to do/);
});
test("the security role traces a reachable source-to-sink path and proves it with a test", () => {
  const role = roleById("security");
  assert.ok(role, "security role exists");
  assert.equal(role.title, "security reviewer");
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  assert.match(prompt, /"security" loop/);
  assert.match(prompt, /Find ONE real, reachable security weakness/);
  assert.match(prompt, /Start from the trust boundaries, not from a file listing/);
  assert.match(prompt, /name the input an attacker controls, the path it travels, and the missing check/);
  assert.match(prompt, /a sink fed only by constants or the operator's own trusted config is not a finding/);
  assert.match(prompt, /a test that feeds the hostile input .* fails before your fix/);
  assert.match(prompt, /Put the source, the sink, and the path between them in your WHY/);
  assert.match(prompt, /Never paste a discovered secret's value anywhere/);
  assert.match(prompt, /Do not add or upgrade dependencies/);
  assert.match(prompt, /git log --oneline -15 --grep="tumwater\(security\)"/);
  assert.match(prompt, /If no candidate survives the trace, there is nothing to do/);
});
test("the robustness role injects a concrete fault and refuses to silence errors", () => {
  const role = roleById("robustness");
  assert.ok(role, "robustness role exists");
  assert.equal(role.title, "robustness hardener");
  const prompt = oneLine(buildTickPrompt({ role, initialPrompt: "" }));
  assert.match(prompt, /"robustness" loop/);
  assert.match(prompt, /fails halfway, returns garbage, or never returns/);
  assert.match(prompt, /write-to-temp-then-rename/);
  assert.match(prompt, /no timeout or cancellation/);
  assert.match(prompt, /name the concrete fault .* and the wrong outcome it causes/);
  assert.match(prompt, /a test that injects that fault .* fails before your fix/);
  assert.match(prompt, /it never turns a visible error into a silent one/);
  assert.match(prompt, /Do not wrap code in blanket try\/catch/);
  assert.match(prompt, /git log --oneline -15 --grep="tumwater\(robustness\)"/);
  assert.match(prompt, /If no candidate survives, there is nothing to do/);
});
test("security and robustness sit between the observers and improve in catalog order", () => {
  const ids = ROLES.map((r) => r.id);
  assert.deepEqual(ids.slice(ids.indexOf("telemetry"), ids.indexOf("improve") + 1), [
    "telemetry",
    "security",
    "robustness",
    "improve",
  ]);
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
  assert.match(d, /Note on one boundary in the rules below, director only/);
  // The note precedes the shared rules so the reply contract still closes the prompt.
  assert.ok(buildDirectorPrompt("x", "y").trimEnd().endsWith("write none when nothing was run>"));
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
test("the director routes answers back by moving the entry to Answered verbatim", () => {
  const prompt = oneLine(buildDirectorPrompt("answer Q3: choose SQLite", "a project"));
  assert.match(prompt, /An answer to an open question/);
  assert.match(prompt, /to ## Answered verbatim with the decision recorded/);
});
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
  assert.match(find, /scratch directory made with `mktemp -d` under `\$TMPDIR`/);
  assert.match(find, /never in your home, this worktree, or \.tumwater\//);
  assert.match(find, /build the product fresh per its README/i);
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
  assert.match(find, /every process gets a hard time limit and an explicit kill/i);
  assert.match(find, /ephemeral high ports, never the product's documented default port/);
  assert.match(find, /no listening process may outlive your tick/);
});
380
381
382
test("the qa prompt keeps servers on loopback and tracks background processes by their own pid", () => {
  const find = qa!.find;
  assert.match(
    find,
    /on loopback only — check a flag that widens the bind \(e\.g\. `--all-interfaces`\) from its startup banner and stop it at once/,
  );
  assert.match(find, /track each background process by its own pid/i);
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
  // Listed under "Keep these out of the status section" — the heading states the ban once.
  assert.match(find, /Keep these out of the status section: .* - Per-tick landing narrative: landings are recorded/);
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
  assert.match(
    find,
    /run the\s+project's coverage command — for an npm project that is `npm run test:coverage`, piped\s+through `tail`/,
  );
  // Non-Node projects must not be handed npm commands: the prompt names npm only as the
  // example inside a generic instruction (BUGS.md 2026-10-04).
  assert.match(find, /node's own table above it can flip between runs on the same tree/);
  assert.match(find, /then read only that file and its existing tests/i);
  // The fallback model's longest coverage tick (2026-10-01, 97 turns) wrote its own V8
  // instrumentation scripts instead of reading the project's coverage table.
  assert.match(find, /do not write your own coverage instrumentation/);
});
test("role prompts and the reply contract name npm only inside a generic instruction (non-Node projects get no npm commands)", () => {
  // BUGS.md 2026-10-04: the coverage find prescribed `npm run test:coverage` and the
  // SUMMARY_BLOCK's VERIFIED example said "npm test" verbatim, so a Rust/Python/Go project's
  // loops were told to run npm. The npm names may appear only as the example inside a generic
  // instruction ("for an npm project that is …"), never as the instruction itself.
  for (const role of ROLES) {
    const text = oneLine(`${role.find} ${role.title}`);
    for (const m of text.matchAll(/\bnpm (?:run|ci|test)\b\S*/g)) {
      assert.ok(
        /for an npm project[^.]*$/.test(text.slice(0, m.index ?? 0).slice(-120)),
        `role ${role.id} names ${m[0]} outside a generic "for an npm project" example`,
      );
    }
  }
  const block = oneLine(SUMMARY_BLOCK);
  assert.doesNotMatch(block, /"npm test/);
});
test("the feature role reads its plan from the injected index, matches the reviewer's plan check, and hands oversized plans to the plan loop", () => {
  const find = oneLine(roleById("feature")!.find);
  assert.match(find, /The prompt's <backlog-index> block lists PLANS\.md's `## Planned` entries/);
  assert.match(find, /read only the chosen entry's line range and the code it names/i);
  assert.match(find, /The reviewer checks your diff against the entry's files-touched list and acceptance criteria/);
  assert.match(find, /A plan too large to finish in this run is not split by you/);
  assert.ok(find.includes(NEEDS_REVIEW_NOTE), "feature embeds the marker");
  assert.ok(find.includes(NEEDS_REPLAN_NOTE), "feature embeds the replan marker");
  assert.match(find, /append the note .* under its heading, skip it, and implement the next available plan that fits/);
  assert.match(find, /land exactly one plan/);
  assert.match(find, /skip entries already carrying a \*\*Needs review …\*\* note/i);
  assert.ok(!/split before implementing/.test(find), "the inline-split instruction is gone");
  assert.match(find, /correct the entry in the same change instead of refusing/);
});
test("the feature find text moves a done plan under the EXISTING ## Done heading", () => {
  const find = oneLine(roleById("feature")!.find);
  // The failure this pins (PLANS.md 2026-09-30, part 1/3): "move it to a Done section" read
  // as "create a section", and five commits left PLANS.md with two `## Done` headings.
  assert.match(find, /cut the entry out of `## Planned`/);
  assert.match(find, /paste it as the first entry under the file's existing `## Done` heading/);
  assert.match(find, /never add, remove, or rename a `## ` heading/i);
  assert.match(find, /leave a `_None yet\._` placeholder there/);
  assert.match(find, /`grep -n '\^## ' PLANS\.md` must list the same headings before and after/);
  assert.ok(!/Done section/.test(find), "the 'create a section' wording is gone");
});
test("the bugfix find text moves a fixed bug under the EXISTING ## Fixed heading", () => {
  const find = oneLine(roleById("bugfix")!.find);
  assert.match(find, /cut the entry out of `## Open`/);
  assert.match(find, /paste it as the first entry under the file's existing `## Fixed` heading/);
  assert.match(find, /never add, remove, or rename a `## ` heading/i);
  assert.match(find, /`grep -n '\^## ' BUGS\.md` must list the same headings before and after/);
  assert.ok(!/Fixed section/.test(find), "the 'create a section' wording is gone");
});
test("the plan role prioritizes a Needs review plan, clears the note after splitting, and stops while plans wait", () => {
  const find = oneLine(roleById("plan")!.find);
  assert.ok(find.includes(NEEDS_REVIEW_NOTE), "plan embeds the marker");
  assert.ok(find.includes(NEEDS_REPLAN_NOTE), "plan embeds the replan marker");
  assert.match(find, /outranks adding another plan/);
  assert.match(find, /split it into independently landable sub-plans that cross-reference each other/);
  assert.match(find, /then remove the note/);
  assert.ok(!/refining the weakest/.test(find), "the refine-the-weakest clause is gone");
  assert.match(find, /two or more plans without a Needs-review or Needs-replan note, end with/);
  assert.ok(find.includes(NOTHING_TO_DO), "plan embeds the nothing-to-do sentinel");
  assert.match(find, /refined by the feature run that picks it up/);
});
test("the director routes a user ruling on a marked plan", () => {
  const prompt = oneLine(buildDirectorPrompt("split plan X", "a project"));
  assert.match(prompt, /A decision about a marked plan/);
  assert.match(prompt, /split it into independently landable sub-plans per PLAN_SIZING/);
  assert.match(prompt, /or clear the \*\*Needs review <YYYY-MM-DD> by feature: too large for one run\*\* note/);
  assert.match(prompt, /or clear a \*\*Needs replan <YYYY-MM-DD> by feature: rejected after <N> review rounds\*\* note and rewrite the entry/);
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
test("the steward reads the injected index and reads bodies only by range", () => {
  const find = oneLine(roleById("steward")!.find);
  assert.match(find, /you may see PLANS\.md and BUGS\.md whole, but do it cheaply/i);
  assert.match(find, /The prompt's <backlog-index> block lists every Planned and Open entry with its line range/);
  assert.match(find, /read Done\/Fixed entries by line range only where your move needs their bodies/);
  // The compressed Fixed record's `gap:` tag comes from the body's Validation gap line, so that
  // one line IS read; the old blanket "no body read required" was self-contradictory.
  assert.match(
    find,
    /except a Fixed entry's `gap:` suffix, which comes from the `\*\*Validation gap:\*\*` line in its body/,
  );
  assert.match(find, /read that one line \(`grep -n 'Validation gap' FILE`\), not the whole body/);
});
const qa = roleById("qa");
const telemetry = roleById("telemetry");
const readme = roleById("readme");
// Sweep completeness (2026-10-01): the budgeted model's dry/organize/clean rejections were mostly
// a refactor or rename left half-swept — call sites unconverted, a stale path in a doc comment or
// PLANS.md — and its coverage rejections were "untested" claims about modules other test files
// already imported. Each role names the grep that proves its change complete.
test("organize, dry, and clean each end with a whole-tree sweep for what they changed", () => {
  assert.match(oneLine(roleById("organize")!.find), /A change is complete only when a grep for every old path and every moved or renamed name — over the source, the tests, and the markdown docs .* finds no stale reference/);
  assert.match(oneLine(roleById("dry")!.find), /grep for the original expression once more across the source and the tests: every remaining copy is either converted or named in your WHY/);
  assert.match(oneLine(roleById("clean")!.find), /A rename or deletion is complete only when a grep for the old name over the source, the tests, and the markdown docs finds nothing stale/);
});
test("the coverage role checks every importing test before calling anything untested", () => {
  const find = oneLine(roleById("coverage")!.find);
  assert.match(find, /every test that imports it, not just the one named after it: `grep -rln '<module name>' test\/`/);
  assert.match(find, /Call a module or branch untested only when that check shows no test reaches it/);
});

test("qa's ending example is a template, never a real flow name a model could copy", () => {
  const find = qa!.find;
  // `logs` is a real QA_FLOWS name: a verbatim copy of a concrete example would record the wrong
  // flow as passed and leave the one actually exercised stale at the top of the rotation.
  assert.match(oneLine(find), /two lines in this form, with the name of the flow you actually exercised in place of <name>: FLOW: <name> — passed TUMWATER_NOTHING_TO_DO/);
  assert.ok(!/^\s*FLOW: logs/m.test(find), "no concrete flow name in the ending example");
});
test("feature and bugfix verify last, after their backlog edits", () => {
  // The suite reads the backlog files (backlog-structure, validation-gap tests), and the claims
  // rule wants verification after the LAST edit — so the closing PLANS.md/BUGS.md move comes
  // before the one final check rather than forcing a second one after it.
  const feature = oneLine(roleById("feature")!.find);
  assert.match(feature, /6\. Mark the plan done in PLANS\.md .* 7\. Verify last, after the PLANS\.md edit, so one run of the project's check covers everything you changed/);
  const bugfix = oneLine(roleById("bugfix")!.find);
  assert.match(bugfix, /4\. Mark it fixed in BUGS\.md .* 6\. Verify last, after the BUGS\.md edits, so one run of the project's check covers everything you changed/);
});
test("bugfix treats an all-refused Open section as nothing to do, and only an empty one as the hunt", () => {
  const find = oneLine(roleById("bugfix")!.find);
  assert.match(find, /when every open entry carries one, there is nothing to do/);
  assert.match(find, /When `## Open` holds no entries at all, skip to the latent-bug hunt at the end instead/);
});
test("the steward's tally query stands as its own sentence, not inside a parenthetical", () => {
  const find = oneLine(roleById("steward")!.find);
  assert.match(find, /citing those entries\. One query counts both the verbatim line and the compressed `gap: <tag>` suffix:/);
  assert.ok(!find.includes("uniq -c`.);"), "no sentence-in-parentheses rendering");
});
