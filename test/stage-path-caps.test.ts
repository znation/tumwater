import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitLevelFindings } from "../src/run/stage-path-checks.js";
import { pad2 } from "../src/text/datetime.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { makeRepo, sh } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

// Pins that each git-level finding of the staging self-check stops at its cap, and that the
// missing-path and lost-newline findings say how many they left out. Names are zero-padded so
// git's path order is the numeric order and no name is a prefix of another.

/** A repo whose main carries `files` (path → content), plus the improve worktree off main. */
async function repoWith(files: Record<string, string>): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  for (const [file, content] of Object.entries(files)) {
    writeFileDeep(path.join(root, file), content);
  }
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "base");
  const wt = await ensureWorktree(root, "improve", "main");
  return { root, wt };
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

test("a missing-path finding names the first ten paths and counts the rest", async () => {
  const { wt } = await repoWith({ "src/keep.ts": "export const k = 1;\n", "README.md": "Start.\n" });
  const lines = range(12).map((i) => `See src/x/f${pad2(i)}.ts.\n`);
  fs.appendFileSync(path.join(wt, "README.md"), lines.join(""));
  const findings = await gitLevelFindings(wt, "main");
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.includes("src/x/f09.ts"));
  assert.ok(!findings[0]!.includes("src/x/f10.ts"));
  assert.ok(findings[0]!.endsWith(" (+2 more)"));
});

test("a lost-final-newline finding names the first ten files and counts the rest", async () => {
  const files: Record<string, string> = {};
  for (const i of range(11)) files[`src/n${pad2(i)}.ts`] = "export const n = 1;\n";
  const { wt } = await repoWith(files);
  for (const i of range(11)) fs.writeFileSync(path.join(wt, `src/n${pad2(i)}.ts`), "export const n = 1;");
  const findings = await gitLevelFindings(wt, "main");
  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /removes the final newline from: /);
  assert.ok(findings[0]!.includes("src/n09.ts"));
  assert.ok(!findings[0]!.includes("src/n10.ts"));
  assert.ok(findings[0]!.endsWith(" (+1 more)"));
});

test("a change deleting more referenced paths than the cap reports only the cap's worth", async () => {
  const files: Record<string, string> = {};
  for (const i of range(11)) files[`src/d${pad2(i)}.ts`] = "export const d = 1;\n";
  files["README.md"] = range(11).map((i) => `See src/d${pad2(i)}.ts.\n`).join("");
  const { wt } = await repoWith(files);
  for (const i of range(11)) fs.rmSync(path.join(wt, `src/d${pad2(i)}.ts`));
  const findings = await gitLevelFindings(wt, "main");
  const stale = findings.filter((f) => f.includes(" was deleted but is still named at: "));
  assert.equal(stale.length, 10);
});

test("one stale reference lists at most ten of its hits", async () => {
  const guide = range(12).map((i) => `Line ${i} names src/d.ts here.\n`).join("");
  const { wt } = await repoWith({ "src/d.ts": "export const d = 1;\n", "docs/guide.md": guide });
  fs.rmSync(path.join(wt, "src/d.ts"));
  const findings = await gitLevelFindings(wt, "main");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.match(/docs\/guide\.md:\d+/g)?.length, 10);
});
