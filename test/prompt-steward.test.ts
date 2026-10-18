import test from "node:test";
import assert from "node:assert/strict";
import { buildTickPrompt } from "../src/prompt/prompt.js";
import { ROLES, roleById } from "../src/roles/roles.js";
import { oneLine } from "./helpers/oracles.js";

// Prompt contract for the steward role (plans/steward-role.md): a markdown-only curation
// role on a slow clock. Every tick is a fresh session with no memory of earlier curation
// moves, so the find text must carry the move list, the markdown-only restriction, and its
// deletion/principles powers in prose; these assertions pin that contract. Same whitespace-
// collapsed matching as the refusal and questions contracts above — the prose is hard-wrapped
// and formatting ticks reflow it, so assertions match content, not layout.

const steward = roleById("steward");

test("the steward role exists last in catalog order", () => {
  assert.ok(steward, "roleById('steward') returns a role");
  const ids = ROLES.map((r) => r.id);
  // The director is appended separately by allRoleIds(), so within the catalog the steward
  // sits right after improve — exactly the lowest tie-break priority planned.
  assert.equal(ids[ids.indexOf("improve") + 1], "steward", "steward sits right after improve");
  assert.equal(steward.title, "backlog curator");
});

test("the steward prompt makes ONE curation move from the planned list", () => {
  const find = oneLine(steward!.find);
  // It re-reads the durable state first — QUESTIONS.md only conditionally (init seeds it,
  // but older repos may not have it).
  assert.match(find, /Re-read the brief, PRINCIPLES\.md, PLANS\.md, BUGS\.md/);
  assert.match(find, /and QUESTIONS\.md if it exists/);
  assert.match(find, /skim the codebase's shape \(sizes, module list, test count\)/);
  // One move per tick, and the five planned moves: prune plans (with an epitaph), flag
  // drift as a PLANS.md note, tighten or update a principle or complexity budget in
  // PRINCIPLES.md, record a structural risk in BUGS.md, promote a recurring gap tag.
  assert.match(find, /make ONE curation move, the most valuable one/);
  assert.match(
    find,
    /delete or merge stale\/duplicative\/superseded PLANS\.md entries: move each one under PLANS\.md's ## Done with a one-line epitaph as its body/,
  );
  assert.match(find, /flag drift between what is being built and the brief as a PLANS\.md note/);
  assert.match(find, /tighten or update a principle or complexity budget in PRINCIPLES\.md/);
  assert.match(find, /record a structural risk in BUGS\.md/);
  assert.match(
    find,
    /promote a recurring non-`none` `gap:` tag — three or more Fixed entries carrying it — into a PLANS\.md entry for the infrastructure that would retire it, citing those entries/,
  );
});

test("the steward prompt restricts writes to markdown", () => {
  // Markdown-only is what keeps the role review-exempt (the gate's *.md exemption) and
  // safe on a slow clock: its diffs can never break the build.
  const find = oneLine(steward!.find);
  assert.match(find, /You edit only markdown — never source\./);
});

// Finished history is archived, not curated (plans/backlog-archive.md): finished entries live in
// PLANS-DONE.md and BUGS-FIXED.md, which nothing reads whole, so the steward never compresses
// or trims them — that move, and its ten-entry window, is retired — and reads them only by
// search or by an entry's line range.

test("the steward reads the archive files only by search or range and never compresses them", () => {
  const find = oneLine(steward!.find);
  assert.match(find, /PLANS\.md and BUGS\.md hold open work, so read them whole when your move needs it/);
  assert.match(find, /Finished entries live in PLANS-DONE\.md and BUGS-FIXED\.md, newest first, and those files only grow: never read them whole/);
  assert.match(find, /Search them with `grep -n`, and read an entry by its line range only where your move needs its body/);
  assert.match(find, /Finished history is not curated: nothing reads the archive files whole, so they are never compressed or trimmed/);
  assert.doesNotMatch(find, /compress older ones to one line each/);
  assert.doesNotMatch(find, /records-overflow/);
  assert.doesNotMatch(find, /no archive file/);
});

test("the steward's epitaph keeps the entry's title for the citation guard and lets tumwater archive it", () => {
  const find = oneLine(steward!.find);
  assert.match(find, /\(tumwater archives it to PLANS-DONE\.md when your change commits\), keeping the entry's title/);
  assert.match(find, /`plans-citations\.test\.ts` fails when a `PLANS\.md "<title>"` citation/);
});

test("buildTickPrompt for steward carries the find text plus the shared rules", () => {
  const prompt = buildTickPrompt({ role: steward!, initialPrompt: "" });
  assert.match(prompt, /"steward" role \(backlog curator\)/);
  assert.ok(prompt.includes(steward!.find.trim()), "the full find text is embedded");
});
