import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderBacklogIndexBlock } from "../src/backlog/backlog-index.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** Edge coverage for src/backlog/backlog-index.ts: the closed lines spill from the live section
 * into its archive file under one five-entry cap, and a long heading is clipped. */

function doneEntries(prefix: string, count: number): string {
  let out = "";
  for (let i = 1; i <= count; i++) {
    out += `### ${prefix}${i} (done 2026-10-02; planned 2026-09-01 by plan)\nbody\n`;
  }
  return out;
}

test("renderBacklogIndexBlock takes the newest five closed entries from the live section first, then its archive", () => {
  const a = tmpdir();
  fs.writeFileSync(
    path.join(a, "PLANS.md"),
    `# Plans\n## Planned\n_None yet._\n## Done\n${doneEntries("L", 2)}`,
  );
  fs.writeFileSync(path.join(a, "PLANS-DONE.md"), `# Plans done\n## Done\n${doneEntries("A", 7)}`);
  const blockA = renderBacklogIndexBlock(a) ?? "";
  assert.match(
    blockA,
    /PLANS\.md ## Done \(newest 2\)\n- 5-6: L1\n- 7-8: L2\nPLANS-DONE\.md ## Done \(newest 3\)\n- 3-4: A1\n- 5-6: A2\n- 7-8: A3\n/,
  );
  assert.doesNotMatch(blockA, /A4/);

  const b = tmpdir();
  fs.writeFileSync(path.join(b, "BUGS.md"), "# Bugs\n## Open\n_None._\n## Fixed\n_None._\n");
  let fixed = "# Bugs fixed\n## Fixed\n";
  for (let i = 1; i <= 6; i++) fixed += `### F${i} (found by bug 2026-10-01)\nx\n`;
  fs.writeFileSync(path.join(b, "BUGS-FIXED.md"), fixed);
  const blockB = renderBacklogIndexBlock(b) ?? "";
  assert.match(blockB, /BUGS-FIXED\.md ## Fixed \(newest 5\)/);
  assert.doesNotMatch(blockB, /BUGS\.md ## Fixed/);
  assert.doesNotMatch(blockB, /F6/);
});

test("renderBacklogIndexBlock clips a long heading to 160 characters, in the actionable and the closed lines alike", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "PLANS.md"),
    `# Plans\n## Planned\n### ${"p".repeat(200)} (planned 2026-10-20 by plan)\nbody\n## Done\n_None._\n`,
  );
  fs.writeFileSync(
    path.join(dir, "BUGS-FIXED.md"),
    `# Bugs fixed\n## Fixed\n### ${"f".repeat(200)} (found by bug 2026-10-01)\nx\n`,
  );
  const block = renderBacklogIndexBlock(dir) ?? "";
  assert.ok(block.includes("p".repeat(159) + "…"));
  assert.ok(block.includes("f".repeat(159) + "…"));
  assert.ok(!block.includes("p".repeat(160)));
  assert.ok(!block.includes("planned 2026-10-20"));
});
