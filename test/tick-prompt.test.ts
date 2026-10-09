import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assembleTickPrompt } from "../src/tick/tick-prompt.js";
import { defaultConfig } from "../src/config/config.js";
import { DIRECTOR_ROLE, roleById, allRoleIds } from "../src/roles/roles.js";
import { PROMPT_END, PROMPT_START, STATUS_END, STATUS_START, briefTemplate, readmeTemplate } from "../src/brief.js";
import { enqueuePrompt, enqueueRolePrompt, inboxSize } from "../src/inbox/inbox.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { qaCoveragePath, roleNotesPath } from "../src/paths.js";
import { ROLE_NOTES_MAX_BYTES } from "../src/pi-extension/role-notes.js";
import { freshLoopState, type LoopState } from "../src/loop/loop-state.js";
import { applyLandingOutcome } from "../src/tick/tick-apply.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** Unit coverage for src/tick/tick-prompt.ts — the assembly of what one loop's tick actually runs
 * on. The builders themselves (prompt.ts, gate-prompts.ts) are covered elsewhere; this is the
 * composition: brief resolution (TUMWATER.md before README.md), the director's inbox dequeue
 * (empty inbox = nothing to run), the qa/telemetry evidence blocks, custom roles, and the
 * cross-tick memory notes (rejected review, conflict discard, cut-off streak) appended in
 * order — the only memory a fresh session has of why the last attempt failed. */

const BRIEF = readmeTemplate("proj", "Build a tiny thing.\nWith care.");

function root(): string {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "README.md"), BRIEF);
  return dir;
}

function state(overrides: Partial<LoopState> = {}): LoopState {
  // The production constructor, not a hand-rolled literal: a copied field list drifts
  // silently when loop-state.ts grows a field (this one had already dropped dayStamp and
  // dayCostUsd), while a spread over freshLoopState picks the shape up automatically.
  return { ...freshLoopState("coverage"), ...overrides };
}

/** assembleTickPrompt with the suite's standing inputs — defaultConfig() and a fresh loop
 * state carrying the same role — so a call site cannot pass a role that disagrees with its
 * state's. `overrides` carries the few custom configs and pinned state fields; the
 * preview-seam tests below keep calling assembleTickPrompt directly, since they share one
 * input object between peek and dequeue. */
function promptFor(
  root: string,
  role: string,
  overrides: { config?: ReturnType<typeof defaultConfig>; state?: Partial<LoopState> } = {},
): ReturnType<typeof assembleTickPrompt> {
  return assembleTickPrompt({
    root,
    config: overrides.config ?? defaultConfig(),
    role,
    state: state({ role, ...overrides.state }),
  });
}

test("a role tick prompt embeds the brief, principles, and the role's task — with no user prompt", () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, "PRINCIPLES.md"), "Small beats big.\n");
  const result = promptFor(dir, "coverage");
  assert.ok(result);
  assert.equal(result.userPrompt, null);
  assert.match(result.prompt, /You are the "coverage" loop/);
  assert.match(result.prompt, /<project-prompt>\nBuild a tiny thing\.\nWith care\.\n<\/project-prompt>/);
  assert.match(result.prompt, /<principles>\nSmall beats big\.\n<\/principles>/);
  // The brief rule names the resolved file, the README compatibility default here.
  assert.match(result.prompt, /read the project brief \(README\.md\) in full/);
});

test("a repo whose brief markers are gone still assembles a prompt naming README.md", () => {
  // The degraded-but-running state: an operator edit (or a docs loop rewrite) can strip the
  // markers, leaving no file that owns the brief. The fleet must keep ticking — readInitialPrompt
  // degrades to an empty brief and the fallback names the compatibility path, not a dead end.
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "README.md"), "# My project\n\nNo markers here.\n");
  const result = promptFor(dir, "coverage");
  assert.ok(result);
  assert.doesNotMatch(result.prompt, /<project-prompt>/, "no brief content to embed");
  assert.match(result.prompt, /read the project brief \(README\.md\) in full/);
});

