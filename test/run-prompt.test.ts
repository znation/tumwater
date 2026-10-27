import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { logEvent } from "../src/events/events.js";
import { FLAKY_WARNING_PREFIX } from "../src/review/known-flakes.js";
import { assembleRunPrompt } from "../src/run/run-prompt.js";
import { entryKey } from "../src/backlog/backlog-parts.js";
import { defaultConfig } from "../src/config/config.js";
import { DIRECTOR_ROLE, roleById, allRoleIds } from "../src/roles/roles.js";
import { briefTemplate, readmeTemplate } from "../src/brief/brief.js";
import { enqueuePrompt, enqueueRolePrompt, inboxSize } from "../src/inbox/inbox.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { qaCoveragePath, roleNotesPath, feedbackFilingsPath } from "../src/paths.js";
import { ROLE_NOTES_MAX_BYTES } from "../src/agent/role-notes-write.js";
import { freshRunnerState, type RunnerState } from "../src/runner/runner-state.js";
import { applyMergeOutcome } from "../src/run/run-apply.js";
import { CHECK_DECLARATION_MARKER } from "../src/roles/role-guidance.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

/** Unit coverage for src/run/run-prompt.ts — the assembly of what one role's run actually runs
 * on. The builders themselves (prompt.ts, gate-prompts.ts, gate-notes.ts) are covered elsewhere;
 * this is the composition: brief resolution (TUMWATER.md before README.md), the director's inbox
 * dequeue (empty inbox = nothing to run), the qa/selfcheck evidence blocks, custom roles, and the
 * cross-run memory notes (rejected review, conflict discard, cut-off streak) appended in
 * order — the only memory a fresh session has of why the last attempt failed. */

const BRIEF = readmeTemplate("proj", "Build a tiny thing.\nWith care.");

function root(): string {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "README.md"), BRIEF);
  return dir;
}

function state(overrides: Partial<RunnerState> = {}): RunnerState {
  // The production constructor, not a hand-rolled literal: a copied field list drifts
  // silently when runner-state.ts grows a field (this one had already dropped dayStamp and
  // dayCostUsd), while a spread over freshRunnerState picks the shape up automatically.
  return { ...freshRunnerState("coverage"), ...overrides };
}

/** assembleRunPrompt with the suite's standing inputs — defaultConfig() and a fresh role
 * state carrying the same role — so a call site cannot pass a role that disagrees with its
 * state's. `overrides` carries the few custom configs and pinned state fields; the
 * preview-seam tests below keep calling assembleRunPrompt directly, since they share one
 * input object between peek and dequeue. */
function promptFor(
  root: string,
  role: string,
  overrides: { config?: ReturnType<typeof defaultConfig>; state?: Partial<RunnerState> } = {},
): ReturnType<typeof assembleRunPrompt> {
  return assembleRunPrompt({
    root,
    config: overrides.config ?? defaultConfig(),
    role,
    state: state({ role, ...overrides.state }),
  });
}

test("a role run prompt names the brief file and embeds the principles and the role's task — with no user prompt", () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, "PRINCIPLES.md"), "Small beats big.\n");
  const result = promptFor(dir, "coverage");
  assert.ok(result);
  assert.equal(result.userPrompt, null);
  assert.match(result.prompt, /You are the "coverage" role/);
  assert.match(result.prompt, /<principles>\nSmall beats big\.\n<\/principles>/);
  // The brief is not inlined: the rule names the resolved file, the README compatibility
  // default here, and the run reads it.
  assert.doesNotMatch(result.prompt, /<project-prompt>|Build a tiny thing/);
  assert.match(result.prompt, /read the project brief \(README\.md\) in full/);
});

test("an explicit agent override selects the dialect over the config's primary", () => {
  // The effective-agent seam planRunStart drives: a role whose config resolves to pi but
  // whose active fallback is claude must get claude's prompt dialect. `agent` overrides the
  // role's primary `configForRole(...).agent`; omitted, the primary still wins (pinned by the
  // tests above, whose prompts carry pi's wording).
  const dir = root();
  const result = assembleRunPrompt({
    root: dir,
    config: defaultConfig(),
    role: "coverage",
    state: state({ role: "coverage" }),
    backend: "claude",
  });
  assert.ok(result);
  assert.match(result.prompt, /tumwater-notes write <<'TUMWATER_NOTES'/, "the override's run names the notes command");
  assert.ok(!result.prompt.includes("mcp__tumwater__role_notes"), "no MCP notes tool name on claude");
  assert.ok(!result.prompt.includes("call role_notes with"), "never the pi tool name");
});

test("a repo whose brief markers are gone still assembles a prompt naming README.md", () => {
  // The degraded-but-running state: an operator edit (or a docs role rewrite) can strip the
  // markers, leaving no file that owns the brief. The team must keep running — readBriefText
  // degrades to an empty brief and the fallback names the compatibility path, not a dead end.
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "README.md"), "# My project\n\nNo markers here.\n");
  const result = promptFor(dir, "coverage");
  assert.ok(result);
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
  assert.match(result.prompt, /You are the "director" role/);
  assert.match(result.prompt, /prefer no third-party deps/);
});

