import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildDirectorPrompt, buildTickPrompt } from "../src/prompt/prompt.js";
import { roleById } from "../src/roles/roles.js";
import {
  DECOMPOSITION_GUIDANCE,
  NEEDS_REPLAN_NOTE,
  NEEDS_REVIEW_NOTE,
  PLAN_SIZING,
  searchGuidance,
  VALIDATION_GAP_GUIDANCE,
  VALIDATION_GAP_TAGS,
  VALIDATION_GAP_TALLY,
} from "../src/roles/role-guidance.js";
import { oneLine } from "./helpers/oracles.js";
import { sh, tmpdir } from "./fixtures/repo-fixtures.js";

// Contract for src/roles/role-guidance.ts's shared prompt constants (plans/repair-traces.md and
// friends): the decomposition, validation-gap, needs-review, plan-sizing, and search guidance
// each live in one exported constant that prompt.ts and role-catalog.ts embed verbatim, so a
// reworded
// copy or a dropped clause fails here instead of drifting silently into every role's find text.

test("guidance is a single shared constant, not drifting copies", () => {
  // Both consumers embed the exported constant verbatim; a reworded copy would fail the
  // includes() checks below. This guards the constant itself against becoming trivial.
  assert.ok(DECOMPOSITION_GUIDANCE.length > 100);
  assert.match(DECOMPOSITION_GUIDANCE, /cross-references/);
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

// The validation-gap trace (PLANS.md, planned 2026-09-17, plans/repair-traces.md): a bugfix run
// records what made the bug hard to CONFIRM as a closed-vocabulary line, the steward preserves
// the tag through compression, and one documented query counts both forms. These pin the shared
// constant and both embedded copies so the vocabulary cannot drift or lose its tally.

test("the validation-gap guidance renders every tag in the closed vocabulary", () => {
  for (const tag of VALIDATION_GAP_TAGS) {
    assert.ok(VALIDATION_GAP_GUIDANCE.includes(tag), `guidance names ${tag}`);
  }
  assert.match(VALIDATION_GAP_GUIDANCE, /\*\*Validation gap:\*\* <tag> — <one sentence>/);
  // `none` must be written, not omitted, or the tally's denominator is a lie.
  assert.match(VALIDATION_GAP_GUIDANCE, /`none` is written, never omitted/);
  assert.match(VALIDATION_GAP_GUIDANCE, /never invent a\ntag/);
});

test("the bugfix prompt requires the validation-gap trace line for every fixed entry", () => {
  const role = roleById("bugfix");
  assert.ok(role);
  const prompt = buildTickPrompt({ role, initialPrompt: "" });
  assert.ok(prompt.includes(VALIDATION_GAP_GUIDANCE), "embeds the shared constant verbatim");
  assert.match(prompt, /write the required validation-gap trace line/);
});

test("the documented gap tally counts the verbatim line and the compressed suffix as one vocabulary", () => {
  // The query is the whole aggregation surface, so it must count both the `**Validation gap:**`
  // line bugfix writes and the `gap: <tag>` suffix the steward leaves after compression — else
  // the
  // newest entries are invisible to the only recorded query. Run it for real on both forms.
  const query =
    "grep -oE 'gap:[*]{0,2} ?[a-z-]+' BUGS.md | sed -E 's/^gap:[*]{0,2} ?//' | sort | uniq -c";
  assert.ok(VALIDATION_GAP_TALLY.includes(query), "the tally constant documents this exact query");
  // Only the steward aggregates the tags, so only its prompt carries the query.
  assert.ok(roleById("steward")!.find.includes(VALIDATION_GAP_TALLY), "the steward embeds the tally");
  assert.ok(!roleById("bugfix")!.find.includes(query), "bugfix writes one line and never needs the tally");
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "BUGS.md"),
    [
      "**Validation gap:** no-fake — had to write a shim.",
      "**Validation gap:** none — the existing suite confirmed it.",
      "- Old headline (fixed 2026-09-01; commit abc1234; gap: no-repro)",
      "- Untraced headline (fixed 2026-09-02; commit def5678)",
      "",
    ].join("\n"),
  );
  const out = sh(dir, "sh", "-c", query);
  assert.match(out, /1 no-fake/);
  assert.match(out, /1 no-repro/);
  assert.match(out, /1 none/);
  assert.ok(!out.includes("def5678"), "no tag invented for an entry without a trace");
});

