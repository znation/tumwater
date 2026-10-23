import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RetentionPruner, dueForPrune } from "../src/orchestrator/retention.js";
import { sessionsRootDir, toolOutputDir, eventsLogPath, opencodeDbPath, salvageDir, salvagePendingDir } from "../src/paths.js";
import { recordSession, sessionLedgerPath } from "../src/agent/session-ledger.js";
import { backdate } from "./helpers/backdate.js";
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
    /pruned 2 old salvaged workspace patch\(es\)/,
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
    /deleted 1 expired codex session\(s\)/,
  );
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