test("a director's standing rejection leads its prompt before the request and the charter", () => {
  const dir = root();
  enqueuePrompt(dir, "prefer no third-party deps");
  const result = promptFor(dir, DIRECTOR_ROLE, {
    state: { lastReview: { verdict: "reject", reasons: ["violates zero-deps"], at: 1 } },
  });
  assert.ok(result);
  const prompt = result.prompt ?? "";
  const reject = prompt.indexOf("it is this run's primary task");
  const charter = prompt.indexOf('You are the "director" role');
  const request = prompt.indexOf("prefer no third-party deps");
  assert.ok(
    reject >= 0 && reject < charter && reject < request,
    "the rejection leads the director's charter and queued request",
  );
});

test("a director run receives its roles.director.instructions override", () => {
  const dir = root();
  enqueuePrompt(dir, "add dark mode");
  const config = defaultConfig();
  config.roles[DIRECTOR_ROLE] = { ...config.roles[DIRECTOR_ROLE], enabled: true, instructions: "Prefer vitest." };
  const result = promptFor(dir, DIRECTOR_ROLE, { config });
  assert.ok(result);
  assert.match(result.prompt, /Additional standing instructions from the user:\nPrefer vitest\./);
});

test("a director's instructions override rides the preview peek without consuming the inbox", () => {
  const dir = root();
  enqueuePrompt(dir, "add dark mode");
  const config = defaultConfig();
  config.roles[DIRECTOR_ROLE] = { ...config.roles[DIRECTOR_ROLE], enabled: true, instructions: "Prefer vitest." };
  const input = { root: dir, config, role: DIRECTOR_ROLE, state: state({ role: DIRECTOR_ROLE }) };
  const preview = assembleRunPrompt({ ...input, preview: true });
  assert.ok(preview);
  assert.match(preview.prompt, /Additional standing instructions from the user:\nPrefer vitest\./);
  assert.equal(inboxSize(dir, DIRECTOR_ROLE), 1); // peeked, not dequeued
});

test("a role run prompt injects the rendered <backlog-index> block from the primary checkout", () => {
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

// Work ratio 3/4: the plan role counts only entries feature could take now, and the index
// marks the held ones. One takeable entry beside four blocked ones leaves the plan role below
// its target, so the new independence rule tells it what to write instead.
test("the plan prompt counts only takeable entries and marks the blocked ones in the index", () => {
  const dir = root();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    [
      "# Plans",
      "## Planned",
      "### Base, part 1/2: a (planned 2026-10-01)",
      "body",
      "### Later, part 2/2: b (planned 2026-10-02; requires Base 1/2 landed)",
      "body",
      "### Later two, part 3/2: c (planned 2026-10-03; requires Base 1/2 landed)",
      "body",
      "### Later three, part 4/2: d (planned 2026-10-04; requires Base 1/2 landed)",
      "body",
      "### Later four, part 5/2: e (planned 2026-10-05; requires Base 1/2 landed)",
      "body",
      "## Done",
      "_None._",
    ].join("\n"),
  );
  const result = promptFor(dir, "plan");
  assert.ok(result);
  assert.match(result.prompt, /prefer a plan independent of the waiting series, so feature can run it alongside/);
  const blocked = result.prompt.match(/\[blocked: requires Base 1\/2\]/g) ?? [];
  assert.equal(blocked.length, 4, "all four dependents are marked blocked");
  assert.match(result.prompt, /It holds 1 now/);
});

test("the plan prompt reports zero eligible plans and other roles omit the count", () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, "PLANS.md"), "# Plans\n## Planned\n_None yet._\n## Done\n_None._\n");
  const plan = promptFor(dir, "plan");
  assert.ok(plan);
  assert.match(plan.prompt, /It holds 0 now/);
  const feature = promptFor(dir, "feature");
  assert.ok(feature);
  assert.doesNotMatch(feature.prompt, /It holds/);
});

// The role notes (PLANS.md "Role notebook"): the run reads the role's note file from disk.
// A missing file omits the block; the standing write instruction rides either way. The
// director's branch never reads the path, so its prompt carries neither.
test("a role run prompt reads the note from roleNotesPath, and omits the block when there is none", () => {
  const dir = root();
  const notes = roleNotesPath(dir, "coverage");
  writeFileDeep(notes, "coverage runs through the oracle helpers\n");
  const withNote = promptFor(dir, "coverage");
  assert.ok(withNote);
  assert.match(withNote.prompt, /<role-notes>\ncoverage runs through the oracle helpers\n<\/role-notes>/);
  assert.match(withNote.prompt, /tumwater-notes write <<'TUMWATER_NOTES'/);

  const past = new Date(2026, 8, 30, 12);
  fs.utimesSync(notes, past, past);
  assert.match(promptFor(dir, "coverage")!.prompt, /last saved 2026-09-30, /);

  fs.rmSync(notes);
  const without = promptFor(dir, "coverage");
  assert.ok(without);
  assert.ok(!without.prompt.includes("<role-notes>"), "a missing note file means no block");
  assert.match(without.prompt, /tumwater-notes write <<'TUMWATER_NOTES'/, "the write instruction is still present");
});

