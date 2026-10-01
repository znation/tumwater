import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TELEMETRY_DIGEST_DAYS, telemetryDigest } from "../src/telemetry-digest.js";
import { atLocalTs as at } from "./oracles.js";
import { writeEvents } from "./log-fixtures.js";
import { makeRepo } from "./repo-fixtures.js";

// The digest buckets by LOCAL calendar day, so fixtures build timestamps from local date parts
// (never UTC strings), matching the reader and collectReport (dayKey).

test("TELEMETRY_DIGEST_DAYS is the role's one-day window", () => {
  assert.equal(TELEMETRY_DIGEST_DAYS, 1);
});

test("telemetryDigest renders the digest over the role's one-day window", () => {
  const root = makeRepo();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "pi exited null" },
    { ts: at(3), loop: "feature", type: "tick_end", result: "error", error: "older, out of window" },
  ]);
  const digest = telemetryDigest(root);
  assert.ok(digest, "a readable log always yields a digest string");
  assert.match(digest, /\(1 day\)/);
  assert.match(digest, /pi exited null/);
  assert.doesNotMatch(digest, /older, out of window/);
});

test("a corrupted events-log path never breaks the observer's tick-time digest", () => {
  const root = makeRepo();
  // The log path occupied by a directory — the class of filesystem damage a crash or a
  // stray tool can leave behind. The read layer treats every read failure as "no data"
  // (the same policy as a missing log), so telemetryDigest still returns a digest — it
  // must never throw into the tick that injects it.
  fs.mkdirSync(path.join(root, ".tumwater", "log", "events.jsonl"), { recursive: true });
  const digest = telemetryDigest(root);
  assert.ok(digest, "an unreadable log degrades to the empty-window digest, never a throw");
  assert.match(digest, /no events retained/);
  assert.match(digest, /no tick_end events in the window/);
});

test("a log of malformed lines still yields a digest: garbage is skipped, not fatal", () => {
  const root = makeRepo();
  // Torn or corrupt lines (a crash mid-write) fail to parse and are skipped by the reader;
  // the digest over what remains renders its empty-window shape instead of throwing.
  writeEvents(root, ["{not json", "{ also broken"]);
  const digest = telemetryDigest(root);
  assert.ok(digest, "malformed lines never take the degrade-to-undefined path");
  assert.match(digest, /no tick_end events in the window/);
});
