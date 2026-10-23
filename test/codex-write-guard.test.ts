// The codex write-guard hook (src/agent/codex/codex-write-guard.ts, write-guard-hook.ts; plans/
// codex-write-guard.md "The hook (parts 1–2)"; PLANS.md "Write guard on Codex, part 2/9"): the
// hook a codex run calls before every `apply_patch` refuses a patch that writes outside the run's
// worktree with `strayWriteRefusal`'s text, and stays silent for any other call or when it cannot
// read its input.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strayWriteRefusal } from "../src/agent/write-guard.js";
import { codexWriteRefusal } from "../src/agent/codex/codex-write-guard.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** A team root with its primary checkout's `src/a.ts`, the run's worktree `_slot-1` and another
 * run's `_slot-2`, each holding the same file. Real paths, as the guard reports them. */
function team(): { root: string; wt: string; other: string } {
  const root = fs.realpathSync(tmpdir());
  const wt = path.join(root, ".tumwater", "worktrees", "_slot-1");
  const other = path.join(root, ".tumwater", "worktrees", "_slot-2");
  for (const dir of [root, wt, other]) {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export {};\n");
  }
  return { root, wt, other };
}

/** A codex PreToolUse payload for an `apply_patch` writing `...`, run from `cwd`. */
function payload(command: string, cwd: string): Record<string, unknown> {
  return { tool_name: "apply_patch", tool_input: { command }, cwd };
}

test("codexWriteRefusal refuses an Update at the primary's absolute path and names the same file in the worktree", () => {
  const { root, wt } = team();
  const refusal = codexWriteRefusal(payload(`*** Update File: ${path.join(root, "src", "a.ts")}`, wt));
  assert.equal(refusal, strayWriteRefusal(path.join(root, "src", "a.ts"), wt));
  assert.ok(refusal?.includes(`Write ${path.join(wt, "src", "a.ts")} instead`), refusal ?? "");
});

test("an in-worktree relative Update, a Bash call and a payload with no cwd pass", () => {
  const { root, wt } = team();
  assert.equal(codexWriteRefusal(payload("*** Update File: src/a.ts", wt)), null);
  assert.equal(codexWriteRefusal({ tool_name: "Bash", tool_input: { command: "echo hi" }, cwd: wt }), null);
  assert.equal(codexWriteRefusal({ tool_name: "apply_patch", tool_input: { command: `*** Update File: ${path.join(root, "src", "a.ts")}` } }), null, "no cwd");
  assert.equal(codexWriteRefusal("not an object"), null);
});

test("a patch whose Move leaves the worktree is refused", () => {
  const { root, wt } = team();
  const patch = `*** Begin Patch\n*** Update File: ${path.join(root, "src", "a.ts")}\n@@\n-old\n+new\n*** Move to: ${path.join(root, "src", "moved.ts")}\n*** End Patch`;
  const refusal = codexWriteRefusal(payload(patch, wt));
  assert.equal(refusal, strayWriteRefusal(path.join(root, "src", "a.ts"), wt));
});

test("a first in-worktree path does not hide a later stray path in the same patch", () => {
  const { root, wt } = team();
  const patch = `*** Update File: src/a.ts\n*** Add File: ${path.join(root, "src", "new.ts")}`;
  assert.equal(codexWriteRefusal(payload(patch, wt)), strayWriteRefusal(path.join(root, "src", "new.ts"), wt));
});

test("the hook codex runs denies a stray apply_patch with the refusal as its reason and stays silent otherwise", () => {
  const { root, wt } = team();
  const hook = fileURLToPath(new URL("../src/agent/codex/write-guard-hook.js", import.meta.url));
  const stray = payload(`*** Update File: ${path.join(root, "src", "a.ts")}`, wt);
  const denied = spawnSync("node", [hook], { input: JSON.stringify(stray), encoding: "utf8" });
  assert.equal(denied.status, 0);
  assert.deepEqual(JSON.parse(denied.stdout), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: strayWriteRefusal(path.join(root, "src", "a.ts"), wt) },
  });
  const inside = payload("*** Update File: src/a.ts", wt);
  const passed = spawnSync("node", [hook], { input: JSON.stringify(inside), encoding: "utf8" });
  assert.deepEqual({ status: passed.status, stdout: passed.stdout }, { status: 0, stdout: "" });
  const bad = spawnSync("node", [hook], { input: "not json", encoding: "utf8" });
  assert.deepEqual({ status: bad.status, stdout: bad.stdout }, { status: 0, stdout: "" }, "a hook that cannot read its input lets the patch run");
});
