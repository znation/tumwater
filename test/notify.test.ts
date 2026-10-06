import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NOTIFY_EVENT_TYPES, NOTIFY_MIN_GAP_MS, newNotifier } from "../src/notify.js";
import { logEvent, subscribeEvents } from "../src/events/events.js";
import { formatEvent } from "../src/events/event-format.js";
import { defaultConfig, loadConfig } from "../src/config/config.js";
import { validateConfig } from "../src/config/config-validation.js";
import { setConfigKey } from "../src/config/config-write.js";
import { tmpdir, writeConfig } from "./repo-fixtures.js";
import { sleep, waitFor } from "./wait.js";
import { errorMessage } from "../src/text.js";

// Tests for src/notify.ts — the operator notify hook: the `notify` shell command the
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
      "budget_paused",
      "role_streak_paused",
      "role_cap_paused",
      "land_failed",
      "restart_blocked",
    ],
  );
  assert.ok(
    !(NOTIFY_EVENT_TYPES as readonly string[]).includes("role_cap_resumed"),
    "a resume is good news; the paused page is the actionable one",
  );
  assert.equal(NOTIFY_MIN_GAP_MS, 60_000);
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

test("non-allowlisted events spawn nothing, and an absent or empty notify disables the hook", async () => {
  const root = tmpdir();
  const out = path.join(root, "notify-out.txt");
  const notifier = newNotifier(root);
  notifier.update({ notify: recorderCommand(out) });
  try {
    logEvent(root, { loop: "feature", type: "tick_end", tick: 1, result: "no_change" });
    logEvent(root, { loop: "harness", type: "warning", message: "not page-worthy" });
    logEvent(root, { loop: "feature", type: "landed" });
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
  } finally {
    off();
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
