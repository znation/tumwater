// The prompt dialect (plans/agent-backends.md "What the pi extensions did, per backend",
// PLANS.md "Agent backends, part 5/7"): the only backend-specific prompt text — the notebook
// tool's name and the oversized-output rule. pi's text must stay byte-identical to the
// pre-dialect prompts; claude's names its MCP tool and its own output-spill behavior.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_BUDGET_RULE,
  buildDirectorPrompt,
  buildTickPrompt,
  contextBudgetRule,
  roleNotesInstruction,
} from "../src/prompt/prompt.js";
import { buildResumePrompt } from "../src/prompt/prompt-followup.js";
import { CLAUDE_DIALECT, PI_DIALECT, dialectFor } from "../src/prompt/dialect.js";
import { roleById } from "../src/roles/roles.js";

test("pi's reading-budget rule is the historical text, byte for byte", () => {
  // The exact text before the dialect split (the pre-2026-10-10 CONTEXT_BUDGET_RULE): pinned
  // verbatim so any drift in the pi dialect is a test failure, not a silent prompt change.
  const historical = `- Your context window is finite: everything you read stays in it until the run ends, and a
  run that fills the window lands nothing. A whole-file read of a 500-line module costs ~5k tokens.
- Check size before reading (\`wc -l\`) and read files over ~300 lines in ranges: find the lines
  with \`grep -n\`, then read them with the read tool's offset/limit (or \`sed -n 'A,Bp'\`).
- Cap command output with \`head\`/\`tail\`. Never dump a file, a log, or a test run wholesale.
- Do not re-read what you already saw — re-read only a region you edited.
- Each turn re-sends everything read so far, so issue lookups that do not depend on each other
  (a \`wc -l\` over several files, the ranges a \`grep -n\` found, a typecheck and a targeted
  test) as separate tool calls in the same turn. Keep anything that depends on a prior result
  sequential — do not batch an edit with the test that checks it.
- Oversized tool results come back as head+tail around a marker that names the omitted amount
  and where the full output lives — follow the pointer (re-read with \`offset\`/\`limit\`, or open
  the full-output file path) instead of retrying the same read.`;
  assert.equal(CONTEXT_BUDGET_RULE, historical);
  assert.equal(contextBudgetRule(PI_DIALECT), historical);
  // The notebook instruction's pi text, likewise unchanged by the dialect split.
  assert.equal(
    roleNotesInstruction(PI_DIALECT),
    `Before you end, if you learned something the next tick of your role should know (where
things live, what you ruled out and why, what you would look at next), call role_notes with
the full replacement note (at most 4 KB). Do not copy backlog entries into it — PLANS.md and
BUGS.md hold the work itself.`,
  );
});

test("claude's dialect differs only in the tool name and output-spill wording", () => {
  const claude = contextBudgetRule(CLAUDE_DIALECT);
  assert.notEqual(claude, CONTEXT_BUDGET_RULE);
  assert.match(claude, /saved to a file the tool names/);
  assert.match(claude, /the Read tool's offset\/limit/);
  assert.ok(!claude.includes("head+tail"), "claude's spill is a named file, not a marker");
  assert.equal(dialectFor("claude"), CLAUDE_DIALECT);
  assert.equal(dialectFor("pi"), PI_DIALECT);
  assert.equal(dialectFor(undefined), PI_DIALECT, "unknown or unset agents speak pi's dialect");
});

test("a claude tick prompt names the MCP notebook tool; pi's names the pi tool", () => {
  const role = roleById("feature")!;
  const pi = buildTickPrompt({ role, initialPrompt: "" });
  assert.match(pi, /call role_notes with/);
  assert.ok(!pi.includes("mcp__tumwater__role_notes"), "pi never sees the MCP name");

  const claude = buildTickPrompt({ role, initialPrompt: "", agent: "claude" });
  assert.match(claude, /call mcp__tumwater__role_notes with/);
  assert.ok(!claude.includes("call role_notes with"), "claude never sees the pi tool name");
  assert.match(claude, /saved to a file the tool names/);
});

test("the notebook instruction switches tool name with the dialect", () => {
  assert.match(roleNotesInstruction(PI_DIALECT), /call role_notes with/);
  assert.match(roleNotesInstruction(CLAUDE_DIALECT), /call mcp__tumwater__role_notes with/);
});

test("a claude director prompt carries claude's oversized-output wording", () => {
  const pi = buildDirectorPrompt("do a thing", "");
  assert.match(pi, /head\+tail around a marker/);
  assert.ok(!pi.includes("mcp__tumwater__role_notes"), "the director never gets the notebook tool");

  const claude = buildDirectorPrompt("do a thing", "", undefined, undefined, undefined, undefined, undefined, "claude");
  assert.match(claude, /saved to a file the tool names/);
  assert.ok(!claude.includes("head+tail"), "claude's director prompt uses claude's wording");
});

test("a claude resume bridge carries claude's oversized-output wording; pi's the marker", () => {
  assert.match(buildResumePrompt("feature"), /head\+tail around a marker/);
  const claude = buildResumePrompt("feature", "restart", "claude");
  assert.match(claude, /saved to a file the tool names/);
  assert.ok(!claude.includes("head+tail"));
});
