import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NOTIFY_EVENT_TYPES, NOTIFY_MIN_GAP_MS, newNotifier, notifyCommandEnv, isNotifyFailure, notifyExitWarning, notifyFleetDown } from "../src/events/notify.js";
import { logEvent, subscribeEvents } from "../src/events/events.js";
import { formatEvent } from "../src/events/event-format.js";
import { defaultConfig, loadConfig } from "../src/config/config.js";
import { validateConfig } from "../src/config/config-validation.js";
import { setConfigKey } from "../src/config/config-write.js";
import { tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { sleep, waitFor } from "./helpers/wait.js";
import { captureStderr } from "./helpers/exit-capture.js";
import { errorMessage } from "../src/text/text.js";

// Tests for src/events/notify.ts — the operator notify hook: the `notify` shell command the
// orchestrator runs on the four allowlisted notable events. The command is real (a shell
// echo appending its env to a temp file), so the spawn path, its env vars, the per-type
// throttle, and the live-update path are all exercised end to end; nothing here calls a model.

/** A command that appends `TYPE|LOOP|MESSAGE` to `out` — the recording end every spawn test
 * reads back. The vars are double-quoted so messages with spaces survive the shell whole. */
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

function parseLine(line: string): { type: string; loop: string; message: string } {
  const parts = line.split("|");
  return { type: parts[0] ?? "", loop: parts[1] ?? "", message: parts.slice(2).join("|") };
}

test("NOTIFY_EVENT_TYPES and NOTIFY_MIN_GAP_MS stay pinned to the planned allowlist and gap", () => {
  // Pinned to the literals, not recomputed: a recomputation would pass even if the values
  // drifted (the same pinning convention as eventsRotationLabel's rotation phrase).
  assert.deepEqual(
    NOTIFY_EVENT_TYPES,
    [
      "budget_warning",
      "role_cap_warning",
      "budget_paused",
      "claude_window_warning",
      "claude_window_limited",
      "role_streak_paused",
      "role_cap_paused",
      "disk_low",
      "main_red_hold",
      "land_failed",
      "restart_blocked",
      "question_posted",
      "entry_refused",
      "supervisor_exit",
    ],
  );
  assert.ok(
    !(NOTIFY_EVENT_TYPES as readonly string[]).includes("role_cap_resumed"),
    "a resume is good news; the paused page is the actionable one",
  );
  assert.ok(
    !(NOTIFY_EVENT_TYPES as readonly string[]).includes("claude_window_reset"),
    "a window lift is good news; the limited page is the actionable one",
  );
  assert.equal(NOTIFY_MIN_GAP_MS, 60_000);
});

test("notifyCommandEnv carries exactly the three TUMWATER_EVENT_* keys with their values", () => {
  const env = notifyCommandEnv("budget_paused", "feature", "m");
  const eventKeys = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.startsWith("TUMWATER_EVENT_")),
  );
  assert.deepEqual(eventKeys, {
    TUMWATER_EVENT_TYPE: "budget_paused",
    TUMWATER_EVENT_LOOP: "feature",
    TUMWATER_EVENT_MESSAGE: "m",
  });
});

test("an allowlisted event spawns the notify command once with the three env vars set", async () => {
  const root = tmpdir();
  const out = path.join(root, "notify-out.txt");
  const notifier = newNotifier(root);
  notifier.update({ notify: recorderCommand(out) });
  try {
    const event = logEvent(root, { loop: "feature", type: "budget_paused" });
    await waitFor(() => recordedLines(out).length === 1, "one recorded line");
    const line = parseLine(recordedLines(out)[0] ?? "");
    assert.equal(line.type, "budget_paused");
    assert.equal(line.loop, "feature");
    assert.equal(line.message, formatEvent(event));
    // One event, one spawn: the burst-suppression contract the throttle exists for holds even
    // without a second event to suppress.
    await sleep(300);
    assert.equal(recordedLines(out).length, 1);
  } finally {
    notifier.dispose();
  }
});

test("a posted question spawns the notify command once with the posting role and rendered line", async () => {
  const root = tmpdir();
  const out = path.join(root, "notify-out.txt");
  const notifier = newNotifier(root);
  notifier.update({ notify: recorderCommand(out) });
  try {
    const event = logEvent(root, { loop: "feature", type: "question_posted", question: "Which storage?" });
    await waitFor(() => recordedLines(out).length === 1, "one recorded line");
    const line = parseLine(recordedLines(out)[0] ?? "");
    assert.equal(line.type, "question_posted");
    assert.equal(line.loop, "feature");
    assert.equal(line.message, formatEvent(event));
    assert.ok(line.message.includes("question posted: Which storage?"), `unexpected message: ${line.message}`);
  } finally {
    notifier.dispose();
  }
});