test("the steward prompt embeds the validation-gap guidance verbatim", () => {
  const find = oneLine(roleById("steward")!.find);
  assert.ok(find.includes(oneLine(VALIDATION_GAP_GUIDANCE)), "embeds the shared constant");
});

test("the backlog-free roles carry the shared search guidance with a role-specific git log filter", () => {
  for (const id of ["organize", "clean", "dry", "perf", "improve"]) {
    const role = roleById(id);
    assert.ok(role, `role ${id} exists`);
    assert.ok(role.find.includes(searchGuidance(id)), `${id} embeds searchGuidance(${id})`);
    assert.ok(role.find.includes(`--grep="tumwater(${id})"`), `${id} names its own commit subjects`);
  }
  // The guidance itself: cheap signals, a shortlist cap, a whole-file size cap, a decision
  // deadline.
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

test("the Needs review marker is embedded in the feature, plan, and director prompts", () => {
  assert.ok(oneLine(roleById("feature")!.find).includes(NEEDS_REVIEW_NOTE));
  assert.ok(oneLine(roleById("plan")!.find).includes(NEEDS_REVIEW_NOTE));
  assert.ok(oneLine(buildDirectorPrompt("split plan X", "a project")).includes(NEEDS_REVIEW_NOTE));
});

test("the Needs replan marker is embedded in the feature, plan, and director prompts", () => {
  assert.ok(oneLine(roleById("feature")!.find).includes(NEEDS_REPLAN_NOTE));
  assert.ok(oneLine(roleById("plan")!.find).includes(NEEDS_REPLAN_NOTE));
  assert.ok(oneLine(buildDirectorPrompt("replan plan X", "a project")).includes(NEEDS_REPLAN_NOTE));
});

test("the plan role and the director size plans to one implementation run via the shared constant", () => {
  assert.ok(roleById("plan")!.find.includes(PLAN_SIZING), "plan role embeds PLAN_SIZING");
  assert.ok(buildDirectorPrompt("add dark mode", "a project").includes(PLAN_SIZING), "director embeds PLAN_SIZING");
  const sizing = oneLine(PLAN_SIZING);
  assert.match(sizing, /Size every plan to ONE implementation run by a mid-sized model working alone/);
  assert.match(sizing, /at most a few hundred lines of change including tests/);
  assert.match(sizing, /split into independently landable sub-plans/);
  // Anchors drift: line numbers go stale with every landing, symbols do not.
  assert.match(sizing, /file paths and symbol names/);
  assert.match(sizing, /never on line numbers or ranges/);
  // The self-hosting build lag (BUGS.md 2026-09-23): a landing that changes how landings behave
  // must not also depend on that change, since the fleet lands it with the previous build.
  assert.match(sizing, /every commit lands under the build that predates it/);
  assert.match(sizing, /a change to how landings behave and any step that depends on it are separate sub-plans/);
  assert.match(sizing, /the second landing only once the first is the running build/);
  // The plan role also grounds plans in the code and checks for duplicates first.
  const find = oneLine(roleById("plan")!.find);
  assert.match(find, /confirm with grep that the capability does not already exist/);
  assert.match(find, /name the actual files and functions it touches, having looked at them in ranges/);
});

test("the search guidance says a small, clearly useful change clears the bar", () => {
  // Lab A/B (2026-10-01): with the decision deadline as a numbered step, the improve role declined
  // small real improvements the old wording landed; the bar is value, not size.
  assert.match(oneLine(searchGuidance("improve")), /The bar is real value, not size: a small change that is clearly correct and useful clears it/);
});
