import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RetentionPruner, dueForPrune } from "../src/orchestrator/retention.js";
import { maintenancePath, sessionPruneResumePath, sessionsRootDir, toolOutputDir, eventsLogPath, opencodeDbPath, salvageDir, salvagePendingDir } from "../src/paths.js";
import { recordSession, sessionLedgerPath } from "../src/agent/session-ledger.js";
import { backdate } from "./helpers/backdate.js";
import { patchFsMethod, errnoError } from "./helpers/fs-faults.js";
import { tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { record } from "./fakes/session-record.js";
import { writeScript } from "./fakes/fake-commands.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

/** Unit tests for src/orchestrator/retention.ts — the session-retention prune gate (moved here
 * from
 * test/scheduling.test.ts alongside its dueForPrune home) and the startup/poll state machine
 * the orchestrator now drives through a RetentionPruner instead of inline blocks. */

test("dueForPrune: the once-per-day gate with fake timestamps", () => {
  const day = 24 * 3600 * 1000;
  // Due when a full day has passed since the last prune.
  assert.equal(dueForPrune(1_000, 1_000 + day, 7), true);
  // Not due within a day — one millisecond short is still inside the window.
  assert.equal(dueForPrune(1_000, 1_000 + day - 1, 7), false);
  // Never due at retention 0, whether or not a prune has run before.
  assert.equal(dueForPrune(null, Number.MAX_SAFE_INTEGER, 0), false);
  assert.equal(dueForPrune(1_000, 1_000 + day * 2, 0), false);
  // Never pruned (null) → immediately due when retention is positive.
  assert.equal(dueForPrune(null, 1_000, 7), true);
});

/** An old-enough file that any positive window prunes it. */
function staleFile(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "x");
  backdate(file, 30 * 24 * 3600 * 1000);
  return file;
}

test("RetentionPruner: construction runs the startup prune at a positive window", () => {
  const root = tmpdir();
  const session = staleFile(sessionsRootDir(root), "session.jsonl");
  const toolOut = staleFile(toolOutputDir(root), "tool-out.txt");
  new RetentionPruner(root, 7);
  assert.equal(fs.existsSync(session), false);
  assert.equal(fs.existsSync(toolOut), false);
});

test("RetentionPruner: salvaged workspace patches past the window are pruned, waiting or kept", () => {
  const root = tmpdir();
  const kept = staleFile(salvageDir(root), "2026-09-01-000000-_slot-1-docs.patch");
  const waiting = staleFile(salvagePendingDir(root, "feature"), "2026-09-01-000000-_slot-2-feature.patch");
  const fresh = path.join(salvageDir(root), "2026-10-22-000000-_slot-3-docs.patch");
  fs.writeFileSync(fresh, "x");
  new RetentionPruner(root, 7);
  assert.equal(fs.existsSync(kept), false);
  assert.equal(fs.existsSync(waiting), false);
  assert.equal(fs.existsSync(fresh), true, "a patch inside the window stays");
  assert.match(
    eventsOfType(root, "warning").map((e) => String(e.message)).join("\n"),
    /pruned 2 old salvaged workspace patches/,
  );
});

test("RetentionPruner: retention 0 disables the startup prune", () => {
  const root = tmpdir();
  const session = staleFile(sessionsRootDir(root), "session.jsonl");
  new RetentionPruner(root, 0);
  assert.equal(fs.existsSync(session), true);
  assert.equal(eventsOfType(root, "retention_changed").length, 0);
});

test("RetentionPruner: poll re-prunes immediately on a window change and logs one event", () => {
  const root = tmpdir();
  const pruner = new RetentionPruner(root, 7);
  const session = staleFile(sessionsRootDir(root), "session.jsonl");
  // A window change prunes right away even inside the once-per-day window…
  pruner.poll(root, 1);
  assert.equal(fs.existsSync(session), false);
  // …and every distinct value change logs exactly one retention_changed event, even when
  // nothing was pruned.
  pruner.poll(root, 1);
  pruner.poll(root, 1);
  const changes = eventsOfType(root, "retention_changed");
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.from, 7);
  assert.equal(changes[0]?.to, 1);
});