// The notes is bounded on read too: the tool caps writes at ROLE_NOTES_MAX_BYTES, but the
// file is hand-editable runtime state, so an over-long one must not ride into every prefill.
// A note at the cap (a byte is never fewer than a character) is untouched.
const NOTE_TRUNCATION_MARKER = `…[role notes truncated at ${ROLE_NOTES_MAX_BYTES} chars]`;
test("an over-long role note is truncated into the prompt with a visible marker", () => {
  const dir = root();
  const notes = roleNotesPath(dir, "coverage");

  writeFileDeep(notes, "x".repeat(ROLE_NOTES_MAX_BYTES));
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

test("a run whose notes name a planned part gets the live backlog block; the director has none", () => {
  const dir = root();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    [
      "# Plans",
      "## Planned",
      "### Codex backend, part 2b/9: b (planned 2026-10-01)",
      "**Needs review 2026-10-21 by feature: rejected after 2 review rounds**",
      "### Codex backend, part 2c/9: c (planned 2026-10-01; requires Codex backend 2b/9 landed)",
      "body",
      "## Done",
      "_None._",
    ].join("\n"),
  );
  const notes = roleNotesPath(dir, "coverage");
  writeFileDeep(notes, "Codex 2b/9 carry Refused — never re-add or re-author them; the Codex theme is dead\n");
  const withNote = promptFor(dir, "coverage");
  assert.ok(withNote);
  const notesEnd = withNote.prompt.indexOf("</role-notes>");
  const backlogIdx = withNote.prompt.indexOf("What the backlog says now");
  assert.ok(notesEnd >= 0 && backlogIdx > notesEnd, "the backlog block follows the live notes");
  assert.match(withNote.prompt, /- Codex backend, part 2b\/9 — needs review\b/);

  // A run whose notes name nothing from the backlog gets no block.
  fs.writeFileSync(notes, "where things live, what was ruled out\n");
  assert.ok(!promptFor(dir, "coverage")!.prompt.includes("What the backlog says now"));

  // The director never carries notes, so it never carries the block either.
  enqueuePrompt(dir, "what should we build next");
  const director = promptFor(dir, DIRECTOR_ROLE);
  assert.ok(director);
  assert.ok(!director.prompt.includes("What the backlog says now"), "director carries no backlog block");
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

test("a feature instance's claimed series part names its merged prerequisites", () => {
  const dir = root();
  const c = "S, part 3/3: c (requires parts 1/3–2/3 landed)";
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    `# Plans\n## Planned\n### ${c}\nbody c\n### Plain\nx\n## Done\n### s, part 2/3: b (done 2026-10-16)\nbody b\n### S, part 1/3: a (done 2026-10-15)\nbody a\n`,
  );
  const claimOf = (title: string, key: string) => ({
    file: "PLANS.md" as const, key, title, at: 1, source: "assigned" as const,
  });
  const result = promptFor(dir, "feature-2", { state: { claim: claimOf(c, entryKey(c)) } });
  assert.ok(result);
  assert.match(result.prompt, /<assigned-entry>/);
  assert.match(result.prompt, /<merged-prerequisites>/);
  assert.match(result.prompt, /"s, part 2\/3: b \(done 2026-10-16\)" \(PLANS\.md lines 8-9\)/);
  assert.match(result.prompt, /"S, part 1\/3: a \(done 2026-10-15\)" \(PLANS\.md lines 10-11\)/);
  const plain = promptFor(dir, "feature-2", { state: { claim: claimOf("Plain", "plain") } });
  assert.ok(plain);
  assert.doesNotMatch(plain.prompt, /<merged-prerequisites>/);
});

test("a feature instance's claimed series part names the parts waiting on it", () => {
  const dir = root();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    [
      "# Plans", "## Planned",
      "### S, part 1/3: a", "body a",
      "### Unrelated plan", "body u",
      "### S, part 2/3: b (requires part 1/3 landed)", "body b",
      "### S, part 3/3: c (requires part 2/3 landed)", "body c",
      "## Done", "_None._", "",
    ].join("\n"),
  );
  const claimOf = (title: string, file: "PLANS.md" | "BUGS.md" = "PLANS.md") => ({
    file, key: entryKey(title), title, at: 1, source: "assigned" as const,
  });
  const first = promptFor(dir, "feature", { state: { claim: claimOf("S, part 1/3: a") } });
  assert.ok(first);
  assert.match(first.prompt, /<assigned-entry>/);
  const note = /<waiting-parts>[\s\S]*<\/waiting-parts>/.exec(first.prompt)?.[0] ?? "";
  assert.match(note, /"S, part 2\/3: b \(requires part 1\/3 landed\)" \(PLANS\.md lines 7-8\)/);
  assert.match(note, /"S, part 3\/3: c \(requires part 2\/3 landed\)" \(PLANS\.md lines 9-10\)/);
  const last = promptFor(dir, "feature", { state: { claim: claimOf("S, part 3/3: c (requires part 2/3 landed)") } });
  assert.ok(last);
  assert.doesNotMatch(last.prompt, /<waiting-parts>/);
  const bug = promptFor(dir, "feature", { state: { claim: claimOf("S, part 1/3: a", "BUGS.md") } });
  assert.ok(bug);
  assert.doesNotMatch(bug.prompt, /<waiting-parts>/);
});

test("the assignment names the claimed entry's paths missing from the checkout", () => {
  const dir = root();
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "kept.ts"), "");
  const claim = { file: "PLANS.md" as const, key: "plan a", title: "Plan A", at: 1, source: "assigned" as const };
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    "# Plans\n## Planned\n### Plan A\nTouches `src/kept.ts`, `src/gone.ts` and `nodir/x.ts`.\n## Done\n_None._\n",
  );
  const result = promptFor(dir, "feature", { state: { claim } });
  assert.ok(result);
  const note = /<assigned-entry>[\s\S]*<\/assigned-entry>/.exec(result.prompt)?.[0] ?? "";
  assert.match(note, /`src\/gone\.ts`/);
  assert.doesNotMatch(note, /src\/kept\.ts|nodir\/x\.ts/);
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    "# Plans\n## Planned\n### Plan A\nTouches `src/kept.ts`.\n## Done\n_None._\n",
  );
  const clean = promptFor(dir, "feature", { state: { claim } });
  assert.ok(clean);
  assert.doesNotMatch(clean.prompt, /do not exist in your checkout/);
});