test("the brief resolves to TUMWATER.md when it owns the sections, and the prompt says so", () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, "TUMWATER.md"), briefTemplate("proj", "Build a tiny thing.\n"));
  const result = promptFor(dir, "coverage");
  assert.ok(result);
  assert.match(result.prompt, /read the project brief \(TUMWATER\.md\) in full/);
});

test("the configured check's command is named as the verify step", () => {
  const config = defaultConfig();
  config.check = { command: "make check" };
  const result = promptFor(root(), "coverage", { config });
  assert.ok(result);
  assert.match(result.prompt, /verify with `make check` \(the project's declared check\)/);
});

test("a director with an empty inbox has nothing to run", () => {
  const dir = root();
  assert.equal(
    promptFor(dir, DIRECTOR_ROLE),
    null,
  );
});

test("a director's prompt is built from the dequeued request, returned as userPrompt", () => {
  const dir = root();
  enqueuePrompt(dir, "prefer no third-party deps");
  const result = promptFor(dir, DIRECTOR_ROLE);
  assert.ok(result);
  assert.equal(result.userPrompt, "prefer no third-party deps");
  assert.match(result.prompt, /You are the "director" loop/);
  assert.match(result.prompt, /prefer no third-party deps/);
});

test("a role tick prompt injects the rendered <backlog-index> block from the primary checkout", () => {
  const dir = root();
  fs.writeFileSync(
    path.join(dir, "BUGS.md"),
    "# Bugs\n## Open\n### Real bug (reported 2026-10-06)\nRepro.\n## Fixed\n_None._\n",
  );
  const result = promptFor(dir, "bugfix");
  assert.ok(result);
  assert.match(result.prompt, /<backlog-index>/);
  assert.match(result.prompt, /BUGS\.md ## Open\n- 3-4: Real bug/);
});

// The role notebook (PLANS.md "Role notebook"): the tick reads the role's note file from disk.
// A missing file omits the block; the standing write instruction rides either way. The
// director's branch never reads the path, so its prompt carries neither.
test("a role tick prompt reads the note from roleNotesPath, and omits the block when there is none", () => {
  const dir = root();
  const notes = roleNotesPath(dir, "coverage");
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.writeFileSync(notes, "coverage runs through the oracle helpers\n");
  const withNote = promptFor(dir, "coverage");
  assert.ok(withNote);
  assert.match(withNote.prompt, /<role-notes>\ncoverage runs through the oracle helpers\n<\/role-notes>/);
  assert.match(withNote.prompt, /call role_notes with/);

  fs.rmSync(notes);
  const without = promptFor(dir, "coverage");
  assert.ok(without);
  assert.ok(!without.prompt.includes("<role-notes>"), "a missing note file means no block");
  assert.match(without.prompt, /call role_notes with/, "the write instruction is still present");
});

// The notebook is bounded on read too: the tool caps writes at ROLE_NOTES_MAX_BYTES, but the
// file is hand-editable runtime state, so an over-long one must not ride into every prefill.
// A note at the cap (a byte is never fewer than a character) is untouched.
const NOTE_TRUNCATION_MARKER = `…[role notebook truncated at ${ROLE_NOTES_MAX_BYTES} chars]`;
test("an over-long role note is truncated into the prompt with a visible marker", () => {
  const dir = root();
  const notes = roleNotesPath(dir, "coverage");
  fs.mkdirSync(path.dirname(notes), { recursive: true });

  fs.writeFileSync(notes, "x".repeat(ROLE_NOTES_MAX_BYTES));
  const atCap = promptFor(dir, "coverage");
  assert.ok(atCap);
  assert.ok(!atCap.prompt.includes(NOTE_TRUNCATION_MARKER), "a note at the cap is untouched");

  const tail = "the-tail-past-the-cap";
  fs.writeFileSync(notes, "x".repeat(ROLE_NOTES_MAX_BYTES + 100) + tail);
  const overCap = promptFor(dir, "coverage");
  assert.ok(overCap);
  assert.match(overCap.prompt, /<role-notes>\n/);
  assert.ok(overCap.prompt.includes(NOTE_TRUNCATION_MARKER), "the truncation is visible in the prompt");
  assert.ok(!overCap.prompt.includes(tail), "text past the bound is not injected");
});

test("a director prompt carries the same <backlog-index> block", () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, "BUGS.md"), "# Bugs\n## Open\n### Real bug\nRepro.\n## Fixed\n_None._\n");
  enqueuePrompt(dir, "what should we build next");
  const result = promptFor(dir, DIRECTOR_ROLE);
  assert.ok(result);
  assert.match(result.prompt, /<backlog-index>/);
  assert.match(result.prompt, /BUGS\.md ## Open\n- 3-4: Real bug/);
});

// A claim held by an instance id (`bugfix-2`) must resolve its line range through the base
// role's backlog file (BUGS.md's Open), not fall back to PLANS.md and drop the range.
test("a bugfix instance's claim names the bug's line range from BUGS.md", () => {
  const dir = root();
  fs.writeFileSync(
    path.join(dir, "BUGS.md"),
    "# Bugs\n## Open\n### Real bug\nRepro.\n## Fixed\n_None._\n",
  );
  const result = promptFor(dir, "bugfix-2", {
    state: { claim: { file: "BUGS.md", key: "real bug", title: "Real bug", at: 1, source: "assigned" } },
  });
  assert.ok(result);
  assert.match(result.prompt, /<assigned-entry>/);
  assert.match(result.prompt, /BUGS\.md lines 3-4/);
});

test("an unknown role throws — the fleet cannot run a prompt with no task", () => {
  assert.throws(
    () =>
      promptFor(root(), "nonexistent"),
    /unknown role: nonexistent \(valid ids: .+\)/,
  );
});

test("a custom role's task is its find-something-to-do text, titled by its name", () => {
  const config = defaultConfig();
  config.customLoops = [{ name: "changelog", task: "Keep CHANGELOG.md current." }];
  const result = promptFor(root(), "changelog", { config });
  assert.ok(result);
  assert.match(result.prompt, /You are the "changelog" loop/);
  assert.match(result.prompt, /Your task this run:\nKeep CHANGELOG\.md current\./);
});

test("a runner whose role answers to nothing throws the shared unknown-role message, custom ids included", () => {
  // The race the defensive path exists for: a live tumwater.json edit removes a custom loop
  // while its runner is still alive (runners are built at start and survive reloads), so the
  // next tick's assembly finds neither a catalog entry nor a customLoops task. It must throw
  // the shared unknownRoleMessage — the same wording the CLI's parseRoleFlag and the operator
  // commands use — with the valid ids as the live config sees them, so if it ever fires it
  // reads as the harness bug it is instead of a bare dead end.
  const config = defaultConfig();
  config.customLoops = [{ name: "changelog", task: "Keep CHANGELOG.md current." }];
  assert.throws(
    () => promptFor(root(), "ghost", { config }),
    (err: unknown) =>
      err instanceof Error &&
      err.message === `unknown role: ghost (valid ids: ${[...allRoleIds(), "changelog"].join(", ")})`,
  );
});

test("the qa role's prompt carries the flow-coverage ledger rendered from disk", () => {
  const dir = root();
  fs.mkdirSync(path.join(dir, ".tumwater", "state"), { recursive: true });
  fs.writeFileSync(
    qaCoveragePath(dir),
    JSON.stringify({ flows: { status: { lastRunAt: 1_800_000_000_000, result: "passed" } } }),
  );
  const result = promptFor(dir, "qa");
  assert.ok(result);
  assert.match(result.prompt, /Flow coverage \(from this fleet's own record; least recently exercised first\)/);
  assert.match(result.prompt, /status — .* ago, passed/);
  assert.match(result.prompt, /init — never exercised/);
});

test("the telemetry role's prompt carries the failure digest rendered from its event log", () => {
  const dir = root();
  writeEvents(dir, [
    { ts: Date.now(), loop: "feature", type: "tick_end", result: "error", error: "pi exited null" },
  ]);
  const result = promptFor(dir, "telemetry");
  assert.ok(result);
  assert.match(result.prompt, /Runtime failure digest of this harness's own event log/);
  assert.match(result.prompt, /<failure-digest>\n[\s\S]*pi exited null[\s\S]*<\/failure-digest>/);
  // The digest is the telemetry role's evidence block, not the coverage ledger's.
  assert.doesNotMatch(result.prompt, /Flow coverage/);
});

test("a role other than qa or telemetry gets neither evidence block", () => {
  const result = promptFor(root(), "coverage");
  assert.ok(result);
  assert.doesNotMatch(result.prompt, /Flow coverage/);
  assert.doesNotMatch(result.prompt, /<failure-digest>/);
});

test("a rejected review rides along on the next tick's prompt, reasons intact", () => {
  const result = promptFor(root(), "feature", {
    state: { lastReview: { verdict: "reject", reasons: ["the test lies about coverage"], at: 1 } },
  });
  assert.ok(result);
  assert.match(result.prompt, /the test lies about coverage/);
});

test("an exhausted feature rejection carries the replan instruction on the next tick", () => {
  const result = promptFor(root(), "feature", {
    state: { lastReview: { verdict: "reject", reasons: ["still wrong"], at: 1, exhausted: true } },
  });
  assert.ok(result);
  assert.match(result.prompt, /Needs replan/);
  assert.match(result.prompt, /do not re-author it/);
});

// Feature is told to land a markdown-only Needs-replan note when a change exhausts its revision
// rounds. That landing is review-exempt, so it records no verdict; the landing fold clears the
// standing rejection instead (clearSupersededRejection, tick-apply.ts). This pins that the
// instruction retires after the note lands rather than re-injecting and letting feature re-mark
// an entry the plan loop has already replanned.
test("the exhausted-feature replan instruction retires once the markdown-only note lands", () => {
  const dir = root();
  const s = state({
    role: "feature",
    lastReview: { verdict: "reject", reasons: ["still wrong"], at: 1, exhausted: true },
  });
  const before = promptFor(dir, "feature", { state: s });
  assert.ok(before);
  // The feature charter itself names "Needs replan", so the note is recognized by its
  // exhausted-rejection sentence, not the bare phrase.
  assert.match(before.prompt, /do not re-author it/);
  // The markdown-only replan note lands review-exempt: no model verdict is recorded, only the
  // landing fold fires.
  applyLandingOutcome(s, "changed", { sha: "a".repeat(40), summary: "marked plan X for replan" });
  const after = promptFor(dir, "feature", { state: s });
  assert.ok(after);
  assert.doesNotMatch(after.prompt, /do not re-author it/);
  assert.doesNotMatch(after.prompt, /rejected in review/);
});

// The note must carry the rejection's timestamp and head: an undated verdict rides every later
// prompt as if fresh even after main satisfied the objection, because the paths that never
// reach a model review leave lastReview standing (BUGS.md, undated rejection note).
test("the rejected-review note on the next tick's prompt is dated and names the reviewed head", () => {
  const result = promptFor(root(), "feature", {
    state: {
      lastReview: {
        verdict: "reject",
        reasons: ["md-only BUGS.md edit"],
        head: "8b58124aabcdef",
        at: new Date(2026, 8, 24, 1, 20, 32).getTime(),
      },
    },
  });
  assert.ok(result);
  assert.match(result.prompt, /rejected in review \(2026-09-24 01:20:32, head 8b58124a\):/);
});

test("a conflict discard note rides along, with its attempt count", () => {
  const result = promptFor(root(), "feature", {
    state: { conflictDiscard: { sha: "abc123", summary: "reworked the merge module", attempts: 3, at: 1 } },
  });
  assert.ok(result);
  assert.match(result.prompt, /reworked the merge module/);
  assert.match(result.prompt, /3/);
});

test("a cut-off streak appends the cut-off note naming the streak", () => {
  const result = promptFor(root(), "feature", { state: { cutOffStreak: 2 } });
  assert.ok(result);
  assert.match(result.prompt, /Your previous 2 runs as this loop ran out of context/);
});

test("notes compose in order — review rejection, then discard, then cut-off — after the base prompt", () => {
  const dir = root();
  fs.writeFileSync(
    path.join(dir, "PRINCIPLES.md"),
    "Small beats big.\n",
  );
  const result = promptFor(dir, "feature", {
    state: {
      lastReview: { verdict: "reject", reasons: ["reason A"], at: 1 },
      conflictDiscard: { sha: "abc", summary: "discarded work", attempts: 1, at: 2 },
      cutOffStreak: 2,
    },
  });
  assert.ok(result);
  const prompt = result.prompt;
  const base = prompt.indexOf("</principles>");
  const reject = prompt.indexOf("reason A");
  const discard = prompt.indexOf("discarded work");
  const cut = prompt.indexOf("previous 2 runs");
  assert.ok(base >= 0 && reject > base && discard > reject && cut > discard, "notes must follow the base prompt in order");
});

test("a clean state appends none of the cross-tick notes", () => {
  const result = promptFor(root(), "feature");
  assert.ok(result);
  // The only place the note texts appear is the appended tail; a clean tick must carry none.
  const marker = result.prompt.lastIndexOf("</project-prompt>");
  const tail = result.prompt.slice(marker);
  assert.doesNotMatch(tail, /ran out of context/);
});

test("the brief's initial prompt survives an over-long hand edit via the truncation backstop", () => {
  const dir = tmpdir();
  const long = "x".repeat(5_000);
  fs.writeFileSync(
    path.join(dir, "README.md"),
    `# proj\n\n${PROMPT_START}\n${long}\n${PROMPT_END}\n\n${STATUS_START}\n${STATUS_END}\n`,
  );
  const result = promptFor(dir, "coverage");
  assert.ok(result);
  assert.match(result.prompt, /\[initial prompt truncated at 4096 chars\]/);
});

// PLANS.md "Per-role prompts 1/2": `tumwater prompt --role <id>` queues a prompt only that
// loop's next tick sees — dequeued here, riding as the tick's userPrompt and an explicit
// <user-request> block in the prompt text.
test("a queued per-role prompt is dequeued into that role's prompt only", () => {
  const dir = root();
  enqueueRolePrompt(dir, "coverage", "check the export flow");
  const coverage = promptFor(dir, "coverage");
  assert.ok(coverage);
  assert.equal(coverage.userPrompt, "check the export flow");
  assert.match(coverage.prompt, /<user-request>\ncheck the export flow\n<\/user-request>/);

  // Another role's assembly dequeues nothing: no request block, no userPrompt.
  const qa = promptFor(dir, "qa");
  assert.ok(qa);
  assert.equal(qa.userPrompt, null);
  assert.ok(!qa.prompt.includes("<user-request>"));

  // The dequeue drained the queue: the next assembly finds nothing queued.
  const again = promptFor(dir, "coverage");
  assert.ok(again);
  assert.equal(again.userPrompt, null);
  assert.ok(!again.prompt.includes("<user-request>"));
});

// A deferred prompt (`tumwater prompt --at <duration>`) delivers once its not-before time has
// passed; the marker line is plumbing (src/inbox/prompt-not-before.ts) and must never reach the loop — the same
// strip every display surface applies (stripNotBeforeMarker).
test("a delivered deferred prompt rides without its not-before marker line", () => {
  const dir = root();
  enqueueRolePrompt(dir, "coverage", "check the export flow", Date.now() - 60_000);
  const result = promptFor(dir, "coverage");
  assert.ok(result);
  assert.equal(result.userPrompt, "check the export flow");
  assert.match(result.prompt, /<user-request>\ncheck the export flow\n<\/user-request>/);
  assert.ok(!result.prompt.includes("tumwater:not-before"), "the marker is plumbing, not content");
});

// The director's deferred prompt has the same contract: `tumwater prompt --at <duration>`
// with no --role lands in the director's queue, and the marker is plumbing there too.
test("a delivered deferred director prompt rides without its not-before marker line", () => {
  const dir = root();
  enqueueRolePrompt(dir, DIRECTOR_ROLE, "re-check the release notes", Date.now() - 60_000);
  const result = promptFor(dir, DIRECTOR_ROLE);
  assert.ok(result);
  assert.equal(result.userPrompt, "re-check the release notes");
  assert.ok(!result.prompt.includes("tumwater:not-before"), "the marker is plumbing, not content");
});

// The clean role's stranded-plan block (src/backlog/backlog-structure.ts, plans part 3/4): the repair
// evidence rides in the tick prompt only when the primary checkout's PLANS.md is stranded.

const STRANDED_PLANS = `# Plans

## Planned

_None yet._

## Done

### Timed pause support (planned 2026-09-25)

**Goal.** It waited here for hours.
`;

test("a clean tick's prompt carries the <backlog-structure> block for a stranded PLANS.md", () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, "PLANS.md"), STRANDED_PLANS);
  const result = promptFor(dir, "clean");
  assert.ok(result);
  assert.match(result.prompt, /<backlog-structure>\n-\s*\(now under ## Done\) Timed pause support \(planned 2026-09-25\)\n<\/backlog-structure>/);
});

test("a clean tick on a clean PLANS.md has no <backlog-structure> block", () => {
  const dir = root();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    "# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n### Landed (planned 2026-09-10, done 2026-09-11)\n",
  );
  const result = promptFor(dir, "clean");
  assert.ok(result);
  // The role's find text names the block, so assert on the rendered block's evidence lines.
  assert.ok(!result.prompt.includes("(now under ##"));
});

test("other roles never see the <backlog-structure> block, and the clean find text names it", () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, "PLANS.md"), STRANDED_PLANS);
  const coverage = promptFor(dir, "coverage");
  assert.ok(coverage);
  assert.ok(!coverage.prompt.includes("(now under ##"));
  const clean = roleById("clean");
  assert.ok(clean);
  assert.match(clean.find, /<backlog-structure>/);
});

