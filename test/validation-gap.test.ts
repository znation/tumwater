import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseEntryDetails, type BacklogEntry } from "../src/backlog.js";
import { VALIDATION_GAP_TAGS } from "../src/roles.js";

/** The enforcement side of the validation-gap convention (`plans/repair-traces.md`): the
 * bugfix prompt asks every Fixed entry to carry `**Validation gap:** <tag> — <one sentence>`,
 * but prose alone never made a dropped line visible — by 2026-09-20 the line existed nowhere in
 * BUGS.md and nothing could see its absence. This test is that observer: it runs in the suite
 * the landing gate already executes, so a commit that moves a bug to Fixed without the trace is
 * rejected before it reaches main. Entries fixed before the guard shipped are grandfathered (the
 * filing bug says the legacy backlog must not fail the build); everything fixed since must carry
 * a well-formed line. An invented tag is as bad as a missing line, because the tally aggregates
 * the tag and a non-vocabulary value would silently vanish from it. */

/** Fixed entries fixed on or after this date must carry the trace. 2026-09-21 is the day the
 * first bugfix entries wrote the line and this guard landed; earlier entries predate it. */
const GAP_ENFORCED_SINCE = "2026-09-21";

/** The `fixed`/`closed`/`resolved` date in a Fixed entry's heading, or null when it carries none.
 * BUGS.md headings vary across fixed/closed/resolved (the steward's compression rules call this
 * out), so all three verbs count; a heading with no such date cannot be scoped and is skipped. */
function fixedDate(title: string): string | null {
  return /\b(?:fixed|closed|resolved)\s+(\d{4}-\d{2}-\d{2})/.exec(title)?.[1] ?? null;
}

/** The tag token a body's trace line names, or null when the line is absent. Accepts an optional
 * list bullet before the marker; the tag itself is what the tally aggregates. */
function validationGapTag(body: string): string | null {
  return /^\s*(?:[-*]\s+)?\*\*Validation gap:\*\*\s+([A-Za-z-]+)/m.exec(body)?.[1] ?? null;
}

/** The Fixed entries fixed on/after GAP_ENFORCED_SINCE whose bodies lack a well-formed trace —
 * a missing line and an invented tag are both failures. */
export function entriesMissingValidationGap(md: string): BacklogEntry[] {
  return parseEntryDetails(md, "Fixed").filter((entry) => {
    const date = fixedDate(entry.title);
    if (date === null || date < GAP_ENFORCED_SINCE) return false;
    const tag = validationGapTag(entry.body);
    return tag === null || !VALIDATION_GAP_TAGS.includes(tag);
  });
}

const FIXED_MD = `# Bugs

## Fixed

### A pre-guard bug (found 2026-09-18, fixed 2026-09-20)

**Symptom:** Grandfathered — no trace line is required.

### A guarded bug (reported 2026-09-21, fixed 2026-09-21)

**Validation gap:** none — the existing suite confirmed it.

### A guarded bug with a bulleted trace (reported 2026-09-21, closed 2026-09-21)

- **Validation gap:** no-fake — had to write a shim.

### A guarded bug with no trace (reported 2026-09-21, fixed 2026-09-21)

**Symptom:** The trace line is missing entirely.

### A guarded bug with an invented tag (reported 2026-09-21, fixed 2026-09-21)

**Validation gap:** definitely-not-a-tag — made up.

### An undated bug

**Symptom:** No date in the heading, so the guard cannot scope it.
`;

test("the validation-gap guard flags only post-cutoff Fixed entries without a valid tag", () => {
  assert.deepEqual(
    entriesMissingValidationGap(FIXED_MD).map((e) => e.title),
    [
      "A guarded bug with no trace (reported 2026-09-21, fixed 2026-09-21)",
      "A guarded bug with an invented tag (reported 2026-09-21, fixed 2026-09-21)",
    ],
  );
});

test("BUGS.md Fixed entries fixed since the guard carry a validation-gap trace", () => {
  const md = fs.readFileSync(new URL("../../BUGS.md", import.meta.url), "utf8");
  const missing = entriesMissingValidationGap(md);
  assert.equal(
    missing.length,
    0,
    `Fixed entries fixed on/after ${GAP_ENFORCED_SINCE} must carry ` +
      `\`**Validation gap:** <tag> — <one sentence>\` with a tag from the closed vocabulary ` +
      `(${VALIDATION_GAP_TAGS.join(", ")}). Missing or invalid:\n` +
      missing.map((e) => `  - ${e.title}`).join("\n"),
  );
});
