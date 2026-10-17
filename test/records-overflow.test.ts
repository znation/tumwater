import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { recordsOverflow, renderRecordsOverflowBlock } from "../src/backlog/records-overflow.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** Closed-section overflow counting for the steward prompt (src/backlog/records-overflow.ts). */

/** A `## Done` of `n` full entries, newest first, each three lines (heading, blank, body). */
function done(n: number, extra: (i: number) => string = () => ""): string {
  const entries = Array.from({ length: n }, (_, i) => `### Entry ${i + 1} (done 2026-10-01)\n\nBody ${i + 1}.${extra(i)}\n`);
  return `# Plans\n\n## Planned\n\n### Not counted\n\n## Done\n\n${entries.join("\n")}\n- one-liner\n`;
}

test("recordsOverflow is null at exactly the kept ten", () => {
  assert.equal(recordsOverflow(done(10), "PLANS.md", "Done"), null);
});

test("recordsOverflow counts entries past the ten and lists the oldest by heading line", () => {
  const md = done(13);
  const o = recordsOverflow(md, "PLANS.md", "Done");
  assert.ok(o);
  assert.equal(o.full, 13);
  assert.equal(o.over, 3);
  assert.equal(o.refused, 0);
  const lines = md.split("\n");
  assert.deepEqual(o.oldest.map((e) => e.title.slice(0, 8)), ["Entry 11", "Entry 12", "Entry 13"]);
  for (const e of o.oldest) assert.ok(lines[e.start - 1]?.startsWith("### "));
  assert.match(lines[o.oldest[0]!.start - 1]!, /Entry 11/);
});

test("recordsOverflow lists only the last ten of a longer overflow", () => {
  const o = recordsOverflow(done(25), "PLANS.md", "Done");
  assert.ok(o);
  assert.equal(o.over, 15);
  assert.equal(o.oldest.length, 10);
  assert.match(o.oldest[0]!.title, /Entry 16/);
  assert.match(o.oldest[9]!.title, /Entry 25/);
});

test("recordsOverflow leaves a Refused entry past the line out of oldest, and ignores one among the newest", () => {
  const refusal = "\n\n  **Refused 2026-10-12 by feature: x**";
  const past = recordsOverflow(done(13, (i) => (i === 11 ? refusal : "")), "PLANS.md", "Done");
  assert.ok(past);
  assert.equal(past.refused, 1);
  assert.equal(past.over, 2);
  assert.ok(!past.oldest.some((e) => e.title.startsWith("Entry 12 ")));
  const kept = recordsOverflow(done(13, (i) => (i === 2 ? refusal : "")), "PLANS.md", "Done");
  assert.ok(kept);
  assert.equal(kept.refused, 0);
  assert.equal(kept.over, 3);
});

test("recordsOverflow skips other sections and fenced headings", () => {
  const md = `## Planned\n\n${"### P\n\n".repeat(15)}## Done\n\n${"### D\n\n".repeat(10)}\`\`\`\n### fenced\n### fenced\n\`\`\`\n`;
  assert.equal(recordsOverflow(md, "PLANS.md", "Done"), null);
});

test("recordsOverflow counts a BUGS.md Fixed section the same way", () => {
  const md = `## Open\n\n_None._\n\n## Fixed\n\n${Array.from({ length: 12 }, (_, i) => `### Bug ${i}\n\nx\n\n`).join("")}`;
  const o = recordsOverflow(md, "BUGS.md", "Fixed");
  assert.equal(o?.over, 2);
});

test("renderRecordsOverflowBlock renders both files in order, one when only one is over, none otherwise", () => {
  const dir = tmpdir();
  assert.equal(renderRecordsOverflowBlock(dir), undefined);
  fs.writeFileSync(path.join(dir, "BUGS.md"), `## Fixed\n\n${"### B\n\nx\n\n".repeat(11)}`);
  const only = renderRecordsOverflowBlock(dir) ?? "";
  assert.match(only, /<records-overflow>\nBUGS\.md ## Fixed: 11 full entries, 1 past the 10 kept\. Oldest, by line range:\n- \d+-\d+: B\n<\/records-overflow>/);
  assert.doesNotMatch(only, /PLANS\.md/);
  fs.writeFileSync(path.join(dir, "PLANS.md"), done(12));
  const both = renderRecordsOverflowBlock(dir) ?? "";
  assert.ok(both.indexOf("PLANS.md ## Done: 12 full") > 0);
  assert.ok(both.indexOf("PLANS.md ## Done") < both.indexOf("BUGS.md ## Fixed"));
  // A changed size must miss the stat cache and re-read.
  fs.writeFileSync(path.join(dir, "PLANS.md"), done(10) + "\n".repeat(50));
  assert.doesNotMatch(renderRecordsOverflowBlock(dir) ?? "", /PLANS\.md/);
});
