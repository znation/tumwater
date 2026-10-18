import test from "node:test";
import assert from "node:assert/strict";
import { CLAIMS_RULE_COMPACT, REPLY_ENDINGS } from "../src/verdict/reply-contract.js";
import {
  KILL_BY_PID_RULE,
  ROOT_FROM_WORKTREE,
  TEST_RUNNER_RULE,
  buildDirectorPrompt,
  buildTickPrompt,
  compactContextBudgetRule,
  principleBullets,
} from "../src/prompt/prompt.js";
import { CLAUDE_DIALECT, OPENCODE_DIALECT, PI_DIALECT } from "../src/prompt/dialect.js";
import { roleById } from "../src/roles/roles.js";
import type { BuildCheck } from "../src/build/build-check-detect.js";

// The compact prompt every run gets (prompt.ts CompactPrompt): the same rules in fewer words. The
// full prompt is buildTickPrompt's default and stays as it was; these tests pin that the compact
// one keeps every directive, still ends on the reply contract, and is materially shorter.

const NPM_CHECK: BuildCheck = { kind: "npm", rootDir: ".", script: "test" };
const PRINCIPLES = `# Principles

Design principles this project holds — the codified answer to "what would a senior engineer do."
Every role's prompt carries these.

- Zero incidental runtime dependencies.
- Opinionated defaults over configuration.`;

function feature(compact?: { assigned: boolean }): string {
  const role = roleById("feature");
  assert.ok(role);
  return buildTickPrompt({
    role,
    initialPrompt: "Make a CLI.",
    principles: PRINCIPLES,
    check: NPM_CHECK,
    today: "2026-10-17",
    ...(compact ? { compact } : {}),
  });
}

/** The directives both variants must state: each one is a rule the full prompt carries for a
 * reason (an incident, a reviewer rejection cause), so the compact wording may drop the reason
 * but never the rule. */
const DIRECTIVES: readonly string[] = [
  "$TMPDIR",
  "mktemp",
  `Never cd to the repo root (\`${ROOT_FROM_WORKTREE}\`)`,
  `${ROOT_FROM_WORKTREE}/node_modules`,
  "Never run an unbounded scan",
  "wait forever",
  "at most 30 minutes",
  "check.log 2>&1",
  TEST_RUNNER_RULE,
  KILL_BY_PID_RULE,
  "Never create, amend, or revert git commits, branches, or merges",
  "Never touch the .tumwater directory or tumwater.json.",
  "between the tumwater:prompt markers",
  "docs/invariants.md",
  "QUESTIONS.md under ## Open",
  "**Refused <YYYY-MM-DD> by <role>: <one-line reason>**",
  "That note is the only change a refusing run leaves.",
  "SUMMARY, WHY, RISK, VERIFIED",
  '"byte-identical"',
  "Never state test or suite counts",
  "LAST edit",
  "wc -l",
  "grep -n",
  PI_DIALECT.readRange,
  PI_DIALECT.oversizedOutput,
  "ONE focused task",
  REPLY_ENDINGS,
];

