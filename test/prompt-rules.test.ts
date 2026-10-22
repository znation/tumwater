import test from "node:test";
import assert from "node:assert/strict";
import { CLAIMS_RULE, REPLY_ENDINGS } from "../src/verdict/reply-contract.js";
import {
  KILL_BY_PID_RULE,
  ROOT_FROM_WORKTREE,
  TEST_RUNNER_RULE,
  buildDirectorPrompt,
  buildRunPrompt,
  contextBudgetRule,
  principleBullets,
} from "../src/prompt/prompt.js";
import { CLAUDE_DIALECT, CODEX_DIALECT, OPENCODE_DIALECT, PI_DIALECT } from "../src/prompt/dialect.js";
import { roleById } from "../src/roles/roles.js";
import type { BuildCheck } from "../src/build/build-check-detect.js";

// The rules every run's prompt carries (prompt.ts commonRules): one compact prompt for every
// model since the longer full variant was deleted (2026-10-19). These tests pin that it states
// every directive, for an assigned run and an unassigned one, and still ends on the reply contract.

const NPM_CHECK: BuildCheck = { kind: "npm", rootDir: ".", script: "test" };
const PRINCIPLES = `# Principles

Design principles this project holds — the codified answer to "what would a senior engineer do."
Every role's prompt carries these.

- Zero incidental runtime dependencies.
- Opinionated defaults over configuration.`;

function feature(assigned?: boolean): string {
  const role = roleById("feature");
  assert.ok(role);
  return buildRunPrompt({
    role,
    principles: PRINCIPLES,
    check: NPM_CHECK,
    today: "2026-10-17",
    ...(assigned === undefined ? {} : { assigned }),
  });
}

/** The directives every run's rules must state: each one is a rule the prompt carries for a
 * reason (an incident, a reviewer rejection cause), so a rewording may drop the reason but never
 * the rule. */
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

test("the run prompt states every directive, assigned or not", () => {
  for (const prompt of [flat(feature()), flat(feature(false)), flat(feature(true))]) {
    for (const d of DIRECTIVES) assert.ok(prompt.includes(flat(d)), `prompt states: ${d}`);
  }
});

test("the rules end on the reply contract, right after the claims rule", () => {
  for (const assigned of [false, true]) {
    const prompt = feature(assigned);
    assert.ok(prompt.endsWith(REPLY_ENDINGS), "the reply contract is the last thing in the prompt");
    assert.ok(prompt.includes(CLAIMS_RULE));
    assert.ok(prompt.indexOf(CLAIMS_RULE) < prompt.indexOf("How to end your reply"));
    assert.ok(prompt.includes(contextBudgetRule(PI_DIALECT)));
  }
});

test("an assigned run reads its entry first, an unassigned one the brief", () => {
  const assigned = feature(true);
  assert.match(assigned, /Read your assigned entry \(at the end of this prompt\) by its line range first/);
  assert.ok(!assigned.includes("in full, plus QUESTIONS.md"));
  const unassigned = feature(false);
  assert.match(unassigned, /First read the project brief \(README\.md\) in full, plus QUESTIONS\.md when present\./);
  assert.match(unassigned, /<backlog-index> block/);
  assert.equal(feature(), unassigned, "omitted means unassigned");
});

test("the principles block carries only the bullets, and the brief is never inlined", () => {
  const prompt = feature();
  assert.match(prompt, /<principles>\n- Zero incidental runtime dependencies\./);
  assert.ok(!prompt.includes("codified answer"));
  assert.ok(!prompt.includes("<project-prompt>"), "the run reads the brief file instead");
  const director = buildDirectorPrompt("add dark mode", PRINCIPLES, NPM_CHECK, undefined, "2026-10-17");
  assert.ok(director.endsWith(REPLY_ENDINGS));
  assert.match(director, /First read the project brief/);
  assert.ok(!director.includes("codified answer"));
  assert.ok(!director.includes("<project-prompt>"));
});

test("principleBullets starts at the first list item and keeps a file without one whole", () => {
  assert.equal(principleBullets("# P\n\nIntro.\n\n- a\n- b\n\n## More\n\n* c"), "- a\n- b\n\n## More\n\n* c");
  assert.equal(principleBullets("- a\n- b"), "- a\n- b");
  assert.equal(principleBullets("No list at all."), "No list at all.");
  assert.equal(principleBullets(""), "");
});

test("the rules keep the npm-only and dialect-specific lines conditional", () => {
  const role = roleById("bugfix");
  assert.ok(role);
  const cargo = buildRunPrompt({
    role,
    check: { kind: "command", command: "cargo test", cwd: ".", timeoutMs: 300_000 },
  });
  assert.ok(!cargo.includes("node_modules"), "no node_modules line outside an npm project");
  const claude = buildRunPrompt({ role, agent: "claude" });
  assert.ok(claude.includes(contextBudgetRule(CLAUDE_DIALECT)));
});

test("a backend's own rules ride the run prompt", () => {
  // OpenCode's shell rules (a 2-minute default timeout, background commands killed at run end)
  // are a dialect's backendRules; the rules must state each (plans/opencode-backend.md §9 item 1).
  const role = roleById("feature");
  assert.ok(role);
  const rules = OPENCODE_DIALECT.backendRules ?? [];
  assert.ok(rules.length > 0);
  for (const assigned of [false, true]) {
    const prompt = buildRunPrompt({ role, agent: "opencode", assigned });
    for (const rule of rules) assert.ok(prompt.includes(`- ${rule}`), `${assigned ? "assigned" : "unassigned"} prompt states: ${rule}`);
  }
});

test("a codex run's prompt carries the codex dialect's rules beside the OpenCode cases", () => {
  // Codex's dialect (plans/codex-backend.md §6): the `sed`-only reading-budget rule (it has
  // no read tool), the `…N tokens truncated…` oversized-output wording (finding 18), and one
  // backend rule about polling a long command with write_stdin (finding 19).
  const role = roleById("feature");
  assert.ok(role);
  const rules = CODEX_DIALECT.backendRules ?? [];
  assert.ok(rules.length > 0);
  for (const assigned of [false, true]) {
    const prompt = buildRunPrompt({ role, agent: "codex", assigned });
    assert.ok(flat(prompt).includes(flat(CODEX_DIALECT.readRange)), `${assigned} prompt states the codex read range`);
    assert.ok(flat(prompt).includes("…N tokens truncated…"), `${assigned} prompt states the codex truncation marker`);
    for (const rule of rules) assert.ok(prompt.includes(`- ${rule}`), `${assigned ? "assigned" : "unassigned"} prompt states: ${rule}`);
  }
});
