import test from "node:test";
import assert from "node:assert/strict";
import { checkNotify } from "../src/doctor/doctor-notify.js";
import { logEvent, warnEvent } from "../src/events/events.js";
import { notifyExitWarning } from "../src/events/notify.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { defaultConfig } from "../src/config/config.js";
import { readyRepo } from "./fixtures/doctor-fixtures.js";

// Tests for src/doctor/doctor-notify.ts — the `notify` row: configured or not, and a warning
// when the hook failed to page in the last day. Events are real lines in a temp repo's log.

const withNotify = (): TumwaterConfig => ({ ...defaultConfig(), notify: "my-hook" });

test("checkNotify is ok and says pages are off when no notify command is configured", () => {
  const root = readyRepo();
  const out = checkNotify(root, defaultConfig());
  assert.equal(out.level, "ok");
  assert.match(out.detail, /pages are off/);
  assert.match(checkNotify(root, undefined).detail, /pages are off/);
});

test("checkNotify is ok when configured and no page failed", () => {
  const root = readyRepo();
  assert.equal(checkNotify(root, withNotify()).level, "ok");
});

test("checkNotify warns naming the count, the exit code, and the --test hint", () => {
  const root = readyRepo();
  warnEvent(root, "tumwater", notifyExitWarning("budget_paused", 127, null) ?? "");
  const out = checkNotify(root, withNotify());
  assert.equal(out.level, "warn");
  assert.match(out.detail, /1 failed page /);
  assert.match(out.detail, /code 127/);
  assert.match(out.detail, /tumwater notify --test/);
});

test("checkNotify ignores a failure older than 24h", () => {
  const root = readyRepo();
  warnEvent(root, "tumwater", notifyExitWarning("budget_paused", 1, null) ?? "");
  const out = checkNotify(root, withNotify(), Date.now() + 25 * 3600_000);
  assert.equal(out.level, "ok");
});

test("checkNotify does not count other loops' warnings or non-warning events", () => {
  const root = readyRepo();
  const message = notifyExitWarning("budget_paused", 1, null) ?? "";
  warnEvent(root, "feature", message);
  logEvent(root, { loop: "harness", type: "run_start", message });
  assert.equal(checkNotify(root, withNotify()).level, "ok");
});