// --- the preview seam (`tumwater role <id>`'s next-prompt view) ---
// A preview must assemble the same prompt a real tick would run on — queued user request,
// state-derived notes, everything — while provably consuming nothing: the queued prompt is
// peeked (read, never unlinked), so an inspection can never cost a loop its queued work.

test("preview mode assembles the queued prompt without consuming it", () => {
  const dir = root();
  enqueueRolePrompt(dir, "coverage", "please look at the cache module");
  const input = { root: dir, config: defaultConfig(), role: "coverage", state: state({ role: "coverage" }) };
  const first = assembleTickPrompt({ ...input, preview: true });
  const second = assembleTickPrompt({ ...input, preview: true });
  assert.ok(first && second);
  assert.match(first.prompt, /<user-request>\nplease look at the cache module\n<\/user-request>/);
  // Two previews read the same queue: identical prompts, and the queue file still there.
  assert.equal(first.prompt, second.prompt);
  assert.equal(inboxSize(dir, "coverage"), 1);
  // The real dequeue still consumes — the preview path is the only thing that changed.
  const real = assembleTickPrompt(input);
  assert.ok(real);
  assert.match(real.prompt, /please look at the cache module/);
  assert.equal(inboxSize(dir, "coverage"), 0);
});

test("an instance loop id runs its base role's charter and instructions", () => {
  const dir = root();
  const config = defaultConfig();
  config.roles.feature = {
    ...(config.roles.feature ?? { enabled: true }),
    instructions: "Prefer the smallest diff.",
  };
  const result = promptFor(dir, "feature-2", { config });
  assert.ok(result);
  assert.match(result.prompt, /You are the "feature" loop/);
  assert.match(result.prompt, /Prefer the smallest diff\./);
});

test("a director preview peeks its inbox and an empty inbox still assembles to null", () => {
  const dir = root();
  enqueuePrompt(dir, "add a changelog");
  const input = { root: dir, config: defaultConfig(), role: DIRECTOR_ROLE, state: state({ role: DIRECTOR_ROLE }) };
  const preview = assembleTickPrompt({ ...input, preview: true });
  assert.ok(preview);
  assert.match(preview.prompt, /add a changelog/);
  assert.equal(inboxSize(dir, DIRECTOR_ROLE), 1); // peeked, not dequeued
  // An empty inbox (here: the whole state dir removed) assembles to null in both modes —
  // preview changes the read, never the nothing-to-run answer.
  fs.rmSync(path.join(dir, ".tumwater"), { recursive: true, force: true });
  assert.equal(assembleTickPrompt({ ...input, preview: true }), null);
  assert.equal(assembleTickPrompt(input), null);
});