test("RetentionPruner: a window change and a prune survive an unwritable events feed", () => {
  const root = tmpdir();
  // Put a directory where events.jsonl belongs: every logEvent under `root` throws EISDIR,
  // exactly as it would on a full disk or a feed path replaced by a directory.
  const feed = eventsLogPath(root);
  fs.rmSync(feed, { recursive: true, force: true });
  fs.mkdirSync(feed, { recursive: true });
  const pruner = new RetentionPruner(root, 0); // 0 disables pruning, so lastRetention is 0.
  const toolOut = staleFile(toolOutputDir(root), "tool-out.txt");
  // The window change logs retention_changed and then prunes; both writes are best-effort, so
  // the throw must not skip the prune itself.
  assert.doesNotThrow(() => pruner.poll(root, 7));
  assert.equal(fs.existsSync(toolOut), false);
});

test("RetentionPruner: an idle role's expired codex session is purged before its ledger ages out", () => {
  const root = tmpdir();
  const dir = path.join(sessionsRootDir(root), "feature");
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const id = "c7b3e2a1-0000-4000-8000-0000000000aa";
  recordSession(dir, record({ agent: "codex", id, at: now - 30 * day }));
  const ledger = sessionLedgerPath(dir);
  const oldTime = new Date(now - 30 * day);
  fs.utimesSync(ledger, oldTime, oldTime);

  // A team home of its own (backends.codex.configDir → CODEX_HOME), with the idle session's
  // rollout sitting in it — the file only the codex purge can reach.
  const home = tmpdir("codex-retention-home-");
  const rollout = path.join(home, "sessions", "2026", "09", "30", `rollout-2026-09-30T00-00-00-000-${id}.jsonl`);
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, "{}\n");
  writeConfig(root, { backends: { codex: { configDir: home } } });

  const bin = tmpdir("codex-retention-bin-");
  const capture = path.join(tmpdir("codex-retention-capture-"), "deleted.log");
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  writeScript(path.join(bin, "codex"), `printf '%s\\n' "$*" >> ${capture}`);
  process.env.TUMWATER_CODEX_BIN = path.join(bin, "codex");
  try {
    new RetentionPruner(root, 7);
  } finally {
    delete process.env.TUMWATER_CODEX_BIN;
  }
  const log = fs.existsSync(capture) ? fs.readFileSync(capture, "utf8") : "";
  assert.ok(log.includes(`delete --force ${id}`), `idle codex session purged: ${log}`);
  assert.equal(fs.existsSync(ledger), false, "the stale ledger itself is still aged out by the file pass");
  assert.match(
    eventsOfType(root, "warning").map((e) => String(e.message)).join("\n"),
    /deleted 1 expired codex session/,
  );
});

/** `n` distinct expired Codex ids, in the order the purge will handle them. */
function expiredCodexIds(n: number): { id: string; at: number }[] {
  const at = Date.now() - 30 * 24 * 3600 * 1000;
  return Array.from({ length: n }, (_, i) => ({
    id: `c7b3e2a1-0000-4000-8000-${String(i).padStart(12, "0")}`,
    at,
  }));
}

