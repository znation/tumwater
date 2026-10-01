import test from "node:test";
import assert from "node:assert/strict";
import { buildTickPrompt } from "../src/prompt.js";
import { ROLES, roleById } from "../src/roles.js";
import { oneLine } from "./oracles.js";

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
  assert.equal(steward.title, "project steward");
});

test("the steward prompt makes ONE curation move from the planned list", () => {
  const find = oneLine(steward!.find);
  // It re-reads the durable state first — QUESTIONS.md only conditionally (init seeds it,
  // but older repos may not have it).
  assert.match(find, /Re-read the initial prompt, PRINCIPLES\.md, PLANS\.md, BUGS\.md/);
  assert.match(find, /and QUESTIONS\.md if it exists/);
  assert.match(find, /skim the codebase's shape \(sizes, module list, test count\)/);
  // One move per tick, and the five planned moves: prune plans (with an epitaph), flag
  // drift as a PLANS.md note, tighten or update a principle or complexity budget in
  // PRINCIPLES.md, record a structural risk in BUGS.md, promote a recurring gap tag.
  assert.match(find, /make ONE curation move, the most valuable one/);
  assert.match(
    find,
    /delete or merge stale\/duplicative\/superseded PLANS\.md entries \(with a one-line epitaph in the entry's place or in Done\)/,
  );
  assert.match(find, /flag drift between what is being built and the initial prompt as a PLANS\.md note/);
  assert.match(find, /tighten or update a principle or complexity budget in PRINCIPLES\.md/);
  assert.match(find, /record a structural risk in BUGS\.md/);
  assert.match(
    find,
    /promote a recurring non-`none` `gap:` tag — three or more retained Fixed entries carrying it — into a PLANS\.md entry for the infrastructure that would retire it, citing those entries/,
  );
});

test("the steward prompt restricts writes to markdown", () => {
  // Markdown-only is what keeps the role review-exempt (the gate's *.md exemption) and
  // safe on a slow clock: its diffs can never break the build.
  const find = oneLine(steward!.find);
  assert.match(find, /You edit only markdown — never source\./);
});

// Prompt contract for PLANS.md Done-section curation (PLANS.md, planned 2026-09-04): ## Done
// is bounded by construction — a ten-entry verbatim window, older entries compressed to
// one-line epitaphs carrying title, dates, and landing hashes. Every steward tick is a fresh
// session with no memory of earlier curation moves, so the find text must carry the whole
// policy in prose; these assertions pin that contract. Same whitespace-collapsed matching as
// above — the prose is hard-wrapped and formatting ticks reflow it, so assertions match
// content, not layout.

test("the steward prompt bounds PLANS.md's Done section to a ten-entry verbatim window", () => {
  const find = oneLine(steward!.find);
  assert.match(find, /PLANS\.md's ## Done section is curated to stay bounded/);
  assert.match(
    find,
    /keep the ten most recent entries verbatim \(newest first, by position in file\)/i,
  );
});

test("the steward prompt compresses older Done entries to one-line epitaphs with title, dates, and hashes", () => {
  const find = oneLine(steward!.find);
  assert.match(find, /compress older ones to one line each/);
  // The exact one-line form: title, planned/done dates, landing commit(s).
  assert.match(
    find,
    /`- <title> \(planned YYYY-MM-DD, done YYYY-MM-DD; commit\(s\) <sha>\[, <sha>\]\)`/,
  );
  assert.match(find, /title and dates from the entry's heading/);
});

test("the steward prompt sources epitaph hashes from landing citations or git log, never verification references", () => {
  const find = oneLine(steward!.find);
  // Priority: an explicit landing citation in the body, else git log on main.
  assert.match(find, /an explicit landing citation in the entry body/);
  assert.match(find, /else git log on main/);
  // A Done note's "against main <sha>" is a base reference — never the record's hash; when no
  // landing commit exists, omit the field rather than guess.
  assert.match(
    find,
    /never use a verification or base reference \("Verified … against main `<sha>`", "at HEAD `<sha>`"\)/i,
  );
  assert.match(find, /omit the commit\(s\) field rather than guess/);
});

test("the steward prompt never compresses Done entries carrying a Refused note", () => {
  const find = oneLine(steward!.find);
  assert.match(find, /Never compress an entry carrying a standing \*\*Refused …\*\* note/);
  assert.match(find, /such entries stay full \(they are rare\)/);
});

test("the steward prompt treats Done compression as lossy with git history as the archive", () => {
  const find = oneLine(steward!.find);
  assert.match(
    find,
    /lossy on purpose: pre-compression text stays in git history — no archive file/,
  );
});

// Prompt contract for BUGS.md Fixed-section curation (PLANS.md, planned 2026-09-04): ## Fixed is
// bounded by construction — a ten-entry verbatim window, older entries compressed to one-line
// records carrying the symptom headline, the heading's own date clause as-is, and the landing
// commit where resolvable. Same whitespace-collapsed matching as above — the prose is
// hard-wrapped and formatting ticks reflow it, so assertions match content, not layout.

test("the steward prompt bounds BUGS.md's Fixed section to a ten-entry verbatim window", () => {
  const find = oneLine(steward!.find);
  assert.match(
    find,
    /BUGS\.md's ## Fixed section is curated to stay bounded by the same policy/,
  );
  // The Done paragraph says "(newest first, by position in file)"; this clause is the Fixed
  // one — both windows are ten entries.
  assert.match(
    find,
    /keep the ten most recent entries verbatim \(newest first\) and compress older ones to one line each/i,
  );
});

test("the steward prompt compresses older Fixed entries to one-line records with headline, date clause, and gap tag", () => {
  const find = oneLine(steward!.find);
  // The exact one-line form: symptom headline, the heading's own date clause, landing commit,
  // and the entry's validation-gap tag.
  assert.match(
    find,
    /`- <symptom headline> \(<the heading's own date clause>; commit <sha>; gap: <tag>\)`/,
  );
  // `none` costs nothing: the suffix is omitted so the common case stays byte-identical.
  assert.match(find, /omitting the `gap: <tag>` suffix entirely when the tag is `none`/);
  assert.match(find, /The headline comes from the entry's heading/);
  // The date clause is copied verbatim: BUGS.md headings vary across found/reported/re-recorded
  // × fixed/closed/resolved and may carry notes inside their parentheses.
  assert.match(find, /the date clause is copied from that heading as-is/);
  assert.match(
    find,
    /headings vary across found\/reported\/re-recorded × fixed\/closed\/resolved/,
  );
  assert.match(find, /do not normalize or fabricate dates/);
  // A heading without dates drops the date part rather than inventing one.
  assert.match(
    find,
    /when a heading carries no dates at all, omit that part of the line/,
  );
});

test("the steward prompt sources Fixed-record commits from landing citations or git log, never verification references", () => {
  const find = oneLine(steward!.find);
  assert.match(
    find,
    /The commit is the entry's LANDING commit — the one that merged the fix to main/,
  );
  // Priority: an explicit landing citation in the body (the "tick N (`sha`)" form naming the
  // fix commit itself), else git log on main.
  assert.match(
    find,
    /an explicit landing citation in the entry body \(the "tick N \(`<sha>`\)" form naming the fix commit itself\), else git log on main/,
  );
  // A verification reference is main's state at check time, not the fix; bodies citing several
  // shas need the one cited as having landed the fix.
  assert.match(
    find,
    /never use a verification reference \("Verified … on main `<sha>`", "at HEAD `<sha>`"\) as the record's hash/,
  );
  assert.match(find, /bodies citing several shas need the one cited as having landed the fix/);
  // Entries closed without code change have no landing commit — omit rather than guess.
  assert.match(
    find,
    /when no landing commit exists \(an entry closed without code change says so in its \*\*Resolution:\*\* note\) omit the `commit` field rather than guess/i,
  );
  // The gap tag survives even without a landing commit, and `none` still costs nothing.
  assert.match(
    find,
    /keeping the `gap: <tag>` suffix \(the no-commit variant reads `- <symptom headline> \(<date clause>; gap: <tag>\)`, and plain `\(<date clause>\)` when the tag is `none`\)/,
  );
});

test("the steward prompt never compresses Fixed entries carrying a Refused note", () => {
  const find = oneLine(steward!.find);
  // The Refused guard, the lossy-archive rule, and one-move-per-tick are stated once, for both
  // compressions (the local-model retune of 2026-10-01 merged the two restated copies).
  assert.match(
    find,
    /Rules for both compressions: - Never compress an entry carrying a standing \*\*Refused …\*\* note/,
  );
  assert.match(find, /such entries stay full/);
});

test("the steward prompt carries the shared curation rules over to Fixed compression", () => {
  const find = oneLine(steward!.find);
  const shared = find.slice(find.indexOf("Rules for both compressions:"));
  assert.ok(find.indexOf("Rules for both compressions:") > find.indexOf("Compressing BUGS.md ## Fixed"), "stated after both policies");
  assert.match(shared, /Compression is lossy on purpose: pre-compression text stays in git history/);
  assert.match(shared, /One curation move per tick still holds/);
});

test("buildTickPrompt for steward carries the find text plus the shared rules", () => {
  const prompt = buildTickPrompt({ role: steward!, initialPrompt: "" });
  assert.match(prompt, /"steward" loop \(project steward\)/);
  assert.ok(prompt.includes(steward!.find.trim()), "the full find text is embedded");
});