test("a main_red_hold spawns the notify command once with the harness loop and the red-main line", async () => {
  const root = tmpdir();
  const out = path.join(root, "notify-out.txt");
  const notifier = newNotifier(root);
  notifier.update({ notify: recorderCommand(out) });
  try {
    logEvent(root, { loop: "harness", type: "main_red_hold", sha: "abc1234", script: "test", message: "main abc1234 is red (test: x) — code merges blocked until main is green" });
    await waitFor(() => recordedLines(out).length === 1, "one recorded line");
    const line = parseLine(recordedLines(out)[0] ?? "");
    assert.equal(line.type, "main_red_hold");
    assert.equal(line.loop, "harness");
    assert.ok(line.message.includes(" main ") && line.message.includes("is red"), `unexpected message: ${line.message}`);
  } finally {
    notifier.dispose();
  }
});

test("claude window events each spawn the notify command with the rendered line", async () => {
  const root = tmpdir();
  const out = path.join(root, "notify-out.txt");
  const notifier = newNotifier(root);
  notifier.update({ notify: recorderCommand(out) });
  try {
    const resetsAt = Date.now() + 3_600_000;
    const event = logEvent(root, { loop: "harness", type: "claude_window_limited", windowType: "five_hour", resetsAt });
    await waitFor(() => recordedLines(out).length === 1, "one recorded line");
    const line = parseLine(recordedLines(out)[0] ?? "");
    assert.equal(line.type, "claude_window_limited");
    assert.equal(line.loop, "harness");
    assert.equal(line.message, formatEvent(event));
    // A different type is not suppressed by the limited page's throttle slot.
    logEvent(root, { loop: "harness", type: "claude_window_warning", windowType: "five_hour", resetsAt });
    await waitFor(() => recordedLines(out).length === 2, "a second recorded line");
    assert.equal(parseLine(recordedLines(out)[1] ?? "").type, "claude_window_warning");
  } finally {
    notifier.dispose();
  }
});

test("non-allowlisted events spawn nothing, and an absent or empty notify disables the hook", async () => {
  const root = tmpdir();
  const out = path.join(root, "notify-out.txt");
  const notifier = newNotifier(root);
  notifier.update({ notify: recorderCommand(out) });
  try {
    logEvent(root, { loop: "feature", type: "tick_end", tick: 1, result: "no_change" });
    logEvent(root, { loop: "harness", type: "warning", message: "not page-worthy" });
    logEvent(root, { loop: "feature", type: "landed" });
    logEvent(root, { loop: "harness", type: "claude_window_reset", windowType: "five_hour" });
    await sleep(400);
    assert.equal(recordedLines(out).length, 0, "off-allowlist events must spawn nothing");
    // Empty string means off — the same disabled state as an absent key.
    notifier.update({ notify: "" });
    logEvent(root, { loop: "feature", type: "budget_paused" });
    await sleep(400);
    assert.equal(recordedLines(out).length, 0, "an empty notify must spawn nothing");
  } finally {
    notifier.dispose();
  }
});

test("the throttle suppresses same-type events within the gap, per type", async () => {
  const root = tmpdir();
  const out = path.join(root, "notify-out.txt");
  // An injected clock (newNotifier's test seam) on the real 60 s gap: "inside the gap" is a
  // statement about the clock, not about how fast the host runs. A wall-clock 50 ms gap read
  // the synchronous shell spawn between two back-to-back events as the gap elapsing whenever
  // the host was loaded, and the second event paged (4 of 24 parallel runs, 2026-10-01).
  let clock = 1_000_000;
  const notifier = newNotifier(root, NOTIFY_MIN_GAP_MS, () => clock);
  notifier.update({ notify: recorderCommand(out) });
  try {
    logEvent(root, { loop: "feature", type: "budget_paused" });
    clock += NOTIFY_MIN_GAP_MS - 1;
    logEvent(root, { loop: "feature", type: "budget_paused" });
    await waitFor(() => recordedLines(out).length === 1, "the first spawn");
    clock += 1; // exactly one gap after the first spawn
    logEvent(root, { loop: "feature", type: "budget_paused" });
    await waitFor(() => recordedLines(out).length >= 2, "the post-gap spawn");
    // A second spawn that escaped the throttle would have been started before the post-gap
    // one, so it has had at least as long to land: two lines means it was suppressed.
    await sleep(100);
    assert.equal(recordedLines(out).length, 2, "the same-type event inside the gap must be suppressed");
    // Per-type keying: a land_failed right after the budget_paused page spawns on its own —
    // one type's throttle never suppresses another's.
    logEvent(root, { loop: "feature", type: "land_failed" });
    await waitFor(() => recordedLines(out).some((l) => parseLine(l).type === "land_failed"), "the other-type spawn");
  } finally {
    notifier.dispose();
  }
});