test("RetentionPruner: the prune pass publishes maintenance.json while it deletes and removes it after", () => {
  const root = tmpdir();
  const dir = path.join(sessionsRootDir(root), "feature");
  // Past the 25-id throttle, so a later delete must see a marker whose `done` has risen.
  const ids = expiredCodexIds(26);
  for (const { id, at } of ids) recordSession(dir, record({ agent: "codex", id, at }));

  // Each id has a rollout in the home, or the pass skips its delete as already gone.
  const home = tmpdir("codex-marker-home-");
  for (const { id } of ids) {
    const rollout = path.join(home, "sessions", "2026", "09", "30", `rollout-2026-09-30T00-00-00-000-${id}.jsonl`);
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(rollout, "{}\n");
  }
  writeConfig(root, { backends: { codex: { configDir: home } } });
  const bin = tmpdir("codex-marker-bin-");
  const marker = path.join(tmpdir("codex-marker-capture-"), "marker.log");
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  // The fake delete is the observer inside the blocked pass: it dumps the marker file (with
  // the pretty-printer's spaces and newlines stripped, so each line is one JSON object), or
  // MISSING when the marker it should be reading is not there.
  const markerFile = maintenancePath(root);
  writeScript(
    path.join(bin, "codex"),
    `if [ -f ${markerFile} ]; then tr -d ' \\n' < ${markerFile} >> ${marker}; printf '\\n' >> ${marker}; else printf 'MISSING\\n' >> ${marker}; fi`,
  );
  process.env.TUMWATER_CODEX_BIN = path.join(bin, "codex");
  try {
    new RetentionPruner(root, 7);
  } finally {
    delete process.env.TUMWATER_CODEX_BIN;
  }
  assert.equal(fs.existsSync(markerFile), false, "the marker is gone once the pass ends");

  const lines = fs.readFileSync(marker, "utf8").trim().split("\n");
  assert.equal(lines.length, 26, "one marker read per delete, none MISSING");
  const seen = lines.map((l) => JSON.parse(l) as { pid: number; task: string; backend: string; done: number; total: number });
  for (const m of seen) {
    assert.equal(m.pid, process.pid, "the marker names the orchestrator that wrote it");
    assert.equal(m.task, "session-prune");
    assert.equal(m.backend, "codex");
    assert.equal(m.total, 26, "total is known up front");
  }
  assert.equal(seen[0]?.done, 0, "the first delete sees a marker that has handled nothing yet");
  seen.forEach((m, j) => {
    // The marker never runs ahead of the pass (the id-throttle bounds how far behind it
    // lags), and it is never further behind than the throttle allows — widen the id bound
    // and this is what reports it. `j` deletes have happened when the delete after them
    // reads the marker, so a persisted `done` sits in [j - 24, j].
    assert.ok(m.done <= j, `marker read ${j} claims ${m.done} handled of ${j} so far`);
    assert.ok(m.done >= j - 24, `marker read ${j} lags to ${m.done} while ${j} are handled`);
  });
  assert.ok((seen[25]?.done ?? -1) > 0, "done rises during the pass, not only at its end");
});

test("RetentionPruner: a throw part-way through the pass still removes the marker", () => {
  const root = tmpdir();
  const dir = path.join(sessionsRootDir(root), "feature");
  recordSession(dir, record({ agent: "codex", id: "c7b3e2a1-0000-4000-8000-0000000000c1", at: Date.now() - 30 * 24 * 3600 * 1000 }));
  // Stand-in for a throw anywhere in the pass: the salvage pass' first existsSync is the one
  // call in it outside a try, so it propagates out of RetentionPruner.prune.
  const salvage = salvageDir(root);
  const undo = patchFsMethod("existsSync", (orig) => (p: unknown) => {
    if (String(p) === salvage) throw errnoError("EIO");
    return orig(p);
  });
  try {
    assert.throws(() => new RetentionPruner(root, 7));
  } finally {
    undo();
  }
  assert.equal(fs.existsSync(maintenancePath(root)), false, "the finally still removes the marker");
});

