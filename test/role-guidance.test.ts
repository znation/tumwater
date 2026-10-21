import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildDirectorPrompt, buildRunPrompt } from "../src/prompt/prompt.js";
import { roleById } from "../src/roles/roles.js";
import {
  DECOMPOSITION_GUIDANCE,
  NEEDS_REPLAN_NOTE,
  NEEDS_REVIEW_NOTE,
  PLAN_QUEUE_GUIDANCE,
  PLAN_SIZING,
  searchGuidance,
  VALIDATION_GAP_GUIDANCE,
  VALIDATION_GAP_QUERY,
  VALIDATION_GAP_TAGS,
  VALIDATION_GAP_TALLY,
  WAITING_FOR_FAILURE_NOTE,
  WAITING_FOR_FAILURE_PREFIX,
  backlogMoveGuidance,
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
  const prompt = buildDirectorPrompt("add import and export features");
  assert.ok(prompt.includes(DECOMPOSITION_GUIDANCE));
  assert.match(prompt, /independent subparts/);
  assert.match(prompt, /keep a single entry/);
});

test("plan and bugfix role prompts include the shared decomposition guidance", () => {
  for (const id of ["plan", "bugfix"]) {
    const role = roleById(id);
    assert.ok(role, `role ${id} exists`);
    const prompt = buildRunPrompt({ role });
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
  const prompt = buildRunPrompt({ role });
  assert.ok(prompt.includes(VALIDATION_GAP_GUIDANCE), "embeds the shared constant verbatim");
  assert.match(prompt, /write the required validation-gap trace line/);
});

test("the documented gap tally counts the verbatim line and the compressed suffix as one vocabulary", () => {
  // The query is the whole aggregation surface, so it must count both the `**Validation gap:**`
  // line bugfix writes and the `gap: <tag>` suffix the steward leaves after compression — else
  // the
  // newest entries are invisible to the only recorded query. Run it for real on both forms.
  const query =
    "grep -sohE 'gap:[*]{0,2} ?[a-z-]+' BUGS.md BUGS-FIXED.md | sed -E 's/^gap:[*]{0,2} ?//' | sort | uniq -c";
  assert.ok(VALIDATION_GAP_TALLY.includes(query), "the tally constant documents this exact query");
  // Only the steward aggregates the tags, so only its prompt carries the query.
  assert.ok(roleById("steward")!.find.includes(VALIDATION_GAP_TALLY), "the steward embeds the tally");
  assert.ok(!roleById("bugfix")!.find.includes(query), "bugfix writes one line and never needs the tally");
  // Fixed entries are archived in BUGS-FIXED.md (plans/backlog-archive.md); the query reads both.
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "BUGS.md"), "**Validation gap:** no-fake — had to write a shim.\n");
  fs.writeFileSync(
    path.join(dir, "BUGS-FIXED.md"),
    [
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

test("the validation-gap query names every non-none tag for a consumer, and only the coverage role embeds it", () => {
  // Every non-`none` tag appears in the query's alternation, and `none` (which names nothing to
  // build) does not — same define-once-from-the-closed-vocabulary shape as the tally test above.
  for (const tag of VALIDATION_GAP_TAGS) {
    if (tag === "none") {
      assert.ok(!VALIDATION_GAP_QUERY.includes(tag), "`none` never appears in the query");
    } else {
      assert.ok(VALIDATION_GAP_QUERY.includes(tag), `query names ${tag}`);
    }
  }
  // Only the coverage role — the consumer that picks its target from the traces — embeds the
  // query; the bugfix role writes one line and the steward aggregates the count, neither lists
  // entries.
  assert.ok(oneLine(roleById("coverage")!.find).includes(VALIDATION_GAP_QUERY), "coverage embeds the query");
  assert.ok(!roleById("bugfix")!.find.includes(VALIDATION_GAP_QUERY), "bugfix writes one line, not a query");
  assert.ok(!roleById("steward")!.find.includes(VALIDATION_GAP_QUERY), "the steward tallies, not lists");
  // Run the query for real on a temp BUGS.md: it must surface the no-fake hit and neither the
  // `none` line nor the steward's compressed `gap: no-repro` suffix.
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "BUGS.md"),
    [
      "**Validation gap:** no-fake — had to write a shim.",
      "**Validation gap:** none — the existing suite confirmed it.",
      "- Old headline (fixed 2026-09-01; commit abc1234; gap: no-repro)",
      "",
    ].join("\n"),
  );
  // With no archive yet, the query still answers from BUGS.md alone (`-s` keeps it quiet).
  assert.match(sh(dir, "sh", "-c", VALIDATION_GAP_QUERY), /^BUGS\.md:1:.*no-fake/);
  // Fixed bugs are archived in BUGS-FIXED.md (plans/backlog-archive.md); the query reads it too.
  fs.writeFileSync(path.join(dir, "BUGS-FIXED.md"), "## Fixed\n\n**Validation gap:** unclear-invariant — had to reconstruct it.\n");
  const out = sh(dir, "sh", "-c", VALIDATION_GAP_QUERY);
  assert.match(out, /^BUGS-FIXED\.md:3:.*unclear-invariant/m, "query prints the archived hit with its file and line");
  assert.ok(out.includes("no-fake"), "query prints the no-fake hit");
  assert.ok(!out.includes("none"), "query does not print the none line");
  assert.ok(!out.includes("no-repro"), "query does not print the compressed gap: no-repro line");
});

test("the steward prompt embeds the validation-gap guidance verbatim", () => {
  const find = oneLine(roleById("steward")!.find);
  assert.ok(find.includes(oneLine(VALIDATION_GAP_GUIDANCE)), "embeds the shared constant");
});

test("the backlog-free roles carry the shared search guidance with a role-specific git log filter", () => {
  for (const id of ["organize", "clean", "dedupe", "perf", "improve"]) {
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
  assert.ok(oneLine(buildDirectorPrompt("split plan X")).includes(NEEDS_REVIEW_NOTE));
});

test("the Needs replan marker is embedded in the feature, plan, and director prompts", () => {
  assert.ok(oneLine(roleById("feature")!.find).includes(NEEDS_REPLAN_NOTE));
  assert.ok(oneLine(roleById("plan")!.find).includes(NEEDS_REPLAN_NOTE));
  assert.ok(oneLine(buildDirectorPrompt("replan plan X")).includes(NEEDS_REPLAN_NOTE));
});

test("the plan role and the director size plans to one implementation run via the shared constant", () => {
  assert.ok(roleById("plan")!.find.includes(PLAN_SIZING), "plan role embeds PLAN_SIZING");
  assert.ok(buildDirectorPrompt("add dark mode").includes(PLAN_SIZING), "director embeds PLAN_SIZING");
  const sizing = oneLine(PLAN_SIZING);
  assert.match(sizing, /Size every plan to ONE implementation run by a mid-sized model working alone/);
  assert.match(sizing, /at most a few hundred lines of change including tests/);
  assert.match(sizing, /split into independently mergeable sub-plans/);
  // A sub-plan depending on a sibling must name it so the claim allocator holds it (BUGS.md
  // 2026-10-14): only the `requires part N/M landed` form in the heading's parenthetical is
  // read by requiredParts.
  assert.match(sizing, /requires part N\/M landed/);
  assert.match(sizing, /only form the claim allocator reads/);
  assert.match(sizing, /does not hold the part until its/);
  // Anchors drift: line numbers go stale with every merge, symbols do not.
  assert.match(sizing, /file paths and symbol names/);
  assert.match(sizing, /never on line numbers or ranges/);
  // The self-hosting build lag (BUGS.md 2026-09-23): a merge that changes how merges behave
  // must not also depend on that change, since the team merges it with the previous build.
  assert.match(sizing, /every commit merges under the build that predates it/);
  assert.match(sizing, /a change to how merges behave and any step that depends on it are separate sub-plans/);
  assert.match(sizing, /the second merge only once the first is the running build/);
  // The plan role also grounds plans in the code and checks for duplicates first.
  const find = oneLine(roleById("plan")!.find);
  assert.match(find, /confirm with grep that the capability does not already exist/);
  assert.match(find, /name the actual files and functions it touches, having looked at them in ranges/);
});

test("plan, organize, steward, and the director embed the back-of-queue guidance for writing a plan", () => {
  assert.ok(roleById("plan")!.find.includes(PLAN_QUEUE_GUIDANCE), "plan role embeds PLAN_QUEUE_GUIDANCE");
  assert.ok(roleById("organize")!.find.includes(PLAN_QUEUE_GUIDANCE), "organize role embeds PLAN_QUEUE_GUIDANCE");
  assert.ok(roleById("steward")!.find.includes(PLAN_QUEUE_GUIDANCE), "steward role embeds PLAN_QUEUE_GUIDANCE");
  assert.ok(buildDirectorPrompt("add dark mode").includes(PLAN_QUEUE_GUIDANCE), "director embeds PLAN_QUEUE_GUIDANCE");
  const queue = oneLine(PLAN_QUEUE_GUIDANCE);
  assert.match(queue, /append the entry at the END of `## Planned`, after every existing entry/);
  assert.match(queue, /File order under `## Planned` is the work queue/);
  assert.ok(PLAN_QUEUE_GUIDANCE.length > 100, "the guidance is longer than one sentence");
});

test("the search guidance says a small, clearly useful change clears the bar", () => {
  // Lab A/B (2026-10-01): with the decision deadline as a numbered step, the improve role declined
  // small real improvements the old wording landed; the bar is value, not size.
  assert.match(oneLine(searchGuidance("improve")), /The bar is real value, not size: a small change that is clearly correct and useful clears it/);
});

test("bugfix find writes the waiting note and selfcheck find deletes it on a recurrence", () => {
  assert.ok(oneLine(roleById("bugfix")!.find).includes(oneLine(WAITING_FOR_FAILURE_NOTE)));
  const selfcheck = oneLine(roleById("selfcheck")!.find);
  assert.ok(selfcheck.includes(WAITING_FOR_FAILURE_PREFIX));
  assert.ok(selfcheck.includes("delete the note line"));
});

test("the closing guidance names the kind's token and the heading-key rule", () => {
  // BUGS.md 2026-10-21: the feature and bugfix roles share one move guidance, so the plan stamp
  // must carry the plan's "done" token, the bug record its "fixed", and the wording must say the
  // heading key cannot change — a feature role that stamped per the old generic wording was
  // rejected repeatedly.
  const planGuidance = backlogMoveGuidance("PLANS.md", "## Planned", "## Done", "PLANS-DONE.md", "done");
  const bugGuidance = backlogMoveGuidance("BUGS.md", "## Open", "## Fixed", "BUGS-FIXED.md", "fixed");
  assert.match(oneLine(planGuidance), /— done YYYY-MM-DD by the <role> role/);
  assert.match(oneLine(planGuidance), /\(planned …\)/);
  assert.match(oneLine(bugGuidance), /— fixed YYYY-MM-DD by the <role> role/);
  assert.ok(!planGuidance.includes("fixed YYYY-MM-DD"), "a plan is stamped done, not fixed");
  assert.ok(!bugGuidance.includes("done YYYY-MM-DD"), "a BUGS.md record is stamped fixed, not done");
  for (const g of [planGuidance, bugGuidance]) {
    assert.match(oneLine(g), /heading text before its first ` \(` must not change/);
  }
  // The assembled prompts pick the token by kind.
  assert.match(oneLine(roleById("feature")!.find), /— done YYYY-MM-DD by the <role> role/);
  assert.match(oneLine(roleById("bugfix")!.find), /— fixed YYYY-MM-DD by the <role> role/);
});