test("validateConfig rejects a non-string notify, accepts empty and command strings, and config set/get round-trips", () => {
  assert.match(
    (() => {
      try {
        validateConfig({ notify: 5 });
        return "validateConfig did not throw";
      } catch (err) {
        return errorMessage(err);
      }
    })(),
    /notify must be a string/,
  );
  assert.doesNotThrow(() => validateConfig({ notify: "" }));
  assert.doesNotThrow(() => validateConfig({ notify: "osascript -e 'display notification \"$TUMWATER_EVENT_MESSAGE\"'" }));
  assert.doesNotThrow(() => validateConfig(defaultConfig()));

  // The CLI round-trip: membership in TOP_LEVEL_KEYS makes `config set notify <cmd>` work and
  // `config get notify` read it back — the command string needs no JSON quoting (setConfigKey
  // keeps a non-JSON literal as the string it is).
  const root = tmpdir();
  writeConfig(root, defaultConfig());
  const result = setConfigKey(root, "notify", "curl -X POST https://example.test/hook");
  assert.ok(result.ok, `setConfigKey failed: ${result.ok ? "" : result.error}`);
  assert.equal(loadConfig(root).notify, "curl -X POST https://example.test/hook");
  assert.ok(setConfigKey(root, "notify", "").ok, "an empty string must be settable (it means off)");
  assert.equal(loadConfig(root).notify, "");
});

test("a notify command whose spawn fails logs one warning and does not throw out of the listener", async () => {
  const root = tmpdir();
  const warnings: string[] = [];
  const off = subscribeEvents((event) => {
    if (event.type === "warning" && typeof event.message === "string") warnings.push(event.message);
  });
  // An OS-level spawn failure with shell:true: a command line far past every platform's
  // per-argument limit (Linux caps one argv entry at 128 KiB, macOS at ~1 MiB total), so the
  // exec fails and node's spawn emits `error` even though /bin/sh itself exists.
  const notifier = newNotifier(root);
  notifier.update({ notify: `echo ${"x".repeat(2_000_000)}` });
  try {
    logEvent(root, { loop: "feature", type: "budget_paused" });
    await waitFor(() => warnings.length > 0, "the spawn-failure warning");
    assert.match(warnings[0] ?? "", /notify command could not start/);
    await sleep(300);
    assert.equal(warnings.length, 1);
  } finally {
    off();
    notifier.dispose();
  }
});

test("notifyExitWarning words a nonzero exit or kill and says nothing for a clean exit", () => {
  assert.equal(notifyExitWarning("land_failed", 0, null), undefined);
  const missing = notifyExitWarning("budget_paused", 127, null) ?? "";
  for (const part of ["code 127", "command not found", "budget_paused", "tumwater notify --test"]) {
    assert.ok(missing.includes(part), part);
  }
  const three = notifyExitWarning("land_failed", 3, null) ?? "";
  assert.match(three, /code 3/);
  assert.doesNotMatch(three, /command not found/);
  assert.match(notifyExitWarning("land_failed", null, "SIGKILL") ?? "", /SIGKILL/);
});

test("a notify hook that exits nonzero logs one warning naming the paged type", async () => {
  for (const [notify, pattern] of [
    ["exit 3", /exited with code 3 paging budget_paused/],
    ["tumwater-no-such-command-xyz", /code 127 \(command not found\)/],
  ] as const) {
    const root = tmpdir();
    const warnings: string[] = [];
    const off = subscribeEvents((event) => {
      if (event.type === "warning" && typeof event.message === "string") warnings.push(event.message);
    });
    const notifier = newNotifier(root);
    notifier.update({ notify });
    try {
      logEvent(root, { loop: "feature", type: "budget_paused" });
      await waitFor(() => warnings.some((w) => pattern.test(w)), `the exit warning for ${notify}`);
      await sleep(200);
      assert.equal(warnings.length, 1);
    } finally {
      off();
      notifier.dispose();
    }
  }
});

test("a notify hook that exits 0 records its line and logs no warning", async () => {
  const root = tmpdir();
  const out = path.join(root, "out.txt");
  const warnings: string[] = [];
  const off = subscribeEvents((event) => {
    if (event.type === "warning" && typeof event.message === "string") warnings.push(event.message);
  });
  const notifier = newNotifier(root);
  notifier.update({ notify: recorderCommand(out) });
  try {
    logEvent(root, { loop: "feature", type: "budget_paused" });
    await waitFor(() => recordedLines(out).length > 0, "the recorded line");
    await sleep(300);
    assert.deepEqual(warnings, []);
  } finally {
    off();
    notifier.dispose();
  }
});

