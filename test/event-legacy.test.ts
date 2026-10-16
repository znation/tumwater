import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canonicalEventType, normalizeLegacyEvent } from "../src/events/event-legacy.js";
import { parseEventLine, readEvents } from "../src/events/event-read.js";
import { readWindowEvents } from "../src/events/event-window.js";
import { logEvent, subscribeEvents, type HarnessEventInput } from "../src/events/events.js";
import { cmdLogs } from "../src/cli/log-commands.js";
import { eventsArchivePath, eventsLogPath } from "../src/paths.js";
import { dayKey } from "../src/text/datetime.js";
import { ensureParentDir } from "../src/files/files.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { captureStdout } from "./helpers/exit-capture.js";

const OLD = JSON.stringify({ ts: Date.now(), loop: "harness", type: "fleet_paused" }); // vocabulary-ok: legacy event name read from old logs

test("canonicalEventType maps an old name and leaves anything else alone", () => {
  assert.equal(canonicalEventType("fleet_paused"), "team_paused"); // vocabulary-ok: legacy event name read from old logs
  assert.equal(canonicalEventType("fleet_resumed"), "team_resumed"); // vocabulary-ok: legacy event name read from old logs
  assert.equal(canonicalEventType("tick_start"), "run_start"); // vocabulary-ok: legacy event name read from old logs
  assert.equal(canonicalEventType("tick_end"), "run_end"); // vocabulary-ok: legacy event name read from old logs
  assert.equal(canonicalEventType("tick_deferred"), "run_deferred"); // vocabulary-ok: legacy event name read from old logs
  assert.equal(canonicalEventType("tick_aborted"), "run_aborted"); // vocabulary-ok: legacy event name read from old logs
  assert.equal(canonicalEventType("team_paused"), "team_paused");
  assert.equal(canonicalEventType("toString"), "toString");
});

test("normalizeLegacyEvent rewrites in place, never throws, and leaves a current line untouched", () => {
  const cur = { ts: 1, type: "run_end" };
  assert.equal(normalizeLegacyEvent(cur), cur);
  assert.deepEqual(cur, { ts: 1, type: "run_end" });
  assert.doesNotThrow(() => normalizeLegacyEvent({ ts: 1, type: 5 }));
  assert.doesNotThrow(() => normalizeLegacyEvent({}));
});

test("parseEventLine, readEvents and readWindowEvents (live and archive) read an old line as the new name", () => {
  const repo = makeRepo();
  const file = eventsLogPath(repo);
  ensureParentDir(file);
  fs.writeFileSync(file, OLD + "\n");
  fs.writeFileSync(eventsArchivePath(repo), OLD.replace("harness", "other") + "\n");
  assert.equal(parseEventLine(OLD)?.type, "team_paused");
  assert.equal(readEvents(repo, 10)[0]?.type, "team_paused");
  const win = readWindowEvents(repo, dayKey(Date.now() - 86_400_000 * 400));
  assert.ok(win.events.length >= 2);
  assert.ok(win.events.every((e) => e.type === "team_paused"));
  assert.equal(parseEventLine(JSON.stringify({ ts: 1, type: "tick_end" }))?.type, "run_end"); // vocabulary-ok: legacy event name read from old logs
});

test("logEvent given an old type writes and notifies the new type", () => {
  const repo = makeRepo();
  const seen: string[] = [];
  const off = subscribeEvents((e) => seen.push(e.type));
  try {
    logEvent(repo, { loop: "harness", type: "fleet_resumed" } as unknown as HarnessEventInput); // vocabulary-ok: legacy event name read from old logs
  } finally {
    off();
  }
  assert.deepEqual(seen, ["team_resumed"]);
  assert.equal(JSON.parse(fs.readFileSync(eventsLogPath(repo), "utf8").trim()).type, "team_resumed");
});

test("logs --type matches an old line by either the old or the new name, and --json shows the new name", async () => {
  const repo = makeRepo();
  const file = eventsLogPath(repo);
  ensureParentDir(file);
  fs.writeFileSync(file, OLD + "\n");
  for (const name of ["fleet_paused", "team_paused"]) { // vocabulary-ok: legacy event name read from old logs
    const cap = captureStdout();
    try {
      await cmdLogs(repo, ["--type", name, "--json"]);
    } finally {
      cap.restore();
    }
    assert.match(cap.out(), /"type":"team_paused"/);
  }
});

test("normalizeLegacyEvent moves a tick field to run, and keeps an existing run", () => {
  const old = { type: "tick_end", tick: 4 }; // vocabulary-ok: legacy event name and field read from old logs
  assert.deepEqual(normalizeLegacyEvent(old), { type: "run_end", run: 4 });
  const both = { type: "run_end", tick: 1, run: 2 }; // vocabulary-ok: legacy field read from old logs
  assert.deepEqual(normalizeLegacyEvent(both), { type: "run_end", tick: 1, run: 2 }); // vocabulary-ok: legacy field read from old logs
});

test("normalizeLegacyEvent maps an old build_check scope and conflict_handback reason to merge", () => {
  const check = { type: "build_check", scope: "landing" }; // vocabulary-ok: legacy event value read from old logs
  assert.deepEqual(normalizeLegacyEvent(check), { type: "build_check", scope: "merge" });
  const handback = { type: "conflict_handback", reason: "landing" }; // vocabulary-ok: legacy event value read from old logs
  assert.deepEqual(normalizeLegacyEvent(handback), { type: "conflict_handback", reason: "merge" });
  const revision = { type: "conflict_handback", reason: "revision" };
  assert.deepEqual(normalizeLegacyEvent(revision), { type: "conflict_handback", reason: "revision" });
});

test("normalizeLegacyEvent renames the restart drain fields and keeps new ones", () => {
  const old = { type: "restart", drainedMs: 5, abortedTicks: 2, drainWindowMs: 9 }; // vocabulary-ok: legacy field names read from old logs
  assert.deepEqual(normalizeLegacyEvent(old), { type: "restart", finishedMs: 5, abortedRuns: 2, finishWindowMs: 9 });
  const current = { type: "restart", finishedMs: 1, abortedRuns: 0, finishWindowMs: 3 };
  assert.deepEqual(normalizeLegacyEvent({ ...current }), current);
});
