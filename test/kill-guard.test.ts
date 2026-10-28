// The kill guard on a run's bash tool (src/pi-extension/kill-guard.ts): pi's kill-guard extension
// refuses a `bash` call that kills processes by pattern — `pkill`/`killall`, and `ps`/`pgrep`
// output fed into `kill` via `xargs` or a `$(ps|pgrep)` substitution — while letting a specific
// PID kill (`kill $!`) and any command that only reads or mentions the process table run. The run
// prompt's kill-by-PID rule stays the primary guard; this is the tool-layer net that refused the
// 2026-10-25 pattern kills in BUGS.md.
import test from "node:test";
import assert from "node:assert/strict";
import killGuard, { guardKillToolCall, PATTERN_KILL_REFUSAL, patternKillRefusal } from "../src/pi-extension/kill-guard.js";

test("pkill and killall used as a command word are refused", () => {
  assert.equal(guardKillToolCall({ toolName: "bash", input: { command: "pkill -f 'npm run test'" } })?.reason, PATTERN_KILL_REFUSAL);
  assert.equal(guardKillToolCall({ toolName: "bash", input: { command: "sleep 1; pkill node" } })?.reason, PATTERN_KILL_REFUSAL);
  assert.equal(guardKillToolCall({ toolName: "bash", input: { command: "killall test-runner" } })?.reason, PATTERN_KILL_REFUSAL);
});

test("ps or pgrep output fed into kill is refused", () => {
  // The two 2026-10-25 incident commands, verbatim shapes.
  const xargs = `ps aux | grep -E "test-runner|node --test" | grep -v grep | awk '{print $2}' | xargs -r kill`;
  assert.equal(guardKillToolCall({ toolName: "bash", input: { command: xargs } })?.reason, PATTERN_KILL_REFUSAL);
  const psForCmd = `for p in $(ps aux | grep -E "node dist/test/test-runner|node --test" | grep -v grep | awk '{print $2}'); do kill "$p"; done`;
  assert.equal(guardKillToolCall({ toolName: "bash", input: { command: psForCmd } })?.reason, PATTERN_KILL_REFUSAL);
  assert.equal(guardKillToolCall({ toolName: "bash", input: { command: "kill -9 $(pgrep -f npm)" } })?.reason, PATTERN_KILL_REFUSAL);
});

test("commands that only read or mention the process table pass", () => {
  for (const command of [
    "kill $!", // the rule's sanctioned PID kill
    "sleep 3 & kill $!", // background then stop your own
    "ps aux",
    "ps -ef | grep test-runner | grep -v grep", // an inspection, no kill
    "pgrep -f npm",
    "$(ps -o time= -p $$)", // a $(ps) substitution that reads, with no kill
    "echo pkill test", // mentions, not a command word
    "man pkill",
    "grep -rn pkill src/",
    "cat pids.txt | xargs kill", // specific pids from a file, not the process table
    "node dist/test/test-runner.js",
  ]) {
    assert.equal(patternKillRefusal(command), null, command);
  }
});

test("non-bash tools and malformed calls pass (fail-open)", () => {
  assert.equal(guardKillToolCall({ toolName: "read", input: { path: "a.ts" } }), undefined);
  assert.equal(guardKillToolCall({ toolName: "bash" }), undefined, "no input");
  assert.equal(guardKillToolCall({ toolName: "bash", input: { command: 7 } }), undefined, "non-string command");
  assert.equal(patternKillRefusal("   "), null);
});

test("the extension registers the guard as the tool_call handler", () => {
  let handler: ((event: object) => unknown) | undefined;
  killGuard({
    on(event, fn) {
      assert.equal(event, "tool_call");
      handler = fn as typeof handler;
    },
  });
  assert.ok(handler);
  const blocked = handler({ toolName: "bash", input: { command: "pkill x" } }) as { block: boolean; reason: string };
  assert.equal(blocked.block, true);
  assert.equal(blocked.reason, PATTERN_KILL_REFUSAL);
  assert.equal(handler({ toolName: "bash", input: { command: "kill $!" } }), undefined);
});