test("a spawn-failure warning whose event write throws falls back to stderr, not an uncaught throw", async () => {
  // The async child `error` handler reports through warnEvent. That write can fail later in
  // the process's life (the disk fills, .tumwater/log is replaced); a throw out of a Node
  // `'error'` listener is an uncaught exception, so the reporting failure would kill the
  // fleet. Sabotage the feed after the triggering event is written but before the warning —
  // see the poison subscriber below — and watch where the failure goes.
  const root = tmpdir();
  const stderr = captureStderr();
  // Subscribe the poison before the notifier so the listener loop poisons the feed after the
  // triggering event is written but before the notifier spawns: whatever the child error's
  // timing (synchronous inside spawn or a later tick), the warning's write meets a root that
  // is now a regular file, so it cannot create .tumwater/log under it.
  const offPoison = subscribeEvents((e) => {
    if (e.type !== "budget_paused") return;
    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(root, "");
  });
  const notifier = newNotifier(root);
  try {
    // A command line past every platform's per-argument limit makes node emit `error`.
    notifier.update({ notify: `echo ${"x".repeat(2_000_000)}` });
    logEvent(root, { loop: "feature", type: "budget_paused" });
    await waitFor(
      () => stderr.err().includes('notify command could not start'),
      "the stderr fallback for the unwritable warning",
    );
    assert.match(
      stderr.err(),
      /warning log unwritable/,
      "the fallback names why the event log could not take the warning",
    );
  } finally {
    offPoison();
    stderr.restore();
    notifier.dispose();
  }
});

test("setting notify live takes effect on the next update(liveConfig) poll, no restart", async () => {
  const root = tmpdir();
  const out = path.join(root, "notify-out.txt");
  const notifier = newNotifier(root);
  try {
    logEvent(root, { loop: "feature", type: "budget_paused" });
    await sleep(400);
    assert.equal(recordedLines(out).length, 0, "no command configured yet — nothing spawns");
    // What the orchestrator's poll loop does with each freshly reloaded config.
    notifier.update({ notify: recorderCommand(out) });
    logEvent(root, { loop: "feature", type: "budget_paused" });
    await waitFor(() => recordedLines(out).length === 1, "the post-update spawn");
  } finally {
    notifier.dispose();
  }
});

test("notifyFleetDown runs the configured hook once with the supervisor_exit line", async () => {
  const root = tmpdir("notify-fleet-down-");
  const out = path.join(root, "out.txt");
  writeConfig(root, { ...defaultConfig(), notify: recorderCommand(out) });
  const event = { loop: "harness", type: "supervisor_exit" as const, generation: 2, code: 1, ts: Date.now() };
  notifyFleetDown(root, event);
  await waitFor(() => recordedLines(out).length === 1, "one recorded line");
  const rec = parseLine(recordedLines(out)[0]!);
  assert.equal(rec.type, "supervisor_exit");
  assert.equal(rec.loop, "harness");
  assert.equal(rec.message, formatEvent(event));
});

test("notifyFleetDown returns silently without a usable notify command", async () => {
  const event = { loop: "harness", type: "supervisor_exit" as const, generation: 1, code: 1, ts: Date.now() };
  const missing = tmpdir("notify-fleet-down-missing-");
  const invalid = tmpdir("notify-fleet-down-invalid-");
  fs.writeFileSync(path.join(invalid, "tumwater.json"), "{ not json");
  const absent = tmpdir("notify-fleet-down-absent-");
  writeConfig(absent, defaultConfig());
  for (const root of [missing, invalid, absent]) {
    const out = path.join(root, "out.txt");
    assert.doesNotThrow(() => notifyFleetDown(root, event));
    await sleep(150);
    assert.deepEqual(recordedLines(out), []);
  }
});

test("isNotifyFailure holds for each failure shape and nothing else", () => {
  const warning = (message: string) => ({ ts: 1, loop: "harness", type: "warning" as const, message });
  assert.ok(isNotifyFailure(warning(notifyExitWarning("land_failed", 3, null) ?? "")));
  assert.ok(isNotifyFailure(warning(notifyExitWarning("land_failed", null, "SIGKILL") ?? "")));
  assert.ok(isNotifyFailure(warning("notify command could not start: spawn ENOENT")));
  assert.ok(!isNotifyFailure({ ...warning("notify command exited with code 1"), loop: "feature" }));
  assert.ok(!isNotifyFailure({ ...warning("notify command exited with code 1"), type: "tick_start" }));
  assert.ok(!isNotifyFailure(warning("something else")));
});
