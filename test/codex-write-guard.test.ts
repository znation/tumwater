// The codex write-guard hook (src/agent/codex/codex-write-guard.ts, codex-write-guard-hook.ts;
// plans/
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
import { codexWriteRefusal, codexWriteGuardDefinition, codexHookArg, codexHookTrustArg, tomlString } from "../src/agent/codex/codex-write-guard.js";
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
  const hook = fileURLToPath(new URL("../src/agent/codex/codex-write-guard-hook.js", import.meta.url));
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

test("codexHookArg and codexHookTrustArg produce exact TOML strings (part 3/9)", () => {
  const def = { matcher: "^apply_patch$", command: "n='node'; exec node ./write-guard-hook.js", timeout: 30 };
  assert.equal(
    codexHookArg(def),
    'hooks.PreToolUse=[{matcher="^apply_patch$",hooks=[{type="command",command="n=\'node\'; exec node ./write-guard-hook.js",timeout=30}]}]',
  );
  assert.equal(codexHookTrustArg({ key: "c0de.x", hash: "abc123" }), 'hooks.state={"c0de.x"={trusted_hash="abc123"}}');
});

test("tomlString escapes backslash, quote and control characters (part 3/9)", () => {
  assert.equal(tomlString('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(tomlString("line1\nline2"), '"line1\\u000aline2"');
  assert.equal(tomlString("tab\tchar"), '"tab\\u0009char"');
  assert.equal(tomlString("plain text"), '"plain text"');
});

test("codexWriteGuardDefinition's command round-trips a tricky nodeBin through sh -c and still denies a stray patch (part 3/9)", () => {
  const { root, wt } = team();
  // A node binary reached through a path with a space, a single quote and a double quote;
  // its definition's command must quote each so `sh -c` still runs the hook.
  const dir = path.join(tmpdir(), "node 'bin' \"dir\"");
  fs.mkdirSync(dir, { recursive: true });
  const fakeBin = path.join(dir, "node");
  fs.symlinkSync(process.execPath, fakeBin);
  const def = codexWriteGuardDefinition(fakeBin);
  assert.equal(def.matcher, "^apply_patch$");
  assert.equal(def.timeout, 30);
  const stray = JSON.stringify(payload(`*** Update File: ${path.join(root, "src", "a.ts")}`, wt));
  const run = spawnSync("sh", ["-c", def.command], { input: stray, encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: strayWriteRefusal(path.join(root, "src", "a.ts"), wt) },
  });
});
