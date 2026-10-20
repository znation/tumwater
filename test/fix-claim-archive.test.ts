import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { falseFixReason, fixedEntriesAt } from "../src/verdict/fix-claim.js";
import { makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";

// A real fix claim reaches the gate as a BUGS-FIXED.md edit (the archive move right before the
// commit), so these pin the archive half of falseFixReason and the order fixedEntriesAt feeds
// the doctor; test/fix-claim.test.ts covers the BUGS.md path.

function commitBase(root: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed backlog");
}

test("falseFixReason checks a fix claim that reaches the gate as a BUGS-FIXED.md edit, and leaves an untouched archive entry alone", async () => {
  const moved = makeRepo();
  commitBase(moved, { "BUGS.md": "## Open\n\n### A bug (found 2026-09-22)\n\n**Symptom:** x.\n" });
  fs.writeFileSync(path.join(moved, "BUGS.md"), "## Open\n");
  fs.writeFileSync(
    path.join(moved, "BUGS-FIXED.md"),
    "## Fixed\n\n### A bug (found 2026-09-22, fixed 2026-09-23)\n\n" +
      "**Fix:** `phantomArchiveSymbol` now does it.\n",
  );
  const reason = await falseFixReason(moved, "main", ["BUGS-FIXED.md"]);
  assert.match(reason!, /phantomArchiveSymbol/);
  assert.match(reason!, /moves "A bug/);

  const untouched = makeRepo();
  commitBase(untouched, {
    "BUGS-FIXED.md":
      "## Fixed\n\n### Old bug (found 2026-09-01, fixed 2026-09-02)\n\n**Fix:** `longGoneSymbol` did it.\n",
    "BUGS.md": "## Open\n",
  });
  fs.writeFileSync(
    path.join(untouched, "BUGS.md"),
    "## Open\n\n### New bug (found 2026-10-20)\n\n**Symptom:** y.\n",
  );
  assert.equal(await falseFixReason(untouched, "main", ["BUGS.md"]), undefined);
});

test("fixedEntriesAt lists BUGS.md's Fixed entries before BUGS-FIXED.md's, reads the bugsMd text when given, and reads a missing file as empty", () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "BUGS.md"), "## Fixed\n\n### Live one\n\nbody\n");
  fs.writeFileSync(
    path.join(root, "BUGS-FIXED.md"),
    "## Fixed\n\n### Archived one\n\nbody\n\n### Archived two\n\nbody\n",
  );
  const titles = (text?: string) => fixedEntriesAt(root, text).map((e) => e.title);
  assert.deepEqual(titles(), ["Live one", "Archived one", "Archived two"]);
  assert.deepEqual(titles("## Fixed\n\n### Passed in\n\nbody\n"), [
    "Passed in",
    "Archived one",
    "Archived two",
  ]);
  fs.rmSync(path.join(root, "BUGS.md"));
  assert.deepEqual(titles(), ["Archived one", "Archived two"]);
  fs.rmSync(path.join(root, "BUGS-FIXED.md"));
  assert.deepEqual(titles(), []);
});
