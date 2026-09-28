import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assembleTickPrompt } from "../src/tick-prompt.js";
import { defaultConfig } from "../src/config.js";
import { DIRECTOR_ROLE } from "../src/roles.js";
import { PROMPT_END, PROMPT_START, STATUS_END, STATUS_START, briefTemplate, readmeTemplate } from "../src/readme.js";
import { enqueuePrompt, enqueueRolePrompt } from "../src/inbox.js";
import { qaCoveragePath } from "../src/paths.js";
import type { LoopState } from "../src/types.js";
import { tmpdir } from "./repo-fixtures.js";

/** Unit coverage for src/tick-prompt.ts — the assembly of what one loop's tick actually runs
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
  return {
    role: "coverage",
    ticks: 0,
    commits: 0,
    nextRunAt: 0,
    backoffSeconds: 0,
    lastMainHead: "",
    generatedTokens: 0,
    peakContextTokens: 0,
    totalCostUsd: 0,
    ...overrides,
  };
}

test("a role tick prompt embeds the brief, principles, and the role's task — with no user prompt", () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, "PRINCIPLES.md"), "Small beats big.\n");
  const result = assembleTickPrompt({
    root: dir,
    config: defaultConfig(),
    role: "coverage",
    state: state({ role: "coverage" }),
  });
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
  const result = assembleTickPrompt({
    root: dir,
    config: defaultConfig(),
    role: "coverage",
    state: state({ role: "coverage" }),
  });
  assert.ok(result);
  assert.doesNotMatch(result.prompt, /<project-prompt>/, "no brief content to embed");
  assert.match(result.prompt, /read the project brief \(README\.md\) in full/);
});

test("the brief resolves to TUMWATER.md when it owns the sections, and the prompt says so", () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, "TUMWATER.md"), briefTemplate("proj", "Build a tiny thing.\n"));
  const result = assembleTickPrompt({
    root: dir,
    config: defaultConfig(),
    role: "coverage",
    state: state(),
  });
  assert.ok(result);
  assert.match(result.prompt, /read the project brief \(TUMWATER\.md\) in full/);
});

test("the configured check's command is named as the verify step", () => {
  const config = defaultConfig();
  config.check = { command: "make check" };
  const result = assembleTickPrompt({
    root: root(),
    config,
    role: "coverage",
    state: state(),
  });
  assert.ok(result);
  assert.match(result.prompt, /verify with `make check` \(the project's declared check\)/);
});

test("a director with an empty inbox has nothing to run", () => {
  const dir = root();
  assert.equal(
    assembleTickPrompt({
      root: dir,
      config: defaultConfig(),
      role: DIRECTOR_ROLE,
      state: state({ role: DIRECTOR_ROLE }),
    }),
    null,
  );
});

test("a director's prompt is built from the dequeued request, returned as userPrompt", () => {
  const dir = root();
  enqueuePrompt(dir, "prefer no third-party deps");
  const result = assembleTickPrompt({
    root: dir,
    config: defaultConfig(),
    role: DIRECTOR_ROLE,
    state: state({ role: DIRECTOR_ROLE }),
  });
  assert.ok(result);
  assert.equal(result.userPrompt, "prefer no third-party deps");
  assert.match(result.prompt, /You are the "director" loop/);
  assert.match(result.prompt, /prefer no third-party deps/);
});

test("an unknown role throws — the fleet cannot run a prompt with no task", () => {
  assert.throws(
    () =>
      assembleTickPrompt({
        root: root(),
        config: defaultConfig(),
        role: "nonexistent",
        state: state(),
      }),
    /unknown role: nonexistent \(valid ids: .+\)/,
  );
});

test("a custom role's task is its find-something-to-do text, titled by its name", () => {
  const config = defaultConfig();
  config.customLoops = [{ name: "changelog", task: "Keep CHANGELOG.md current." }];
  const result = assembleTickPrompt({
    root: root(),
    config,
    role: "changelog",
    state: state({ role: "changelog" }),
  });
  assert.ok(result);
  assert.match(result.prompt, /You are the "changelog" loop/);
  assert.match(result.prompt, /Your task this run:\nKeep CHANGELOG\.md current\./);
});

test("the qa role's prompt carries the flow-coverage ledger rendered from disk", () => {
  const dir = root();
  fs.mkdirSync(path.join(dir, ".tumwater", "state"), { recursive: true });
  fs.writeFileSync(
    qaCoveragePath(dir),
    JSON.stringify({ flows: { status: { lastRunAt: 1_800_000_000_000, result: "passed" } } }),
  );
  const result = assembleTickPrompt({
    root: dir,
    config: defaultConfig(),
    role: "qa",
    state: state({ role: "qa" }),
  });
  assert.ok(result);
  assert.match(result.prompt, /Flow coverage \(from this fleet's own record; least recently exercised first\)/);
  assert.match(result.prompt, /status — .* ago, passed/);
  assert.match(result.prompt, /init — never exercised/);
});

test("a role other than qa or telemetry gets neither evidence block", () => {
  const result = assembleTickPrompt({
    root: root(),
    config: defaultConfig(),
    role: "coverage",
    state: state(),
  });
  assert.ok(result);
  assert.doesNotMatch(result.prompt, /Flow coverage/);
  assert.doesNotMatch(result.prompt, /<failure-digest>/);
});

test("a rejected review rides along on the next tick's prompt, reasons intact", () => {
  const result = assembleTickPrompt({
    root: root(),
    config: defaultConfig(),
    role: "feature",
    state: state({ lastReview: { verdict: "reject", reasons: ["the test lies about coverage"], at: 1 } }),
  });
  assert.ok(result);
  assert.match(result.prompt, /the test lies about coverage/);
});

// The note must carry the rejection's timestamp and head: an undated verdict rides every later
// prompt as if fresh even after main satisfied the objection, because the paths that never
// reach a model review leave lastReview standing (BUGS.md, undated rejection note).
test("the rejected-review note on the next tick's prompt is dated and names the reviewed head", () => {
  const result = assembleTickPrompt({
    root: root(),
    config: defaultConfig(),
    role: "feature",
    state: state({
      lastReview: {
        verdict: "reject",
        reasons: ["md-only BUGS.md edit"],
        head: "8b58124aabcdef",
        at: new Date(2026, 8, 24, 1, 20, 32).getTime(),
      },
    }),
  });
  assert.ok(result);
  assert.match(result.prompt, /rejected in review \(2026-09-24 01:20:32, head 8b58124\):/);
});

test("a conflict discard note rides along, with its attempt count", () => {
  const result = assembleTickPrompt({
    root: root(),
    config: defaultConfig(),
    role: "feature",
    state: state({
      conflictDiscard: { sha: "abc123", summary: "reworked the merge module", attempts: 3, at: 1 },
    }),
  });
  assert.ok(result);
  assert.match(result.prompt, /reworked the merge module/);
  assert.match(result.prompt, /3/);
});

test("a cut-off streak appends the cut-off note naming the streak", () => {
  const result = assembleTickPrompt({
    root: root(),
    config: defaultConfig(),
    role: "feature",
    state: state({ cutOffStreak: 2 }),
  });
  assert.ok(result);
  assert.match(result.prompt, /Your previous 2 runs as this loop ran out of context/);
});

test("notes compose in order — review rejection, then discard, then cut-off — after the base prompt", () => {
  const dir = root();
  fs.writeFileSync(
    path.join(dir, "PRINCIPLES.md"),
    "Small beats big.\n",
  );
  const result = assembleTickPrompt({
    root: dir,
    config: defaultConfig(),
    role: "feature",
    state: state({
      lastReview: { verdict: "reject", reasons: ["reason A"], at: 1 },
      conflictDiscard: { sha: "abc", summary: "discarded work", attempts: 1, at: 2 },
      cutOffStreak: 2,
    }),
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
  const result = assembleTickPrompt({
    root: root(),
    config: defaultConfig(),
    role: "feature",
    state: state(),
  });
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
  const result = assembleTickPrompt({
    root: dir,
    config: defaultConfig(),
    role: "coverage",
    state: state(),
  });
  assert.ok(result);
  assert.match(result.prompt, /\[initial prompt truncated at 4096 chars\]/);
});

// PLANS.md "Per-role prompts 1/2": `tumwater prompt --role <id>` queues a prompt only that
// loop's next tick sees — dequeued here, riding as the tick's userPrompt and an explicit
// <user-request> block in the prompt text.
test("a queued per-role prompt is dequeued into that role's prompt only", () => {
  const dir = root();
  enqueueRolePrompt(dir, "coverage", "check the export flow");
  const coverage = assembleTickPrompt({
    root: dir,
    config: defaultConfig(),
    role: "coverage",
    state: state({ role: "coverage" }),
  });
  assert.ok(coverage);
  assert.equal(coverage.userPrompt, "check the export flow");
  assert.match(coverage.prompt, /<user-request>\ncheck the export flow\n<\/user-request>/);

  // Another role's assembly dequeues nothing: no request block, no userPrompt.
  const qa = assembleTickPrompt({ root: dir, config: defaultConfig(), role: "qa", state: state({ role: "qa" }) });
  assert.ok(qa);
  assert.equal(qa.userPrompt, null);
  assert.ok(!qa.prompt.includes("<user-request>"));

  // The dequeue drained the queue: the next assembly finds nothing queued.
  const again = assembleTickPrompt({
    root: dir,
    config: defaultConfig(),
    role: "coverage",
    state: state({ role: "coverage" }),
  });
  assert.ok(again);
  assert.equal(again.userPrompt, null);
  assert.ok(!again.prompt.includes("<user-request>"));
});
