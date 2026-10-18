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
import { CLAUDE_DIALECT, OPENCODE_DIALECT, PI_DIALECT, dialectFor } from "../src/prompt/dialect.js";
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
  // The notebook instruction is the same on every backend (part 2/4): it names the
  // tumwater-notes command, never a per-backend tool.
  const instruction = roleNotesInstruction();
  assert.match(instruction, /tumwater-notes write <<'TUMWATER_NOTES'/);
  assert.ok(!instruction.includes("role_notes"), "the instruction names the command, not a tool");
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

test("every backend's run prompt names the tumwater-notes command, and none names the old tools", () => {
  const role = roleById("feature")!;
  for (const agent of ["pi", "claude", "opencode"] as const) {
    const prompt = buildTickPrompt({ role, initialPrompt: "", agent });
    assert.match(prompt, /tumwater-notes write <<'TUMWATER_NOTES'/, `${agent} names the notes command`);
    assert.ok(!prompt.includes("role_notes"), `${agent} never names the pi tool`);
    assert.ok(!prompt.includes("mcp__tumwater__role_notes"), `${agent} never names claude's MCP tool`);
    assert.ok(!prompt.includes("tumwater_role_notes"), `${agent} never names opencode's MCP tool`);
  }
  const claude = buildTickPrompt({ role, initialPrompt: "", agent: "claude" });
  assert.match(claude, /saved to a file the tool names/);
});

test("the notes instruction is backend-independent and names only the command", () => {
  // Part 2/4: the one carrier is the tumwater-notes command, so roleNotesInstruction takes no
  // dialect and never names a per-backend tool.
  const instruction = roleNotesInstruction();
  assert.match(instruction, /save the full replacement\nnote \(at most 4 KB\) by running:/);
  assert.match(instruction, /tumwater-notes write <<'TUMWATER_NOTES'/);
  assert.match(instruction, /^TUMWATER_NOTES$/m, "the heredoc delimiter closes the instruction");
  assert.ok(!instruction.includes("role_notes"));
});

test("opencode's dialect carries both backend rules", () => {
  assert.equal(dialectFor("opencode"), OPENCODE_DIALECT);
  assert.match(roleNotesInstruction(), /tumwater-notes write <<'TUMWATER_NOTES'/, "the instruction names the command");

  const role = roleById("feature")!;
  const opencode = buildTickPrompt({ role, initialPrompt: "", agent: "opencode" });
  assert.match(opencode, /tumwater-notes write <<'TUMWATER_NOTES'/, "the opencode prompt names the notes command");
  assert.ok(!opencode.includes("call role_notes with"), "opencode never sees the pi tool name");
  assert.ok(!opencode.includes("mcp__tumwater__role_notes"), "opencode never sees claude's MCP name");
  assert.ok(!opencode.includes("tumwater_role_notes"), "opencode no longer names its own MCP tool");
  // The two backend rules (plans/opencode-backend.md §5) ride the reading-budget section.
  assert.match(opencode, /pass `timeout` in milliseconds/);
  assert.match(opencode, /never set `background`/);
  assert.ok(opencode.includes("keeps only its last lines"), "opencode's oversized-output rule");
});

test("pi and claude prompts stay byte-identical: no backend blank line in the reading budget", () => {
  // backendRuleLines returns "" for a dialect with no backendRules (pi, claude), so each
  // prompt's Reading budget block is exactly its pre-dialect rule text from the dialect's own
  // contextBudgetRule, followed by one blank line before "Where you work" — rendered through
  // the full buildTickPrompt so the block is compared byte-for-byte, the regression for the
  // earlier blank-line bug (a backend rule rendered as an empty line doubled that separator).
  for (const [agent, dialect] of [
    ["pi", PI_DIALECT],
    ["claude", CLAUDE_DIALECT],
  ] as const) {
    const prompt = buildTickPrompt({ role: roleById("feature")!, initialPrompt: "", agent });
    const marker = "Reading budget:";
    const block = prompt.slice(
      prompt.indexOf(marker) + marker.length,
      prompt.indexOf("Where you work:"),
    );
    assert.equal(block, "\n" + contextBudgetRule(dialect) + "\n\n", `${agent} reading budget`);
  }
  assert.equal(PI_DIALECT.backendRules, undefined);
  assert.equal(CLAUDE_DIALECT.backendRules, undefined);
});

test("a claude director prompt carries claude's oversized-output wording", () => {
  const pi = buildDirectorPrompt("do a thing", "");
  assert.match(pi, /head\+tail around a marker/);
  assert.ok(!pi.includes("mcp__tumwater__role_notes"), "the director never gets the notes tool");

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