test("an unknown role throws — the team cannot run a prompt with no task", () => {
  assert.throws(
    () =>
      promptFor(root(), "nonexistent"),
    /unknown role: nonexistent \(valid ids: .+\)/,
  );
});

test("a custom role's task is its find-something-to-do text, titled by its name", () => {
  const config = defaultConfig();
  config.customRoles = [{ name: "changelog", task: "Keep CHANGELOG.md current." }];
  const result = promptFor(root(), "changelog", { config });
  assert.ok(result);
  assert.match(result.prompt, /You are the "changelog" role/);
  assert.match(result.prompt, /Your task this run:\nKeep CHANGELOG\.md current\./);
});

test("a runner whose role answers to nothing throws the shared unknown-role message, custom ids included", () => {
  // The race the defensive path exists for: a live tumwater.json edit removes a custom role
  // while its runner is still alive (runners are built at start and survive reloads), so the
  // next run's assembly finds neither a catalog entry nor a customRoles task. It must throw
  // the shared unknownRoleMessage — the same wording the CLI's parseRoleFlag and the operator
  // commands use — with the valid ids as the live config sees them, so if it ever fires it
  // reads as the harness bug it is instead of a bare dead end.
  const config = defaultConfig();
  config.customRoles = [{ name: "changelog", task: "Keep CHANGELOG.md current." }];
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
  assert.match(result.prompt, /Flow coverage \(from this team's own record; least recently exercised first\)/);
  assert.match(result.prompt, /status — .* ago, passed/);
  assert.match(result.prompt, /init — never exercised/);
});

test("the selfcheck role's prompt carries the failure digest rendered from its event log", () => {
  const dir = root();
  writeEvents(dir, [
    { ts: Date.now(), loop: "feature", type: "run_end", result: "error", error: "pi exited null" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const result = promptFor(dir, "selfcheck");
  assert.ok(result);
  assert.match(result.prompt, /Runtime failure digest of tumwater's own event log/);
  assert.match(result.prompt, /<failure-digest>\n[\s\S]*pi exited null[\s\S]*<\/failure-digest>/);
  assert.ok(result.prompt.includes('--grep="tumwater(selfcheck)" --grep="tumwater(telemetry)"'));
  // The digest is the selfcheck role's evidence block, not the coverage ledger's.
  assert.doesNotMatch(result.prompt, /Flow coverage/);
});

test("the feedback role's prompt carries the failure digest rendered from its event log", () => {
  const dir = root();
  writeEvents(dir, [
    { ts: Date.now(), loop: "feature", type: "run_end", result: "error", error: "pi exited null" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const result = promptFor(dir, "feedback");
  assert.ok(result);
  assert.match(result.prompt, /Runtime failure digest of tumwater's own event log/);
  assert.match(result.prompt, /<failure-digest>\n[\s\S]*pi exited null[\s\S]*<\/failure-digest>/);
});

test("the feedback role's prompt carries the previously-filed block from the ledger", () => {
  const dir = root();
  fs.mkdirSync(path.join(dir, ".tumwater", "state"), { recursive: true });
  fs.writeFileSync(
    feedbackFilingsPath(dir),
    JSON.stringify({ filings: [{ issue: 12, title: "a bug", filedAt: 1_800_000_000_000 }] }),
  );
  const result = promptFor(dir, "feedback");
  assert.ok(result);
  assert.match(result.prompt, /Previously filed from this install:/);
  assert.match(result.prompt, /#12 a bug \(\d+[mhd]\)/);
});

test("no role other than feedback carries the previously-filed block", () => {
  const dir = root();
  fs.mkdirSync(path.join(dir, ".tumwater", "state"), { recursive: true });
  // A populated ledger present for every role, so only the feedback gate can be the difference.
  fs.writeFileSync(
    feedbackFilingsPath(dir),
    JSON.stringify({ filings: [{ issue: 12, title: "a bug", filedAt: 1_800_000_000_000 }] }),
  );
  for (const role of ["qa", "selfcheck", "coverage", "feature"]) {
    const result = promptFor(dir, role);
    assert.ok(result);
    assert.doesNotMatch(result.prompt, /Previously filed from this install:/, role);
  }
});

test("a role other than qa, selfcheck or feedback gets neither evidence block", () => {
  const result = promptFor(root(), "coverage");
  assert.ok(result);
  assert.doesNotMatch(result.prompt, /Flow coverage/);
  assert.doesNotMatch(result.prompt, /<failure-digest>/);
});

test("a rejected review rides along on the next run's prompt, reasons intact", () => {
  const result = promptFor(root(), "feature", {
    state: { lastReview: { verdict: "reject", reasons: ["the test lies about coverage"], at: 1 } },
  });
  assert.ok(result);
  assert.match(result.prompt, /the test lies about coverage/);
});

test("an exhausted feature rejection carries the Needs-review note instruction on the next run", () => {
  const result = promptFor(root(), "feature", {
    state: { lastReview: { verdict: "reject", reasons: ["still wrong"], at: 1, exhausted: true } },
  });
  assert.ok(result);
  assert.match(result.prompt, /rejected after <N> review rounds/);
  assert.match(result.prompt, /do not re-author it/);
});

// A feature instance keeps its claim through an exhausted chain, so its next prompt carries the
// same <assigned-entry> beside the rejection. With the plan-less wording ("take a different
// theme") the only way out the assignment offered was a Refused note (2026-10-21).
test("a feature instance's exhausted rejection carries the Needs-review note instruction beside its claim", () => {
  const dir = root();
  const title = "Plan X";
  fs.writeFileSync(path.join(dir, "PLANS.md"), `# Plans\n## Planned\n### ${title}\nbody\n## Done\n`);
  const result = promptFor(dir, "feature-2", {
    state: {
      lastReview: { verdict: "reject", reasons: ["still wrong"], at: 1, exhausted: true },
      claim: { file: "PLANS.md", key: entryKey(title), title, at: 1, source: "assigned" },
    },
  });
  assert.ok(result);
  assert.match(result.prompt, /<assigned-entry>/);
  assert.match(result.prompt, /append \*\*Needs review/);
  assert.doesNotMatch(result.prompt, /take a different theme/);
});

// Feature is told to merge a markdown-only Needs-review note when a change exhausts its revision
// rounds. That merge is review-exempt, so it records no verdict; the merge fold clears the
// standing rejection instead (clearSupersededRejection, run-apply.ts). This pins that the
// instruction retires after the note merges rather than re-injecting and letting feature re-mark
// an entry the plan role has already replanned.
test("the exhausted-feature Needs-review instruction retires once the markdown-only note merges", () => {
  const dir = root();
  const s = state({
    role: "feature",
    lastReview: { verdict: "reject", reasons: ["still wrong"], at: 1, exhausted: true },
  });
  const before = promptFor(dir, "feature", { state: s });
  assert.ok(before);
  // The feature charter itself names "Needs review", so the note is recognized by its
  // exhausted-rejection sentence, not the bare phrase.
  assert.match(before.prompt, /do not re-author it/);
  // The markdown-only Needs-review note merges review-exempt: no model verdict is
  // recorded, only the
  // merge fold fires.
  applyMergeOutcome(s, "changed", { sha: "a".repeat(40), summary: "marked plan X with a Needs-review note" });
  const after = promptFor(dir, "feature", { state: s });
  assert.ok(after);
  assert.doesNotMatch(after.prompt, /do not re-author it/);
  assert.doesNotMatch(after.prompt, /it is this run's primary task/);
});

// The note must carry the rejection's timestamp and head: an undated verdict rides every later
// prompt as if fresh even after main satisfied the objection, because the paths that never
// reach a model review leave lastReview standing (BUGS.md, undated rejection note).
test("the rejected-review note on the next run's prompt is dated and names the reviewed head", () => {
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
  assert.match(result.prompt, /rejected; fix each numbered objection or drop the change — it is this run's primary task \(2026-09-24 01:20:32, head 8b58124a\):/);
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
  assert.match(result.prompt, /Your previous 2 runs as this role ran out of context/);
});

test("notes compose in order — the rejection leads, then discard, then cut-off, after the base prompt", () => {
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
  const reject = prompt.indexOf("reason A");
  const base = prompt.indexOf("</principles>");
  const charter = prompt.indexOf("Your task this run");
  const discard = prompt.indexOf("discarded work");
  const cut = prompt.indexOf("previous 2 runs");
  assert.ok(reject >= 0 && reject < base && reject < charter, "the rejection must lead the base prompt and the charter");
  assert.ok(discard > base && cut > discard, "discard and cut-off notes follow the base prompt in order");
});

test("a clean state appends none of the cross-run notes", () => {
  const result = promptFor(root(), "feature");
  assert.ok(result);
  // The note texts appear only in the appended tail; a clean run's prompt carries none.
  assert.doesNotMatch(result.prompt, /ran out of context/);
});

// `tumwater prompt --role <id>` queues a prompt only that
// role's next run sees — dequeued here, riding as the run's userPrompt and an explicit
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
// passed; the marker line is plumbing (src/inbox/prompt-not-before.ts) and must never reach the
// role — the same
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

// The clean role's stranded-plan block (src/backlog/backlog-structure.ts, plans part 3/4): the
// repair
// evidence rides in the run prompt only when the primary checkout's PLANS.md is stranded.

const STRANDED_PLANS = `# Plans

## Planned

_None yet._

## Done

### Timed pause support (planned 2026-09-25)

**Goal.** It waited here for hours.
`;

test("a clean run's prompt carries the <backlog-structure> block for a stranded PLANS.md", () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, "PLANS.md"), STRANDED_PLANS);
  const result = promptFor(dir, "clean");
  assert.ok(result);
  assert.match(result.prompt, /<backlog-structure>\n-\s*\(now under ## Done\) Timed pause support \(planned 2026-09-25\)\n<\/backlog-structure>/);
});

test("a clean run on a clean PLANS.md has no <backlog-structure> block", () => {
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
// A preview must assemble the same prompt a real run would run on — queued user request,
// state-derived notes, everything — while provably consuming nothing: the queued prompt is
// peeked (read, never unlinked), so an inspection can never cost a role its queued work.

test("preview mode assembles the queued prompt without consuming it", () => {
  const dir = root();
  enqueueRolePrompt(dir, "coverage", "please look at the cache module");
  const input = { root: dir, config: defaultConfig(), role: "coverage", state: state({ role: "coverage" }) };
  const first = assembleRunPrompt({ ...input, preview: true });
  const second = assembleRunPrompt({ ...input, preview: true });
  assert.ok(first && second);
  assert.match(first.prompt, /<user-request>\nplease look at the cache module\n<\/user-request>/);
  // Two previews read the same queue: identical prompts, and the queue file still there.
  assert.equal(first.prompt, second.prompt);
  assert.equal(inboxSize(dir, "coverage"), 1);
  // The real dequeue still consumes — the preview path is the only thing that changed.
  const real = assembleRunPrompt(input);
  assert.ok(real);
  assert.match(real.prompt, /please look at the cache module/);
  assert.equal(inboxSize(dir, "coverage"), 0);
});

test("an instance role id runs its base role's charter and instructions", () => {
  const dir = root();
  const config = defaultConfig();
  config.roles.feature = {
    ...(config.roles.feature ?? { enabled: true }),
    instructions: "Prefer the smallest diff.",
  };
  const result = promptFor(dir, "feature-2", { config });
  assert.ok(result);
  assert.match(result.prompt, /You are the "feature" role/);
  assert.match(result.prompt, /Prefer the smallest diff\./);
});

test("the plan charter's stop target scales with feature.instances", () => {
  const dir = root();
  const config = defaultConfig();
  const atDefault = promptFor(dir, "plan", { config });
  assert.ok(atDefault);
  assert.match(atDefault.prompt, /2 or more eligible plans/);
  assert.doesNotMatch(atDefault.prompt, /\{\{/);
  config.roles.feature = { ...(config.roles.feature ?? { enabled: true }), instances: 3 };
  const scaled = promptFor(dir, "plan", { config });
  assert.ok(scaled);
  assert.match(scaled.prompt, /4 or more eligible plans/);
});

test("a director preview peeks its inbox and an empty inbox still assembles to null", () => {
  const dir = root();
  enqueuePrompt(dir, "add a changelog");
  const input = { root: dir, config: defaultConfig(), role: DIRECTOR_ROLE, state: state({ role: DIRECTOR_ROLE }) };
  const preview = assembleRunPrompt({ ...input, preview: true });
  assert.ok(preview);
  assert.match(preview.prompt, /add a changelog/);
  assert.equal(inboxSize(dir, DIRECTOR_ROLE), 1); // peeked, not dequeued
  // An empty inbox (here: the whole state dir removed) assembles to null in both modes —
  // preview changes the read, never the nothing-to-run answer.
  fs.rmSync(path.join(dir, ".tumwater"), { recursive: true, force: true });
  assert.equal(assembleRunPrompt({ ...input, preview: true }), null);
  assert.equal(assembleRunPrompt(input), null);
});

function flake(dir: string, headline: string): void {
  logEvent(dir, { source: "review", type: "warning", message: `${FLAKY_WARNING_PREFIX}${headline}` });
}

test("the bugfix prompt carries the gate's flake tally after the task text; other roles do not", () => {
  const dir = root();
  flake(dir, "suite alpha broke");
  flake(dir, "suite alpha broke");
  for (const role of ["bugfix", "bugfix-2"]) {
    const result = promptFor(dir, role);
    assert.ok(result);
    assert.match(result.prompt, /Flaky checks:/);
    assert.match(result.prompt, /"suite alpha broke" ×2/);
    assert.ok(result.prompt.indexOf("Flaky checks:") > result.prompt.indexOf("Your task this run:"));
  }
  assert.doesNotMatch(promptFor(dir, "feature")!.prompt, /Flaky checks:/);
});

test("the bugfix prompt omits the flake tally over an empty log and caps it at five entries", () => {
  assert.doesNotMatch(promptFor(root(), "bugfix")!.prompt, /Flaky checks:/);
  const dir = root();
  for (const name of ["a", "b", "c", "d", "e", "f"]) flake(dir, `suite ${name} broke`);
  const prompt = promptFor(dir, "bugfix")!.prompt;
  assert.match(prompt, /\(and 1 more\)/);
  assert.equal(prompt.match(/" ×1/g)?.length, 5);
});

// ---- assigned and unassigned runs -------------------------------------------

test("an assigned run drops the backlog index and keeps its assignment", () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, "BUGS.md"), "# Bugs\n## Open\n### Real bug\nRepro.\n## Fixed\n_None._\n");
  const claim = { file: "BUGS.md" as const, key: "real bug", title: "Real bug", at: 1, source: "assigned" as const };
  const result = promptFor(dir, "bugfix-2", { state: { claim } });
  assert.ok(result);
  // The block itself; the charter's choosing steps still name it, and the orientation says why
  // an assigned run has none.
  assert.doesNotMatch(result.prompt, /^<backlog-index>$/m);
  assert.match(result.prompt, /this prompt carries no backlog index/);
  assert.match(result.prompt, /<assigned-entry>[\s\S]*BUGS\.md lines 3-4/);
  assert.match(result.prompt, /Read your assigned entry \(at the end of this prompt\)/);
});

test("a run without an assignment reads the brief file and keeps the backlog index", () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, "BUGS.md"), "# Bugs\n## Open\n### Real bug\nRepro.\n## Fixed\n_None._\n");
  const result = promptFor(dir, "bugfix");
  assert.ok(result);
  assert.match(result.prompt, /^<backlog-index>$/m);
  assert.match(result.prompt, /First read the project brief \(README\.md\) in full/);
  assert.match(result.prompt, /is re-sent on every turn/);
});

test("a run's queued request counts as unassigned, so it keeps the backlog index", () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, "BUGS.md"), "# Bugs\n## Open\n### Real bug\nRepro.\n## Fixed\n_None._\n");
  enqueueRolePrompt(dir, "bugfix-2", "look at the flaky test");
  const claim = { file: "BUGS.md" as const, key: "real bug", title: "Real bug", at: 1, source: "assigned" as const };
  const result = promptFor(dir, "bugfix-2", { state: { claim } });
  assert.ok(result);
  assert.match(result.prompt, /<user-request>/);
  assert.match(result.prompt, /<backlog-index>/);
  assert.doesNotMatch(result.prompt, /<assigned-entry>/);
});

test("a director run reads the brief file instead of carrying the brief", () => {
  const dir = root();
  enqueuePrompt(dir, "what should we build next");
  const result = assembleRunPrompt({ root: dir, config: defaultConfig(), role: DIRECTOR_ROLE, state: state({ role: DIRECTOR_ROLE }), preview: true });
  assert.ok(result);
  assert.doesNotMatch(result.prompt, /<project-prompt>|Build a tiny thing/);
  assert.match(result.prompt, /First read the project brief \(README\.md\) in full/);
  assert.match(result.prompt, /<user-request>\nwhat should we build next/);
});

// A fixture PLANS.md whose one `## Planned` entry declares the project's check (carries
// CHECK_DECLARATION_MARKER), so the no-check note's marker decision can be pinned.
function declarationPlans(): string {
  return `# Plans\n\n## Planned\n\n### Declare the project's deterministic check (planned 2026-10-25 by the plan role)\n${CHECK_DECLARATION_MARKER}\n\nDeclare and wire the project's check.\n\n## Done\n\n_None yet._\n`;
}

test("the plan prompt carries the no-check note only while no declaration plan waits", () => {
  // A fresh root declares no check (no check.command and no qualifying package.json +
  // node_modules), and no declaration plan waits — so the plan prompt gets the plan note.
  // Assert on the note's own wording: the plan charter names the <no-check> block itself, so
  // the bare tag appears even when no note is injected.
  const PLAN_NOTE = "Before anything else, write the entry that declares one";
  const dir = root();
  const plan = promptFor(dir, "plan");
  assert.ok(plan);
  assert.ok(plan.prompt.includes(PLAN_NOTE), "the plan prompt carries the plan note when no declaration plan waits");
  assert.ok(plan.prompt.includes(CHECK_DECLARATION_MARKER), "the plan note names the marker to write");
  assert.match(plan.prompt, /### Declare the project's deterministic check/);
  // No marker yet → the feature prompt carries no note (its charter names the tag, so use the
  // feature note's own request-file wording).
  const FEATURE_NOTE = ".tumwater-config-request.json";
  const feature = promptFor(dir, "feature");
  assert.ok(feature);
  assert.ok(!feature.prompt.includes(FEATURE_NOTE), "the feature prompt carries no note before a declaration plan waits");

  // With the marked entry waiting, the reverse: the plan prompt drops the note, the feature's
  // gains it.
  fs.writeFileSync(path.join(dir, "PLANS.md"), declarationPlans());
  const plan2 = promptFor(dir, "plan");
  assert.ok(plan2);
  assert.ok(!plan2.prompt.includes(PLAN_NOTE), "the plan prompt drops the note once a declaration plan waits");
  const feature2 = promptFor(dir, "feature");
  assert.ok(feature2);
  assert.ok(feature2.prompt.includes(FEATURE_NOTE), "the feature prompt gains the note once one waits");
  assert.ok(feature2.prompt.includes(CHECK_DECLARATION_MARKER), "the feature note names the marker entry");
});

test("a declared check gets neither no-check note, even with a declaration plan waiting", () => {
  const dir = root();
  const config = defaultConfig();
  config.check = { command: "make check" };
  const PLAN_NOTE = "Before anything else, write the entry that declares one";
  const FEATURE_NOTE = ".tumwater-config-request.json";
  const plan = promptFor(dir, "plan", { config });
  const feature = promptFor(dir, "feature", { config });
  assert.ok(plan && feature);
  assert.ok(!plan.prompt.includes(PLAN_NOTE), "a declared check suppresses the plan note");
  assert.ok(!feature.prompt.includes(FEATURE_NOTE), "a declared check suppresses the feature note");
  // The note is gated on check === undefined, so even the otherwise note-triggering marker entry
  // cannot add it once a check is declared: with the declaration plan waiting, neither prompt
  // carries the note.
  fs.writeFileSync(path.join(dir, "PLANS.md"), declarationPlans());
  const plan2 = promptFor(dir, "plan", { config });
  const feature2 = promptFor(dir, "feature", { config });
  assert.ok(plan2 && feature2);
  assert.ok(!plan2.prompt.includes(PLAN_NOTE), "a declared check keeps the plan prompt note-free");
  assert.ok(!feature2.prompt.includes(FEATURE_NOTE), "a declared check keeps the feature prompt note-free");
});

// The prompt-input readers never follow a symlink out of the worktree (INV-G3/G4's lstat
// policy): a hostile note or principles file that is a symlink to an arbitrary host path must
// not pull that file's text into the model's prompt. The reader treats the symlink as absent,
// so the matching block is omitted rather than reflecting the outside file.
test("a symlinked role notes file never injects the outside file's text into the run prompt", () => {
  const dir = root();
  const notes = roleNotesPath(dir, "coverage");
  // Create the parent directory so the symlink has somewhere to live.
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  const outside = path.join(dir, "..", "host-secret.txt"); // resolves outside the worktree
  fs.writeFileSync(outside, "PRIVATE HOST CONTENTS\n");
  fs.symlinkSync(outside, notes);

  const result = promptFor(dir, "coverage");
  assert.ok(result);
  assert.ok(!result.prompt.includes("PRIVATE HOST CONTENTS"), "the outside file's text must not reach the prompt");
  assert.ok(!result.prompt.includes("<role-notes>"), "a symlinked note reads as absent: no notes block");
});

test("a symlinked PRINCIPLES.md never injects the outside file's text into the run prompt", () => {
  const dir = root();
  const outside = path.join(dir, "..", "host-key.txt");
  fs.writeFileSync(outside, "SECRET HOST KEY MATERIAL\n");
  fs.symlinkSync(outside, path.join(dir, "PRINCIPLES.md"));

  const result = promptFor(dir, "coverage");
  assert.ok(result);
  assert.ok(!result.prompt.includes("SECRET HOST KEY MATERIAL"), "the outside file's text must not reach the prompt");
  assert.ok(!result.prompt.includes("<principles>"), "a symlinked principles file reads as empty: no principles block");
});