test("RetentionPruner: a prune with work logs one maintenance_start and one maintenance_done for that half, and a prune with none logs neither", () => {
  const root = tmpdir();
  const dir = path.join(sessionsRootDir(root), "feature");
  // No binary configured: the CLI delete is skipped but the half still has work to handle, so
  // the pair must still be logged — it explains the blocked loop, not the delete's outcome.
  recordSession(dir, record({ agent: "codex", id: "c7b3e2a1-0000-4000-8000-0000000000d1", at: Date.now() - 30 * 24 * 3600 * 1000 }));
  recordSession(dir, record({ agent: "codex", id: "c7b3e2a1-0000-4000-8000-0000000000d2", at: Date.now() - 30 * 24 * 3600 * 1000 }));
  new RetentionPruner(root, 7);

  const starts = eventsOfType(root, "maintenance_start");
  const dones = eventsOfType(root, "maintenance_done");
  assert.equal(starts.length, 1, "one start per half that had work");
  assert.equal(dones.length, 1, "one finish per half that had work");
  assert.equal(starts[0]?.task, "session-prune");
  assert.equal(starts[0]?.backend, "codex");
  assert.equal(starts[0]?.total, 2);
  assert.equal(dones[0]?.task, "session-prune");
  assert.equal(dones[0]?.backend, "codex");
  assert.equal(dones[0]?.done, 2, "done counts the ids the half handled");
  assert.ok(typeof dones[0]?.durationMs === "number" && (dones[0]?.durationMs as number) >= 0);

  // A pass with nothing past the window logs neither half of the pair.
  const quiet = tmpdir();
  recordSession(path.join(sessionsRootDir(quiet), "feature"), record({ agent: "codex", id: "c7b3e2a1-0000-4000-8000-0000000000d3" }));
  new RetentionPruner(quiet, 7);
  assert.equal(eventsOfType(quiet, "maintenance_start").length, 0);
  assert.equal(eventsOfType(quiet, "maintenance_done").length, 0);
});

test("RetentionPruner: an unavailable config never unlinks rollouts from the inherited CODEX_HOME", () => {
  const root = tmpdir();
  const dir = path.join(sessionsRootDir(root), "feature");
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const id = "c7b3e2a1-0000-4000-8000-0000000000bb";
  recordSession(dir, record({ agent: "codex", id, at: now - 30 * day }));
  const ledger = sessionLedgerPath(dir);
  const oldTime = new Date(now - 30 * day);
  fs.utimesSync(ledger, oldTime, oldTime);

  // A broken tumwater.json makes loadConfigSafe hand back { config: undefined }: no team
  // home and no binary are in view, so the purge must act on nothing — certainly not on the
  // operator's inherited CODEX_HOME that this test process carries.
  fs.writeFileSync(path.join(root, "tumwater.json"), "{ not json");
  const inheritedHome = tmpdir("codex-retention-inherited-");
  const inheritedRollout = path.join(inheritedHome, "sessions", "2026", "09", "30", `rollout-2026-09-30T00-00-00-000-${id}.jsonl`);
  fs.mkdirSync(path.dirname(inheritedRollout), { recursive: true });
  fs.writeFileSync(inheritedRollout, "{}\n");

  const bin = tmpdir("codex-retention-bin-");
  const capture = path.join(tmpdir("codex-retention-capture-"), "deleted.log");
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  writeScript(path.join(bin, "codex"), `printf '%s\\n' "$*" >> ${capture}`);
  process.env.TUMWATER_CODEX_BIN = path.join(bin, "codex");
  process.env.CODEX_HOME = inheritedHome;
  try {
    new RetentionPruner(root, 7);
  } finally {
    delete process.env.TUMWATER_CODEX_BIN;
    delete process.env.CODEX_HOME;
  }
  assert.equal(
    fs.existsSync(capture) ? fs.readFileSync(capture, "utf8") : "",
    "",
    "no codex delete without a resolvable config",
  );
  assert.ok(fs.existsSync(inheritedRollout), "the operator's inherited CODEX_HOME rollout is untouched");
});

test("RetentionPruner: an idle role's expired opencode session is purged before its ledger ages out", () => {
  const root = tmpdir();
  const dir = path.join(sessionsRootDir(root), "feature");
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  // A stale ledger: both the record and the file's own mtime are past the window, so
  // pruneOldFiles would delete the whole file — an idle role's ledger (its role not running,
  // so never re-touched) ages exactly like that. Its expired opencode session must STILL be
  // deleted from the shared OpenCode DB, which is only possible if the opencode purge reads
  // the ledger before the file pass removes it.
  recordSession(dir, record({ agent: "opencode", id: "ses-idle", at: now - 30 * day }));
  const ledger = sessionLedgerPath(dir);
  const oldTime = new Date(now - 30 * day);
  fs.utimesSync(ledger, oldTime, oldTime);

  const bin = tmpdir("opencode-retention-bin-");
  const capture = path.join(tmpdir("opencode-retention-capture-"), "deleted.log");
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  writeScript(path.join(bin, "opencode"), `printf '%s\\n' "$*" >> ${capture}`);
  process.env.TUMWATER_OPENCODE_BIN = path.join(bin, "opencode");
  try {
    new RetentionPruner(root, 7);
  } finally {
    delete process.env.TUMWATER_OPENCODE_BIN;
  }
  const log = fs.existsSync(capture) ? fs.readFileSync(capture, "utf8") : "";
  assert.ok(log.includes("session delete ses-idle --standalone"), `idle opencode session purged: ${log}`);
  assert.equal(fs.existsSync(ledger), false, "the stale ledger itself is still aged out by the file pass");
});

