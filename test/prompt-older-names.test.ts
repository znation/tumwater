/** Every assembled prompt speaks the glossary and maps the older names exactly once
 * (plans/terminology.md "Glossary"). */
import test from "node:test";
import assert from "node:assert/strict";
import { OLDER_NAMES_SENTENCE, buildDirectorPrompt, buildRunPrompt } from "../src/prompt/prompt.js";
import { buildConflictPrompt, buildReviewPrompt } from "../src/prompt/gate-prompts.js";
import { buildCutOffNote, buildResumePrompt, buildSummaryRequestPrompt, type ResumeCause } from "../src/prompt/prompt-followup.js";
import { ROLES, customRole } from "../src/roles/roles.js";

const GUARD = /(?<![a-z0-9_])(?:fleet|loop|tick|landing|landed|vetted|seam|notebook|initial prompt|harness)(?:s|es|ed|ing)?(?![a-z0-9_])/i;

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function assertPlain(name: string, prompt: string, mapped: boolean, scan = true): void {
  assert.equal(count(prompt, OLDER_NAMES_SENTENCE), mapped ? 1 : 0, `${name}: older-names sentence`);
  if (!scan) return;
  // "requires part N/M landed" is the dependency phrase the backlog parser matches, kept verbatim.
  const stripped = prompt.split(OLDER_NAMES_SENTENCE).join("").replaceAll("requires part N/M landed", "");
  const hit = GUARD.exec(stripped);
  assert.equal(hit, null, `${name}: guard word "${hit?.[0]}" in ...${stripped.slice(Math.max(0, (hit?.index ?? 0) - 40), (hit?.index ?? 0) + 40)}...`);
}

test("every catalog role, custom role and the director open plainly and map the older names once", () => {
  for (const role of [...ROLES, customRole("docs", "Keep the docs current.")]) {
    const prompt = buildRunPrompt({ role });
    assert.ok(prompt.startsWith(`You are the "${role.id}" role (${role.title}) on this project's tumwater team`), role.id);
    // Catalog role text is the roles series' to convert (it still quotes machine trailers such
    // as `Tick: readme #N`); the custom role's prompt scans the shared opener, preamble and rules.
    assertPlain(role.id, prompt, true, !ROLES.includes(role));
  }
  const director = buildDirectorPrompt("do a thing");
  assert.ok(director.startsWith('You are the "director" role'));
  assert.match(director, /customRoles/);
  assertPlain("director", director, true);
});

test("the shared preamble spells the attribution stamps", () => {
  const prompt = buildRunPrompt({ role: ROLES[0]! });
  assert.match(prompt, /\(found by the <role> role YYYY-MM-DD\)/);
  assert.match(prompt, /fixed YYYY-MM-DD by the <role> role/);
  assert.match(prompt, /done YYYY-MM-DD by the <role> role/);
  assert.match(prompt, /\(planned YYYY-MM-DD by the <role> role/);
});

test("the reviewer and conflict resolver map the older names once", () => {
  assertPlain("review", buildReviewPrompt("diff --git a b"), true);
  assertPlain("resolver", buildConflictPrompt("feature", ["a.txt"]), true);
});

test("follow-ups carry no older names (the session already has the preamble)", () => {
  const causes: ResumeCause[] = ["restart", "cut-off", "hung-tool", "timeout", "budget-resumed", "handoff", "rate-limit", "budget-capped", "image-reroute"];
  for (const cause of causes) assertPlain(`resume ${cause}`, buildResumePrompt("feature", cause), false);
  assertPlain("cut-off note", buildCutOffNote(3), false);
  assertPlain("summary request", buildSummaryRequestPrompt(), false);
});
