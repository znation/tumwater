import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { protectedEditReason } from "../src/review/protected-edits.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { makeRepo, sh } from "./fixtures/repo-fixtures.js";

const block = (body: string) => `<!-- tumwater:prompt:start -->\n${body}\n<!-- tumwater:prompt:end -->\n`;
const BASE_README = `# T\n\n${block("the prompt")}\n## Status\n\nold\n`;

/** A repo whose main carries `base`, and a worktree whose working tree then gets `edit`
 * (a null value deletes the file); returns the reason for the changed files under `role`. */
async function reason(
  base: Record<string, string>,
  edit: Record<string, string | null>,
  role = "improve",
): Promise<string | undefined> {
  const root = makeRepo();
  for (const [f, c] of Object.entries(base)) fs.writeFileSync(path.join(root, f), c);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "base");
  const wt = await ensureWorktree(root, "improve", "main");
  for (const [f, c] of Object.entries(edit)) {
    if (c === null) fs.rmSync(path.join(wt, f));
    else fs.writeFileSync(path.join(wt, f), c);
  }
  return protectedEditReason(wt, "main", Object.keys(edit), role);
}

for (const file of ["README.md", "TUMWATER.md"]) {
  test(`${file}: a changed, removed, or deleted prompt block is rejected`, async () => {
    const base = { [file]: BASE_README };
    assert.match((await reason(base, { [file]: BASE_README.replace("the prompt", "other") }))!, new RegExp(`^${file.replace(".", "\\.")} changes the initial prompt`));
    assert.ok(await reason(base, { [file]: "# T\n" }));
    assert.ok(await reason(base, { [file]: null }));
  });

  test(`${file}: an edit outside the markers, or a moved block, passes`, async () => {
    const base = { [file]: BASE_README };
    assert.equal(await reason(base, { [file]: BASE_README.replace("old", "new") }), undefined);
    assert.equal(await reason(base, { [file]: `${block("the prompt")}\n# T\n\n## Status\n\nold\n` }), undefined);
  });
}

test("a file whose base had no block may gain one", async () => {
  assert.equal(await reason({ "README.md": "# T\n" }, { "README.md": BASE_README }), undefined);
});

test("PRINCIPLES.md is editable only by the director and steward", async () => {
  const base = { "PRINCIPLES.md": "# P\n" };
  const edit = { "PRINCIPLES.md": "# P\n- x\n" };
  assert.match((await reason(base, edit, "improve"))!, /edited by the improve loop/);
  assert.match((await reason(base, edit, "feature-2"))!, /edited by the feature-2 loop/);
  assert.equal(await reason(base, edit, "director"), undefined);
  assert.equal(await reason(base, edit, "steward"), undefined);
});

test("a change touching neither file returns undefined", async () => {
  assert.equal(await reason({ "a.md": "x\n" }, { "a.md": "y\n" }), undefined);
});
