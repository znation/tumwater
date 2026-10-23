// The write guard on a run's file-writing tools (src/agent/write-guard.ts): pi's write-guard
// extension and claude's PreToolUse hook refuse a write under the team root but outside the run's
// own worktree, and name the same file inside the worktree when it has one.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { strayWriteRefusal } from "../src/agent/write-guard.js";
import writeGuard, { guardToolCall } from "../src/pi-extension/write-guard.js";
import { claudeWriteRefusal, writeGuardSettings } from "../src/agent/claude/claude-write-guard.js";
import opencodeWriteGuard, { guardEvaluate } from "../src/agent/opencode/write-guard-plugin/index.js";
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

test("a write that drops the worktree's path infix is refused and names the same file inside the worktree", () => {
  const { root, wt } = team();
  const refusal = strayWriteRefusal(path.join(root, "src", "a.ts"), wt);
  assert.ok(refusal);
  assert.match(refusal, /is in the primary checkout, outside this run's worktree/);
  assert.ok(refusal.includes(`Write ${path.join(wt, "src", "a.ts")} instead`), refusal);
  // A relative path that climbs out of the worktree reaches the same file and the same refusal.
  assert.equal(strayWriteRefusal("../../../src/a.ts", wt), refusal);
  // pi's `@` prefix is dropped, and a file that does not exist yet still has its twin named.
  const fresh = strayWriteRefusal(`@${path.join(root, "new", "b.ts")}`, wt);
  assert.ok(fresh?.includes(`Write ${path.join(wt, "new", "b.ts")} instead`), fresh ?? "");
});

test("writes inside the worktree, outside the team root, and from outside any worktree pass", () => {
  const { root, wt } = team();
  assert.equal(strayWriteRefusal("src/a.ts", wt), null);
  assert.equal(strayWriteRefusal(path.join(wt, "src", "new", "c.ts"), wt), null);
  assert.equal(strayWriteRefusal(path.join(tmpdir(), "scratch.log"), wt), null, "scratch outside the root");
  assert.equal(strayWriteRefusal(path.join(root, "src", "a.ts"), root), null, "a run in the root itself");
  assert.equal(strayWriteRefusal(path.join(root, "src", "a.ts"), tmpdir()), null, "a run in no team");
});

test("a write into another run's checkout is refused and pointed at the same path in the run's own", () => {
  const { wt, other } = team();
  const refusal = strayWriteRefusal(path.join(other, "src", "a.ts"), wt);
  assert.ok(refusal);
  assert.match(refusal, /is in another checkout \(_slot-2\)/);
  assert.ok(refusal.includes(`Write ${path.join(wt, "src", "a.ts")} instead`), refusal);
});

test("tumwater's state and the primary's node_modules are refused with no twin path to write", () => {
  const { root, wt } = team();
  const note = strayWriteRefusal(path.join(root, ".tumwater", "state", "notes", "feature.md"), wt);
  assert.match(note ?? "", /is in tumwater's own state/);
  assert.match(note ?? "", /Save role notes with `tumwater-notes write` instead\.$/);
  const state = strayWriteRefusal(path.join(root, ".tumwater", "state", "feature.json"), wt);
  assert.match(state ?? "", /tumwater's own state.*Leave it alone and work only inside the worktree\.$/);
  const dep = strayWriteRefusal(path.join(root, "node_modules", "pkg", "index.js"), wt);
  assert.match(dep ?? "", /is in the primary checkout.*Leave it alone/);
  assert.ok(!dep?.includes(" instead"), "no twin path: a node_modules in the worktree breaks borrowing");
});

test("a .tumwater directory or a symlink inside the worktree does not let a primary write through", () => {
  const { root, wt } = team();
  // A run's own tests can leave a .tumwater in its checkout; the nearest-ancestor root walk would
  // then put the primary checkout outside the team and pass the write.
  fs.mkdirSync(path.join(wt, ".tumwater", "log"), { recursive: true });
  assert.match(strayWriteRefusal(path.join(root, "src", "a.ts"), wt) ?? "", /primary checkout/);
  fs.symlinkSync(path.join(root, "src"), path.join(wt, "linked"));
  const viaLink = strayWriteRefusal(path.join(wt, "linked", "a.ts"), wt);
  assert.ok(viaLink?.includes(`Write ${path.join(wt, "src", "a.ts")} instead`), viaLink ?? "");
});

test("the pi extension blocks a stray edit or write and lets other tools and in-worktree writes run", () => {
  const { root, wt } = team();
  let handler: ((event: object, ctx?: { cwd?: unknown }) => unknown) | undefined;
  writeGuard({
    on(event, fn) {
      assert.equal(event, "tool_call");
      handler = fn as typeof handler;
    },
  });
  assert.ok(handler);
  const stray = path.join(root, "src", "a.ts");
  for (const toolName of ["edit", "write"]) {
    const blocked = handler({ toolName, input: { path: stray } }, { cwd: wt }) as { block: boolean; reason: string };
    assert.equal(blocked.block, true, toolName);
    assert.equal(blocked.reason, strayWriteRefusal(stray, wt));
  }
  assert.equal(handler({ toolName: "read", input: { path: stray } }, { cwd: wt }), undefined);
  assert.equal(handler({ toolName: "bash", input: { command: `echo x > ${stray}` } }, { cwd: wt }), undefined);
  assert.equal(handler({ toolName: "write", input: { path: "src/a.ts" } }, { cwd: wt }), undefined);
  assert.equal(guardToolCall({ toolName: "write", input: { path: 7 } }, wt), undefined);
  assert.equal(guardToolCall({ toolName: "edit" }, wt), undefined);
});

test("claudeWriteRefusal refuses a stray Edit or Write and resolves relative paths from claude's cwd", () => {
  const { root, wt } = team();
  const stray = path.join(root, "src", "a.ts");
  const expected = strayWriteRefusal(stray, wt);
  for (const tool of ["Edit", "Write"]) {
    assert.equal(claudeWriteRefusal({ tool_name: tool, tool_input: { file_path: stray }, cwd: wt }, wt), expected, tool);
  }
  assert.equal(claudeWriteRefusal({ tool_name: "Write", tool_input: { file_path: stray } }, wt), expected, "no cwd in the payload");
  assert.equal(claudeWriteRefusal({ tool_name: "Read", tool_input: { file_path: stray } }, wt), null);
  // claude's cwd follows a Bash `cd` into src/; the worktree still comes from the hook argument.
  const cwd = path.join(wt, "src");
  assert.equal(claudeWriteRefusal({ tool_name: "Write", tool_input: { file_path: "a.ts" }, cwd }, wt), null);
  assert.equal(claudeWriteRefusal({ tool_name: "Write", tool_input: { file_path: "../../../../src/a.ts" }, cwd }, wt), expected);
  assert.equal(claudeWriteRefusal("not an object", wt), null);
});

test("the hook claude runs denies a stray write with the refusal as its reason and stays silent otherwise", () => {
  const { root, wt } = team();
  const stray = path.join(root, "src", "a.ts");
  /** Run the settings' PreToolUse command as claude does, through the shell, with `stdin`. */
  function runHook(settings: string, stdin: string): { status: number | null; stdout: string } {
    const entry = JSON.parse(settings).hooks.PreToolUse[0];
    assert.equal(entry.matcher, "Edit|Write");
    const out = spawnSync("sh", ["-c", entry.hooks[0].command], { input: stdin, encoding: "utf8" });
    return { status: out.status, stdout: out.stdout };
  }
  const settings = writeGuardSettings(wt);
  const denied = runHook(settings, JSON.stringify({ tool_name: "Write", tool_input: { file_path: stray }, cwd: wt }));
  assert.equal(denied.status, 0);
  assert.deepEqual(JSON.parse(denied.stdout), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: strayWriteRefusal(stray, wt) },
  });
  const inside = path.join(wt, "src", "a.ts");
  assert.deepEqual(runHook(settings, JSON.stringify({ tool_name: "Edit", tool_input: { file_path: inside }, cwd: wt })), { status: 0, stdout: "" });
  assert.deepEqual(runHook(settings, "not json"), { status: 0, stdout: "" }, "a hook that cannot read its input lets the write run");
  // A node binary that moved since the run started falls back to `node` on PATH, as the notes
  // shim does.
  const moved = runHook(writeGuardSettings(wt, path.join(tmpdir(), "gone", "node")), JSON.stringify({ tool_name: "Write", tool_input: { file_path: stray } }));
  assert.equal(JSON.parse(moved.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("the opencode plugin denies an edit decision for a stray path and leaves every other decision alone", async () => {
  const { root, wt } = team();
  const stray = path.join(root, "src", "a.ts");
  let hook: ((event: Record<string, unknown>) => void) | undefined;
  await opencodeWriteGuard.setup({
    location: { directory: wt },
    permission: {
      hook(name, callback) {
        assert.equal(name, "evaluate");
        hook = callback as typeof hook;
      },
    },
  });
  assert.ok(hook);
  const denied: Record<string, unknown> = { action: "edit", resources: [path.join(wt, "src", "a.ts"), stray], effect: "allow" };
  hook(denied);
  assert.deepEqual(denied, { action: "edit", resources: [path.join(wt, "src", "a.ts"), stray], effect: "deny", message: strayWriteRefusal(stray, wt) });
  const inside = { action: "edit", resources: [path.join(wt, "src", "a.ts")], effect: "allow" };
  hook(inside);
  assert.equal(inside.effect, "allow");
  // OpenCode also asks external_directory and read for paths outside the worktree; reads stay open.
  for (const action of ["external_directory", "read"]) {
    const other = { action, resources: [stray], effect: "allow" };
    guardEvaluate(other, wt);
    assert.equal(other.effect, "allow", action);
  }
  // A context with no directory registers nothing rather than guarding the wrong checkout.
  let registered = false;
  await opencodeWriteGuard.setup({ location: {}, permission: { hook: () => { registered = true; } } });
  assert.equal(registered, false);
});
