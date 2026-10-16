import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initializedRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { setConfigKey } from "../src/config/config-write.js";
import { runNotifyHook, NOTIFY_TEST_TIMEOUT_MS } from "../src/cli/notify-command.js";

// The `notify --test` command: run the configured notify hook once with a synthetic event, via
// the CLI the way the cli-queue tests drive `queue` — an initialized repo, child-process runs,
// output assertions. The real hook is a shell echo appending its env to a temp file.

/** A command that appends `TYPE|LOOP|MESSAGE` to `out` — the recorder `tumwater notify --test`
 * runs. Double quotes keep a message with spaces whole through the shell. */
function recorderCommand(out: string): string {
  return `echo "$TUMWATER_EVENT_TYPE|$TUMWATER_EVENT_LOOP|$TUMWATER_EVENT_MESSAGE" >> ${out}`;
}

function recordedLines(out: string): string[] {
  try {
    return fs.readFileSync(out, "utf8").split("\n").filter((line) => line !== "");
  } catch {
    return [];
  }
}

test("bare notify exits non-zero naming the --test usage", async () => {
  const repo = await initializedRepo();
  const r = await cli(repo, "notify");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: tumwater notify --test/);
});

test("notify --test with no configured hook exits non-zero naming the missing setting", async () => {
  const repo = await initializedRepo();
  const r = await cli(repo, "notify", "--test");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /notify is not configured/);
});

test("notify --test runs the hook once with the synthetic event and reports exit 0", async () => {
  const repo = await initializedRepo();
  const out = path.join(repo, "notify-out.txt");
  const result = setConfigKey(repo, "notify", recorderCommand(out));
  assert.ok(result.ok, `setConfigKey failed: ${result.ok ? "" : result.error}`);
  const r = await cli(repo, "notify", "--test");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /running the notify hook/);
  assert.match(r.stdout, /notify hook exited 0/);
  assert.deepEqual(recordedLines(out), ["land_failed|harness|tumwater notify --test"]);
});

test("a hook that exits non-zero makes notify --test exit non-zero and print the code", async () => {
  const repo = await initializedRepo();
  const result = setConfigKey(repo, "notify", "exit 3");
  assert.ok(result.ok, `setConfigKey failed: ${result.ok ? "" : result.error}`);
  const r = await cli(repo, "notify", "--test");
  assert.equal(r.code, 1);
  assert.match(r.stdout, /notify hook exited with code 3/);
});

test("a hook that cannot be found names the command-not-found exit rather than a bare code", async () => {
  const repo = await initializedRepo();
  const result = setConfigKey(repo, "notify", "definitely-not-a-real-command-77xyz");
  assert.ok(result.ok, `setConfigKey failed: ${result.ok ? "" : result.error}`);
  const r = await cli(repo, "notify", "--test");
  assert.equal(r.code, 1);
  assert.match(r.stdout, /notify hook exited with code 127 \(command not found\)/);
});

test("a hook that never exits is killed at the timeout and reported, not awaited forever", async () => {
  const repo = await initializedRepo();
  const result = setConfigKey(repo, "notify", "sleep 60");
  assert.ok(result.ok, `setConfigKey failed: ${result.ok ? "" : result.error}`);
  const r = await cli(repo, "notify", "--test");
  assert.equal(r.code, 1);
  assert.match(r.stdout, new RegExp(`did not finish within ${NOTIFY_TEST_TIMEOUT_MS / 1000}s and was killed`));
});

test("runNotifyHook resolves a never-ending hook at the injected timeout", async () => {
  const r = await runNotifyHook("sleep 30", {}, 150);
  assert.deepEqual(r, { timedOut: true });
});