test("RetentionPruner: an OpenCode DB dir that cannot be created skips the session deletes and still prunes the rest", () => {
  const root = tmpdir();
  // A regular file where the DB's directory belongs: the mkdir throws EEXIST.
  const dbDir = path.dirname(opencodeDbPath(root));
  writeFileDeep(dbDir, "x");
  const toolOut = staleFile(toolOutputDir(root), "tool-out.txt");
  const day = 24 * 3600 * 1000;
  recordSession(
    path.join(sessionsRootDir(root), "feature"),
    record({ agent: "opencode", id: "ses-blocked", at: Date.now() - 30 * day }),
  );
  const bin = tmpdir("opencode-retention-bin-");
  const capture = path.join(tmpdir("opencode-retention-capture-"), "deleted.log");
  writeScript(path.join(bin, "opencode"), `printf '%s\\n' "$*" >> ${capture}`);
  process.env.TUMWATER_OPENCODE_BIN = path.join(bin, "opencode");
  try {
    assert.doesNotThrow(() => new RetentionPruner(root, 7));
    assert.equal(fs.existsSync(toolOut), false);
    assert.equal(fs.existsSync(capture), false, "no session delete was attempted");
    const again = staleFile(toolOutputDir(root), "tool-out-2.txt");
    const pruner = new RetentionPruner(root, 0);
    assert.doesNotThrow(() => pruner.poll(root, 7));
    assert.equal(fs.existsSync(again), false);
    assert.equal(fs.existsSync(capture), false, "no session delete was attempted by poll");
  } finally {
    delete process.env.TUMWATER_OPENCODE_BIN;
  }
});

test("RetentionPruner: a codex id an interrupted pass already handled is not deleted again, and the resume record is cleared", () => {
  const root = tmpdir();
  const dir = path.join(sessionsRootDir(root), "feature");
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const id = "c7b3e2a1-0000-4000-8000-0000000000ad";
  recordSession(dir, record({ agent: "codex", id, at: now - 30 * day }));

  // The id has a rollout in the team home, so only the resume record keeps codex from being
  // handed it.
  const home = tmpdir("codex-resume-home-");
  const rollout = path.join(home, "sessions", "2026", "09", "30", `rollout-2026-09-30T00-00-00-000-${id}.jsonl`);
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, "{}\n");
  writeConfig(root, { backends: { codex: { configDir: home } } });
  const resume = sessionPruneResumePath(root, "codex");
  fs.mkdirSync(path.dirname(resume), { recursive: true });
  fs.writeFileSync(resume, `${id}\n`);

  const bin = tmpdir("codex-resume-bin-");
  const capture = path.join(tmpdir("codex-resume-capture-"), "deleted.log");
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  writeScript(path.join(bin, "codex"), `printf '%s\\n' "$*" >> ${capture}`);
  process.env.TUMWATER_CODEX_BIN = path.join(bin, "codex");
  try {
    new RetentionPruner(root, 7);
  } finally {
    delete process.env.TUMWATER_CODEX_BIN;
  }
  const log = fs.existsSync(capture) ? fs.readFileSync(capture, "utf8") : "";
  assert.equal(log.includes(id), false, `an id the record lists is not deleted again: ${log}`);
  assert.equal(fs.existsSync(resume), false, "the resume record is cleared once the ledger lines are trimmed");
});