/** Line wrapping is layout, not wording: compare with every run of whitespace as one space. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

test("the compact prompt keeps every directive the full prompt states", () => {
  const full = flat(feature());
  for (const compact of [flat(feature({ assigned: false })), flat(feature({ assigned: true }))]) {
    for (const d of DIRECTIVES) {
      assert.ok(full.includes(flat(d)), `full prompt states: ${d}`);
      assert.ok(compact.includes(flat(d)), `compact prompt states: ${d}`);
    }
  }
});

test("the compact rules end on the reply contract and are at least a fifth shorter", () => {
  const rules = (prompt: string): string => prompt.slice(prompt.indexOf("Rules for this run:"));
  const full = rules(feature());
  for (const assigned of [false, true]) {
    const compact = feature({ assigned });
    assert.ok(compact.endsWith(REPLY_ENDINGS), "the reply contract is the last thing in the prompt");
    assert.ok(compact.includes(CLAIMS_RULE_COMPACT));
    const shorter = rules(compact);
    assert.ok(shorter.length <= full.length * 0.8, `compact rules ${shorter.length} vs full ${full.length} chars`);
  }
});

test("the full prompt carries none of the compact wording", () => {
  const full = feature();
  assert.ok(!full.includes(compactContextBudgetRule(PI_DIALECT)));
  assert.ok(!full.includes(CLAIMS_RULE_COMPACT));
  assert.ok(!full.includes("is re-sent on every turn"));
});

test("an assigned compact run reads its entry first, an unassigned one the brief", () => {
  const assigned = feature({ assigned: true });
  assert.match(assigned, /Read your assigned entry \(at the end of this prompt\) by its line range first/);
  assert.ok(!assigned.includes("in full, plus QUESTIONS.md"));
  const unassigned = feature({ assigned: false });
  assert.match(unassigned, /First read the project brief \(README\.md\) in full, plus QUESTIONS\.md when present\./);
  assert.match(unassigned, /<backlog-index> block/);
});

test("the compact prompt's principles block carries only the bullets", () => {
  const compact = feature({ assigned: false });
  assert.match(compact, /<principles>\n- Zero incidental runtime dependencies\./);
  assert.ok(!compact.includes("codified answer"));
  assert.ok(feature().includes("codified answer"), "the full prompt keeps the file whole");
});

test("principleBullets starts at the first list item and keeps a file without one whole", () => {
  assert.equal(principleBullets("# P\n\nIntro.\n\n- a\n- b\n\n## More\n\n* c"), "- a\n- b\n\n## More\n\n* c");
  assert.equal(principleBullets("- a\n- b"), "- a\n- b");
  assert.equal(principleBullets("No list at all."), "No list at all.");
  assert.equal(principleBullets(""), "");
});

test("the compact rules keep the npm-only and dialect-specific lines conditional", () => {
  const role = roleById("bugfix");
  assert.ok(role);
  const cargo = buildTickPrompt({
    role,
    initialPrompt: "",
    check: { kind: "command", command: "cargo test", cwd: ".", timeoutMs: 300_000 },
    compact: { assigned: false },
  });
  assert.ok(!cargo.includes("node_modules"), "no node_modules line outside an npm project");
  const claude = buildTickPrompt({ role, initialPrompt: "", agent: "claude", compact: { assigned: false } });
  assert.ok(claude.includes(compactContextBudgetRule(CLAUDE_DIALECT)));
});

test("the compact director prompt shortens its rules and principles too", () => {
  const full = buildDirectorPrompt("add dark mode", "Make a CLI.", PRINCIPLES, NPM_CHECK, undefined, "2026-10-17");
  const compact = buildDirectorPrompt("add dark mode", "Make a CLI.", PRINCIPLES, NPM_CHECK, undefined, "2026-10-17", undefined, undefined, true);
  assert.ok(compact.length < full.length);
  assert.ok(compact.endsWith(REPLY_ENDINGS));
  assert.match(compact, /First read the project brief/);
  assert.ok(!compact.includes("codified answer"));
});

test("a backend's own rules ride the compact prompt as they ride the full one", () => {
  // OpenCode's shell rules (a 2-minute default timeout, background commands killed at run end)
  // are a dialect's backendRules; the compact rules must state each, so an OpenCode run on a
  // small window keeps them (plans/opencode-backend.md §9 item 1).
  const role = roleById("feature");
  assert.ok(role);
  const rules = OPENCODE_DIALECT.backendRules ?? [];
  assert.ok(rules.length > 0);
  for (const compact of [undefined, { assigned: false }, { assigned: true }]) {
    const prompt = buildTickPrompt({ role, initialPrompt: "", agent: "opencode", ...(compact ? { compact } : {}) });
    for (const rule of rules) assert.ok(prompt.includes(`- ${rule}`), `${compact ? "compact" : "full"} prompt states: ${rule}`);
  }
});
