import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TELEMETRY_DIGEST_DAYS, telemetryDigest } from "../src/tick/telemetry-digest.js";
import { atLocalTs as at } from "./helpers/oracles.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";

// The digest buckets by LOCAL calendar day, so fixtures build timestamps from local date parts
// (never UTC strings), matching the reader and collectReport (dayKey).

test("TELEMETRY_DIGEST_DAYS is the role's one-day window", () => {
  assert.equal(TELEMETRY_DIGEST_DAYS, 1);
});

test("telemetryDigest renders the digest over the role's one-day window", () => {
  const root = makeRepo();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", result: "error", error: "pi exited null" },
    { ts: at(3), loop: "feature", type: "run_end", result: "error", error: "older, out of window" },
  ]);
  const digest = telemetryDigest(root);
  assert.ok(digest, "a readable log always yields a digest string");
  assert.match(digest, /\(1 day\)/);
  assert.match(digest, /pi exited null/);
  assert.doesNotMatch(digest, /older, out of window/);
});

test("a corrupted events-log path renders the unreadable alarm and never breaks the tick", () => {
  const root = makeRepo();
  // The log path occupied by a directory — the class of filesystem damage a crash or a
  // stray tool can leave behind. The read layer reports the outcome instead of throwing
  // (the never-fail-the-tick policy), so telemetryDigest still returns a digest.
  fs.mkdirSync(path.join(root, ".tumwater", "log", "events.jsonl"), { recursive: true });
  const digest = telemetryDigest(root);
  assert.ok(digest, "an unreadable log still yields a digest, never a throw");
  assert.match(digest, /^log unreadable — evidence missing$/m);
  assert.doesNotMatch(digest, /no events retained/);
  assert.match(digest, /no finished runs in the window/);
});

test("a log of malformed lines renders the unreadable alarm: the feed is named, not silently empty", () => {
  const root = makeRepo();
  // Torn or corrupt lines (a crash mid-write) fail to parse; with no parseable line left the
  // digest must say the feed could not be read rather than report a quiet fleet.
  writeEvents(root, ["{not json", "{ also broken"]);
  const digest = telemetryDigest(root);
  assert.ok(digest, "malformed lines never take the degrade-to-undefined path");
  assert.match(digest, /^log unreadable — evidence missing$/m);
  assert.doesNotMatch(digest, /no events retained/);
  assert.match(digest, /no finished runs in the window/);
});

test("a missing log reads as idle while a present-but-corrupt feed is named unreadable", () => {
  // The bug: both shapes rendered the same "no events retained", so the telemetry role's own
  // evidence could not tell "the fleet was idle" from "I could not read the log".
  const missing = makeRepo();
  assert.match(telemetryDigest(missing) ?? "", /^no events retained$/m);

  const corrupt = makeRepo();
  writeEvents(corrupt, ["{not json"]);
  const digest = telemetryDigest(corrupt) ?? "";
  assert.match(digest, /^log unreadable — evidence missing$/m);
  assert.doesNotMatch(digest, /no events retained/);
});
