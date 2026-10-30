import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkOrphans, findOrphans, killOrphans, markRootToken, orphanFailDetail, orphanKillLines, parseEtimeMs, reapAttributableOrphans, reapPreviousTeamOrphans, rootToken, type OrphanSignals } from "../src/doctor/doctor-orphans.js";
import { dueForOrphanReap, newPollState, ORPHAN_REAP_INTERVAL_MS } from "../src/orchestrator/orchestrator-poll.js";
import { runDoctor } from "../src/doctor/doctor.js";
import type { ProcessProbe } from "../src/process/process-table.js";
import { readEvents } from "../src/events/event-read.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { fakeBins, fakeProbe, noProcesses, readyRepo } from "./fixtures/doctor-fixtures.js";

// Unit coverage for the orphaned-worktree-process check (src/doctor/doctor-orphans.ts): every leak
// shape below is a real leak the team produced, driven through a fake process table — no
// orphan is ever spawned. The real ps/lsof reader is smoked in test/process.test.ts; the
// other doctor checks' unit coverage lives in test/doctor-checks.test.ts and
// test/doctor-model-checks.test.ts.

test("checkOrphans flags each leak shape by argv or cwd, naming pid, age, CPU, tree and command", async () => {
  const root = readyRepo();
  const real = fs.realpathSync(root); // What lsof and /proc report (macOS: /private/var/…).
  for (const wt of ["qa", "bugfix"]) fs.mkdirSync(path.join(root, ".tumwater", "worktrees", wt), { recursive: true });
  const { probe, asked } = fakeProbe(
    [
      // The stray orchestrator an orphaned suite started (2026-09-21): an absolute worktree argv.
      { pid: 8198, etime: "18:34:12", time: "0:41.20", command: `node ${root}/.tumwater/worktrees/perf/dist/src/cli.js run` },
      // The leaked build-check runner: no worktree in its argv at all, only in its cwd — and its
      // `node --test` workers still have it as their parent.
      { pid: 88052, etime: "2-21:44:01", time: "0:03.12", command: "node dist/test/test-runner.js" },
      { pid: 88160, ppid: 88052, command: "node --test a.test.js" },
      { pid: 95649, ppid: 88160, time: "4:44.00", command: "node a.test.js" },
      // The qa GUI (2026-09-23): a relative worktree argv, its cwd a scratch dir since deleted.
      {
        pid: 73241,
        etime: "07:24:10",
        time: "0:02.50",
        command: "node .tumwater/worktrees/qa/dist/src/cli.js gui --port 41602 --all-interfaces",
      },
    ],
    { 88052: path.join(real, ".tumwater", "worktrees", "bugfix"), 73241: path.join(real, "..", "tumwater-qa.gone") },
  );
  assert.deepEqual(await checkOrphans(root, probe), {
    level: "fail",
    detail:
      "3 orphaned processes (PPID 1): " +
      "pid 8198 (age 18:34:12, cpu 0:41.20) node .tumwater/worktrees/perf/dist/src/cli.js run; " +
      "pid 88052 (age 2-21:44:01, cpu 0:03.12, +2 descendants) node dist/test/test-runner.js; " +
      "pid 73241 (age 07:24:10, cpu 0:02.50) node .tumwater/worktrees/qa/dist/src/cli.js gui --port 41602 --all-interfaces" +
      " — nothing reaps these; `tumwater doctor --kill-orphans` (or the dashboard Health card's Kill orphans, or the TUI Health tab's Ctrl+K pressed twice) kills each with its descendants",
  });
  // One cwd lookup, over the parentless processes argv did not already settle — never the
  // workers (they have a parent) and never the absolute-argv match.
  assert.deepEqual(asked, [[88052, 73241]]);
});

test("checkOrphans leaves the live team and other checkouts' orphans alone", async () => {
  const root = readyRepo();
  fs.mkdirSync(path.join(root, ".tumwater", "worktrees", "qa"), { recursive: true });
  const other = tmpdir("doctor-other-checkout-");
  fs.mkdirSync(path.join(other, ".tumwater", "worktrees", "qa"), { recursive: true });
  const { probe } = fakeProbe(
    [
      // A nohup'd supervisor is parentless too — but it, and the orchestrator it spawns, run
      // from the repo root, never from a worktree.
      { pid: 500, command: "node dist/src/cli.js run" },
      { pid: 501, ppid: 500, command: `node ${root}/dist/src/cli.js run` },
      // The orchestrator's pi run and its tool calls live in worktrees, but have real parents.
      { pid: 502, ppid: 501, command: "pi --mode json -p go" },
      { pid: 503, ppid: 502, command: `node ${root}/.tumwater/worktrees/qa/dist/src/cli.js gui --port 41601` },
      // Another checkout's orphans: an absolute argv there, and a relative one whose cwd
      // resolves into that checkout's worktree — though this repo has a `qa` worktree too.
      { pid: 600, command: `node ${other}/.tumwater/worktrees/qa/dist/src/cli.js gui` },
      { pid: 601, command: "node .tumwater/worktrees/qa/dist/src/cli.js gui" },
      // A path that merely ends in this checkout's (a copy nested elsewhere) is not this one.
      { pid: 602, command: `node /mirror${root}/.tumwater/worktrees/qa/dist/src/cli.js gui` },
      // A relative worktree argv with no cwd to confirm it, naming a worktree this repo lacks.
      { pid: 603, command: "node .tumwater/worktrees/nosuch/dist/src/cli.js gui" },
      // Everything else a host runs parentless.
      { pid: 700, command: "/usr/libexec/logd" },
    ],
    { 500: root, 601: other, 700: "/" },
  );
  assert.deepEqual(await checkOrphans(root, probe), {
    level: "ok",
    detail: "none — no process reparented to PID 1 runs from .tumwater/worktrees/ or carries only dead runs' marks",
  });
});

test("checkOrphans catches a marked leak outside the worktrees once its harness is gone", async () => {
  const root = readyRepo();
  const dead = 999_999_999; // No live pid is this large on either platform.
  const { probe } = fakeProbe(
    [
      // The straggler a sweep missed (BUGS.md 2026-09-30, part 2/2): it lives in a scratch
      // dir the prompts send agents to — its argv and cwd name no worktree at all.
      { pid: 3100, etime: "11:22:33", time: "1:02.30", command: "node /tmp/twprobe/server.js" },
    ],
    { 3100: "/tmp/twprobe" },
    { 3100: `${dead}-deadbeef` },
  );
  assert.deepEqual(await checkOrphans(root, probe), {
    level: "fail",
    detail:
      "1 orphaned process (PPID 1): " +
      `pid 3100 (age 11:22:33, cpu 1:02.30) node /tmp/twprobe/server.js (run ${dead}-deadbeef; tumwater ${dead} exited)` +
      " — nothing reaps these; `tumwater doctor --kill-orphans` (or the dashboard Health card's Kill orphans, or the TUI Health tab's Ctrl+K pressed twice) kills each with its descendants",
  });
});

test("checkOrphans leaves a dead-marked scratch-dir orphan whose run mark names another root alone", async () => {
  const root = readyRepo();
  const foreign = tmpdir("doctor-foreign-root-");
  fs.mkdirSync(path.join(foreign, ".tumwater"), { recursive: true });
  const dead = 999_999_996;
  const deadRootless = 999_999_995;
  const { probe } = fakeProbe(
    [
      // Another checkout's dead-marked scratch-dir writer: its mark carries that root's token, so
      // this repo's scan must not claim it (and the automatic reap, built on this set, must never
      // signal it).
      { pid: 3500, etime: "11:22:33", time: "1:02.30", command: "node /tmp/twforeign/server.js" },
      // A rootless dead mark still reports as before (BUGS.md, part 1/3): whatever started it,
      // nothing else will reap it.
      { pid: 3501, etime: "11:22:33", time: "1:02.30", command: "node /tmp/twrootless/server.js" },
    ],
    {},
    { 3500: `${dead}-beeff00d-${rootToken(foreign)}`, 3501: `${deadRootless}-cafe` },
  );
  const r = await checkOrphans(root, probe);
  assert.equal(r.level, "fail");
  assert.match(r.detail, /pid 3501 /, "the rootless dead mark is still this repo's orphan");
  assert.doesNotMatch(r.detail, /pid 3500 /, "the foreign-root-token mark is not this repo's orphan");
  assert.equal(markRootToken(`${dead}-beeff00d-${rootToken(foreign)}`), rootToken(foreign), "a rooted mark reads back its token");
  assert.equal(markRootToken(`${deadRootless}-cafe`), null, "a two-segment mark is rootless");
});

test("checkOrphans still reports a dead-marked scratch-dir orphan whose run mark names this root", async () => {
  const root = readyRepo();
  const dead = 999_999_994;
  const { probe } = fakeProbe(
    [{ pid: 3600, etime: "11:22:33", time: "1:02.30", command: "node /tmp/twprobe/server.js" }],
    {},
    { 3600: `${dead}-beef-${rootToken(root)}` },
  );
  const r = await checkOrphans(root, probe);
  assert.equal(r.level, "fail");
  assert.match(r.detail, /^1 orphaned process \(PPID 1\): pid 3600 /, "a dead mark token-matching this root is still reported");
});


test("checkOrphans leaves a marked straggler whose harness is alive — that run's sweep will reap it", async () => {
  const root = readyRepo();
  const live = process.pid; // This test process is alive by definition.
  const { probe } = fakeProbe(
    [
      { pid: 3200, command: "node /tmp/twprobe/server.js" },
      // A nested-run straggler: the outer harness died, but the inner one is alive and its
      // sweep kills everything carrying the inner mark when its run folds.
      { pid: 3201, command: `node ${root}/dist/src/cli.js run` },
      // A mark without a `<pid>-` prefix judges nothing — a torn or foreign value is not
      // evidence of a dead harness.
      { pid: 3202, command: "sleep 100" },
    ],
    {},
    { 3200: `${live}-aaaa`, 3201: `999999998-gone,${live}-bbbb`, 3202: "garbage" },
  );
  assert.deepEqual(await checkOrphans(root, probe), {
    level: "ok",
    detail: "none — no process reparented to PID 1 runs from .tumwater/worktrees/ or carries only dead runs' marks",
  });
});

test("checkOrphans counts a marked orphan once even when its cwd also matches, and one dead-and-alive mark set is not an orphan", async () => {
  const root = readyRepo();
  fs.mkdirSync(path.join(root, ".tumwater", "worktrees", "qa"), { recursive: true });
  const wt = path.join(fs.realpathSync(root), ".tumwater", "worktrees", "qa");
  const dead = 999_999_997;
  const { probe, asked } = fakeProbe(
    [
      // Argv matches AND the mark is dead: counted once, and no cwd lookup is needed for it.
      { pid: 3300, command: `node ${root}/.tumwater/worktrees/qa/dist/src/cli.js gui` },
    ],
    { 3300: wt },
    { 3300: `${dead}-cc` },
  );
  const r = await checkOrphans(root, probe);
  assert.equal(r.level, "fail");
  assert.match(r.detail, /^1 orphaned process \(PPID 1\): pid 3300/);
  assert.deepEqual(asked, []);
});

test("checkOrphans asks cwds only of parentless processes this user can inspect", async (t) => {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) {
    t.skip("root (or no uids): every process is inspectable, so there is nothing to filter");
    return;
  }
  const root = readyRepo();
  const wt = path.join(fs.realpathSync(root), ".tumwater", "worktrees", "bugfix");
  const { probe, asked } = fakeProbe(
    [
      { pid: 10, command: "node dist/test/test-runner.js" },
      // Another user's process: lsof and /proc cannot read its cwd, so it is never asked.
      { pid: 11, uid: uid + 1, command: "node dist/test/test-runner.js" },
      { pid: 12, ppid: 10, command: "node --test a.test.js" },
    ],
    { 10: wt, 11: wt, 12: wt },
  );
  assert.deepEqual(await checkOrphans(root, probe), {
    level: "fail",
    detail:
      "1 orphaned process (PPID 1): pid 10 (age 01:00, cpu 0:00.10, +1 descendant) node dist/test/test-runner.js" +
      " — nothing reaps these; `tumwater doctor --kill-orphans` (or the dashboard Health card's Kill orphans, or the TUI Health tab's Ctrl+K pressed twice) kills each with its descendants",
  });
  assert.deepEqual(asked, [[10]]);
});

test("checkOrphans degrades instead of crashing doctor: no table warns, unreadable cwds fall back to argv", async () => {
  const root = readyRepo();
  const noPs: ProcessProbe = {
    list: async () => {
      throw new Error("spawn ps ENOENT");
    },
    cwds: async () => new Map(),
    runMarkers: async () => new Map(),
    launchServicesPorts: async () => null,
  };
  assert.deepEqual(await checkOrphans(root, noPs), {
    level: "warn",
    detail: "could not scan the process table — spawn ps ENOENT",
  });

  const noLsof = (rows: Parameters<typeof fakeProbe>[0]): ProcessProbe => ({
    ...fakeProbe(rows).probe,
    cwds: async () => {
      throw new Error("spawn lsof ENOENT");
    },
  });
  // Nothing named in argv, but the scan was partial: a warn, never a false all-clear.
  const partial = await checkOrphans(root, noLsof([{ pid: 20, command: "node dist/test/test-runner.js" }]));
  assert.equal(partial.level, "warn");
  assert.match(partial.detail, /^none named in argv, but process cwds are unreadable \(spawn lsof ENOENT\)/);
  // An argv match still fails the check, and says the cwd half did not run.
  const found = await checkOrphans(
    root,
    noLsof([
      { pid: 20, command: "node dist/test/test-runner.js" },
      { pid: 21, command: `node ${root}/.tumwater/worktrees/qa/dist/src/cli.js gui` },
    ]),
  );
  assert.equal(found.level, "fail");
  assert.match(found.detail, /^1 orphaned process \(PPID 1\): pid 21 /);
  assert.match(found.detail, /\(process cwds unreadable — spawn lsof ENOENT; argv matched only\)$/);
});

test("checkOrphans itemizes at most eight orphans and trims each command, keeping the full count", async () => {
  const root = readyRepo();
  const wt = path.join(fs.realpathSync(root), ".tumwater", "worktrees", "_slot-1");
  const long = `node ${root}/.tumwater/worktrees/_slot-1/dist/src/cli.js run --note ${"a".repeat(100)}`;
  const rows = Array.from({ length: 10 }, (_, i) => ({ pid: 45355 + i, command: i === 0 ? long : "perl -e while(1){}" }));
  const { probe } = fakeProbe(rows, Object.fromEntries(rows.map((r) => [r.pid, wt])));
  const r = await checkOrphans(root, probe);
  assert.equal(r.level, "fail");
  assert.match(r.detail, /^10 orphaned processes \(PPID 1\): /);
  assert.equal(r.detail.match(/pid \d+ \(age/g)?.length, 8);
  assert.match(r.detail, /; and 2 more — nothing reaps these/);
  // The root is cut first, then the command is trimmed to 80 characters with an ellipsis.
  const shown = `node .tumwater/worktrees/_slot-1/dist/src/cli.js run --note ${"a".repeat(100)}`.slice(0, 79);
  assert.ok(r.detail.includes(`) ${shown}…; pid 45356 `), r.detail);
});

test("checkOrphans matches orphans through a root spelled as a symlink, alive or dangling", async () => {
  const root = readyRepo();
  const real = fs.realpathSync(root);
  const dir = tmpdir("doctor-root-link-");

  // A root whose path cannot be resolved — the repo removed under doctor's feet, or a
  // broken symlink — must degrade to the spelling given, not crash the check, and an
  // orphan argv naming that spelling must still be blamed on this repo.
  const dangling = path.join(dir, "dangling");
  fs.symlinkSync(path.join(root, "gone"), dangling);
  assert.equal((await checkOrphans(dangling, noProcesses)).level, "ok", "an unresolvable root never crashes the check");
  const { probe } = fakeProbe([
    { pid: 700, command: `node ${dangling}/.tumwater/worktrees/qa/dist/src/cli.js gui` },
  ]);
  const given = await checkOrphans(dangling, probe);
  assert.equal(given.level, "fail", "an orphan naming the given spelling is still this repo's");
  assert.match(given.detail, /^1 orphaned process \(PPID 1\): pid 700 \(age 01:00, cpu 0:00\.10\) node \.tumwater\/worktrees\/qa\/dist\/src\/cli\.js gui/);

  // A root given through a live symlink must also match orphans spelled with the RESOLVED
  // path — lsof and /proc report a resolved cwd, and macOS's /var is /private/var — and the
  // listed command is cut at the longest spelling, the resolved one.
  const link = path.join(dir, "live");
  fs.symlinkSync(root, link);
  const { probe: resolvedProbe } = fakeProbe([
    { pid: 701, command: `node ${real}/.tumwater/worktrees/qa/dist/src/cli.js gui` },
  ]);
  const through = await checkOrphans(link, resolvedProbe);
  assert.equal(through.level, "fail", "an orphan naming the resolved spelling is still this repo's");
  assert.match(through.detail, /^1 orphaned process \(PPID 1\): pid 701 \(age 01:00, cpu 0:00\.10\) node \.tumwater\/worktrees\/qa\/dist\/src\/cli\.js gui/);
});

test("runDoctor fails the verdict on an orphan — the exit code a scripted doctor keys off", async () => {
  const root = readyRepo();
  const { probe } = fakeProbe([{ pid: 8198, command: `node ${root}/.tumwater/worktrees/perf/dist/src/cli.js run` }]);
  const report = await runDoctor(root, fakeBins("git", "pi"), probe);
  assert.equal(report.checks.find((c) => c.name === "orphans")?.level, "fail");
  assert.equal(report.verdict, "1 problem");
});

/** Fake signals that record every (pid, signal), with `stubborn` pids staying alive until
 * SIGKILL and every other pid gone once it has been sent SIGTERM. */
function fakeSignals(opts: { stubborn?: number[]; throwing?: Record<number, string> } = {}): {
  signals: OrphanSignals;
  sent: [number, string][];
} {
  const sent: [number, string][] = [];
  const termed = new Set<number>();
  const signals: OrphanSignals = {
    kill(pid, signal) {
      sent.push([pid, signal]);
      const code = opts.throwing?.[pid];
      if (code === "ESRCH") termed.add(pid); // Already gone.
      if (code !== undefined) throw Object.assign(new Error("not permitted"), { code });
      if (signal === "SIGTERM") termed.add(pid);
      else termed.add(-pid);
    },
    alive: (pid) => !termed.has(-pid) && (opts.stubborn?.includes(pid) === true || !termed.has(pid)),
    graceMs: 20,
    pollMs: 5,
  };
  return { signals, sent };
}

test("killOrphans terms each orphan's tree, kills what outlives the grace, and touches nothing else", async () => {
  const root = readyRepo();
  const real = fs.realpathSync(root);
  const other = tmpdir("doctor-other-checkout-");
  fs.mkdirSync(path.join(root, ".tumwater", "worktrees", "qa"), { recursive: true });
  fs.mkdirSync(path.join(root, ".tumwater", "worktrees", "bugfix"), { recursive: true });
  const { probe } = fakeProbe(
    [
      { pid: 8198, command: `node ${root}/.tumwater/worktrees/perf/dist/src/cli.js run` },
      { pid: 88052, command: "node dist/test/test-runner.js" },
      { pid: 88160, ppid: 88052, command: "node --test a.test.js" },
      { pid: 95649, ppid: 88160, command: "node a.test.js" },
      { pid: 73241, command: "node .tumwater/worktrees/qa/dist/src/cli.js gui --port 41602" },
      { pid: 500, ppid: 501, command: "pi --mode json -p go" },
      { pid: 600, command: `node ${other}/.tumwater/worktrees/qa/dist/src/cli.js gui` },
    ],
    { 88052: path.join(real, ".tumwater", "worktrees", "bugfix"), 73241: path.join(real, "..", "tumwater-qa.gone"), 600: other },
  );
  const { signals, sent } = fakeSignals({ stubborn: [95649] });
  const report = await killOrphans(root, probe, signals);
  assert.deepEqual(sent.filter(([, s]) => s === "SIGTERM").map(([p]) => p).sort((a, b) => a - b), [8198, 73241, 88052, 88160, 95649]);
  assert.deepEqual(sent.filter(([, s]) => s === "SIGKILL"), [[95649, "SIGKILL"]]);
  assert.deepEqual(report, {
    killed: [
      { pid: 8198, command: "node .tumwater/worktrees/perf/dist/src/cli.js run", descendants: 0 },
      { pid: 88052, command: "node dist/test/test-runner.js", descendants: 2 },
      { pid: 73241, command: "node .tumwater/worktrees/qa/dist/src/cli.js gui --port 41602", descendants: 0 },
    ],
    failed: [],
  });
});

test("killOrphans reports a refused signal and an unreadable table", async () => {
  const root = readyRepo();
  const { probe } = fakeProbe([
    { pid: 3001, command: `node ${root}/.tumwater/worktrees/a/x.js` },
    { pid: 3002, command: `node ${root}/.tumwater/worktrees/b/x.js` },
    { pid: 3003, command: `node ${root}/.tumwater/worktrees/c/x.js` },
  ]);
  const { signals, sent } = fakeSignals({ throwing: { 3001: "EPERM", 3002: "ESRCH" } });
  const report = await killOrphans(root, probe, signals);
  assert.ok("killed" in report);
  assert.deepEqual(report.failed, [{ pid: 3001, reason: "not permitted" }]);
  assert.deepEqual(report.killed.map((k) => k.pid), [3002, 3003]);
  assert.deepEqual(sent.map(([p]) => p), [3001, 3002, 3003]);

  const broken: ProcessProbe = { ...probe, list: async () => { throw new Error("ps missing"); } };
  const none = fakeSignals();
  assert.deepEqual(await killOrphans(root, broken, none.signals), { error: "ps missing" });
  assert.deepEqual(none.sent, []);
});

test("reapPreviousTeamOrphans kills only the dead previous harness's marked orphans and logs what it killed", async () => {
  const root = readyRepo();
  const dead = 999_999_999;
  fs.mkdirSync(path.join(root, ".tumwater", "worktrees", "qa"), { recursive: true });
  const { probe } = fakeProbe(
    [
      { pid: 3100, command: "node /tmp/twprobe/server.js" },
      { pid: 3101, ppid: 3100, command: "node child.js" },
      { pid: 3200, command: "node /tmp/other.js" },
      { pid: 3300, command: "node /tmp/shared.js" },
      { pid: 3400, command: "node unmarked.js" },
    ],
    { 3400: path.join(fs.realpathSync(root), ".tumwater", "worktrees", "qa") },
    { 3100: `${dead}-aa`, 3200: "999999998-bb", 3300: `${dead}-cc,${process.pid}-dd` },
  );
  const { signals, sent } = fakeSignals();
  assert.equal(await reapPreviousTeamOrphans(root, dead, probe, signals), 1);
  assert.deepEqual(sent.filter(([, s]) => s === "SIGTERM").map(([p]) => p).sort((a, b) => a - b), [3100, 3101]);
  const warnings = readEvents(root).filter((e) => e.type === "warning");
  assert.equal(warnings.length, 1);
  assert.match(
    String((warnings[0] as { message?: string }).message),
    /^killed 1 orphaned process left by tumwater 999999999's runs at team start: pid 3100 \(\+1 descendant\) node \/tmp\/twprobe\/server\.js/,
  );
});

test("reapPreviousTeamOrphans scans nothing while the previous harness is alive", async () => {
  const root = readyRepo();
  let listed = 0;
  const { probe } = fakeProbe([{ pid: 3100, command: "node x.js" }], {}, { 3100: `${process.pid}-aa` });
  const counting: ProcessProbe = { ...probe, list: async () => { listed++; return probe.list(); } };
  const { signals, sent } = fakeSignals();
  assert.equal(await reapPreviousTeamOrphans(root, process.pid, counting, signals), 0);
  assert.equal(listed, 0);
  assert.deepEqual(sent, []);
});

test("reapPreviousTeamOrphans returns 0 and logs nothing on an unreadable table or no match", async () => {
  const root = readyRepo();
  const dead = 999_999_999;
  const { probe } = fakeProbe([{ pid: 3100, command: "node x.js" }], {}, { 3100: "999999998-aa" });
  const broken: ProcessProbe = { ...probe, list: async () => { throw new Error("ps missing"); } };
  const { signals, sent } = fakeSignals();
  assert.equal(await reapPreviousTeamOrphans(root, dead, broken, signals), 0);
  assert.equal(await reapPreviousTeamOrphans(root, dead, probe, signals), 0);
  assert.deepEqual(sent, []);
  assert.deepEqual(readEvents(root).filter((e) => e.type === "warning"), []);
});

test("orphanKillLines words a kill, a refusal, an empty report and an unreadable table", () => {
  assert.deepEqual(
    orphanKillLines({ killed: [{ pid: 7, command: "node a", descendants: 2 }, { pid: 8, command: "node b", descendants: 0 }], failed: [{ pid: 9, reason: "EPERM" }] }),
    ["killed pid 7 (+2 descendants) node a", "killed pid 8 node b", "could not kill pid 9: EPERM"],
  );
  assert.deepEqual(orphanKillLines({ killed: [], failed: [] }), ["no orphaned processes to kill"]);
  assert.deepEqual(orphanKillLines({ error: "ps: not found" }), ["could not scan the process table — ps: not found; nothing killed"]);
});

test("parseEtimeMs reads ps's elapse shapes and reads unparseable or out-of-range strings as 0", () => {
  assert.equal(parseEtimeMs("01:00"), 60_000); // MM:SS
  assert.equal(parseEtimeMs("01:30:00"), 5_400_000); // HH:MM:SS
  assert.equal(parseEtimeMs("2-21:44:01"), 251_041_000); // D-HH:MM:SS
  assert.equal(parseEtimeMs("00:59"), 59_000);
  // Junk, a bare seconds, and out-of-range minutes/seconds never reap (read 0).
  assert.equal(parseEtimeMs(""), 0);
  assert.equal(parseEtimeMs("banana"), 0);
  assert.equal(parseEtimeMs("59"), 0);
  assert.equal(parseEtimeMs("00:61:00"), 0);
  assert.equal(parseEtimeMs("1:00:61"), 0);
});

test("reapAttributableOrphans kills only orphans old enough, logging one warning for what it reaped", async () => {
  const root = readyRepo();
  fs.mkdirSync(path.join(root, ".tumwater", "worktrees", "qa"), { recursive: true });
  const wt = path.join(fs.realpathSync(root), ".tumwater", "worktrees", "qa");
  const { probe } = fakeProbe(
    [
      // An old orphan (1 h, past the 10-minute minimum) with a descendant to take down.
      { pid: 9100, etime: "01:00:00", command: `node ${root}/.tumwater/worktrees/qa/x.js` },
      { pid: 9101, ppid: 9100, command: "node child.js" },
      // A young orphan (the 01:00 fake default, well under the minimum): left alone.
      { pid: 9200, command: "node .tumwater/worktrees/qa/y.js" },
      // A non-orphan: parentless but not this repo's, left alone.
      { pid: 9300, command: "/usr/libexec/logd" },
    ],
    { 9200: wt, 9300: "/" },
  );
  const { signals, sent } = fakeSignals();
  assert.equal(await reapAttributableOrphans(root, probe, signals), 1);
  assert.deepEqual(sent.filter(([, s]) => s === "SIGTERM").map(([p]) => p).sort((a, b) => a - b), [9100, 9101]);
  const warnings = readEvents(root).filter((e) => e.type === "warning");
  assert.equal(warnings.length, 1);
  assert.match(
    String((warnings[0] as { message?: string }).message),
    /^reaped 1 orphaned process: pid 9100 \(\+1 descendant\) node \.tumwater\/worktrees\/qa\/x\.js/,
  );
});

test("reapAttributableOrphans returns 0 and logs nothing on an unreadable table or no old-enough orphan", async () => {
  const root = readyRepo();
  fs.mkdirSync(path.join(root, ".tumwater", "worktrees", "qa"), { recursive: true });
  const wt = path.join(fs.realpathSync(root), ".tumwater", "worktrees", "qa");
  // All young: every orphan is under the minimum age, nothing reaped, nothing logged.
  const { probe } = fakeProbe([{ pid: 9100, command: `node ${root}/.tumwater/worktrees/qa/x.js` }], { 9100: wt });
  const { signals, sent } = fakeSignals();
  assert.equal(await reapAttributableOrphans(root, probe, signals), 0);
  assert.deepEqual(sent, []);
  assert.deepEqual(readEvents(root).filter((e) => e.type === "warning"), []);

  // An unreadable table: 0, nothing logged, nothing signalled.
  const broken: ProcessProbe = { ...probe, list: async () => { throw new Error("ps missing"); } };
  const { signals: brokenSignals, sent: brokenSent } = fakeSignals();
  assert.equal(await reapAttributableOrphans(root, broken, brokenSignals), 0);
  assert.deepEqual(brokenSent, []);
  assert.deepEqual(readEvents(root).filter((e) => e.type === "warning"), []);
});

test("spares a parentless tree whose descendant carries a live run's mark (ci run 62), reap and alert alike", async () => {
  const root = readyRepo();
  fs.mkdirSync(path.join(root, ".tumwater", "worktrees", "_slot-7"), { recursive: true });
  const wt = path.join(fs.realpathSync(root), ".tumwater", "worktrees", "_slot-7");
  const live = process.pid;
  // A tool call's `( … ) &` subshell: reparented to PID 1, its argv names the worktree, and
  // macOS hides /bin/bash's own environment — so this root's mark is unreadable — while its
  // node child (npm test) carries the run's LIVE mark.
  const probe = fakeProbe(
    [
      { pid: 99726, etime: "01:00:00", command: `cd ${root}/.tumwater/worktrees/_slot-7 && SCR=$(mktemp -d) && (npm test > \"$SCR/out\" 2>&1) & echo $!` },
      { pid: 99727, ppid: 99726, etime: "01:00:00", command: "node dist/test/test-runner.js" },
      // A genuinely dead leak with no live descendant: still an orphan that gets reaped.
      { pid: 99800, etime: "01:00:00", command: `node ${root}/.tumwater/worktrees/_slot-7/stray.js` },
    ],
    { 99726: wt },
    { 99727: `${live}-aaaa` },
  ).probe;
  const scan = await findOrphans(root, probe);
  assert.ok("rows" in scan, "scan succeeded");
  assert.deepEqual(scan.orphans.map((r) => r.pid), [99800], "the live run's tree is left out of the orphan set");
  assert.deepEqual(scan.liveOwned.map((r) => r.pid), [99726], "the live tree is reported as live-owned");
  const signals = fakeSignals().signals;
  assert.equal(await reapAttributableOrphans(root, probe, signals), 1, "reaps only the dead leak");
  const events = readEvents(root).filter((e) => e.type === "warning");
  assert.match(String((events[0] as { message?: string }).message), /reaped 1 orphaned process: pid 99800/);
  assert.doesNotMatch(String((events[0] as { message?: string }).message), /99726/);
});

test("findOrphans spares a live-marked tree in the read marks of its descendants, and still reaps a dead-harness child's tree", async () => {
  const root = readyRepo();
  const dead = 999_999_999;
  const live = process.pid;
  // A live-marked descendant: the tree is spared.
  const liveProbe = fakeProbe(
    [
      { pid: 2001, command: `node ${root}/.tumwater/worktrees/_slot-a/run.js` },
      { pid: 2002, ppid: 2001, command: "node child.js" },
    ],
    {},
    { 2002: `${live}-xxx` },
  ).probe;
  const liveScan = await findOrphans(root, liveProbe);
  assert.ok("rows" in liveScan);
  assert.deepEqual(liveScan.orphans, []);
  // A dead-marked or unmarked descendant: still an orphan, reaped as today.
  const deadProbe = fakeProbe(
    [
      { pid: 2003, etime: "01:00:00", command: `node ${root}/.tumwater/worktrees/_slot-b/run.js` },
      { pid: 2004, ppid: 2003, etime: "01:00:00", command: "node child.js" },
    ],
    {},
    { 2004: `${dead}-xx` },
  ).probe;
  const deadScan = await findOrphans(root, deadProbe);
  assert.ok("rows" in deadScan);
  assert.deepEqual(deadScan.orphans.map((r) => r.pid), [2003]);
  const unmarkedProbe = fakeProbe(
    [{ pid: 2005, etime: "01:00:00", command: `node ${root}/.tumwater/worktrees/_slot-c/run.js` }],
    {},
  ).probe;
  const unmarkedScan = await findOrphans(root, unmarkedProbe);
  assert.ok("rows" in unmarkedScan);
  assert.deepEqual(unmarkedScan.orphans.map((r) => r.pid), [2005]);
});

test("orphanFailDetail notes a spared live tree so the operator sees why it is not orphaned", async () => {
  const root = readyRepo();
  const live = process.pid;
  const probe = fakeProbe(
    [
      { pid: 3001, etime: "01:00:00", command: `node ${root}/.tumwater/worktrees/_slot-d/run.js` },
      { pid: 3002, ppid: 3001, command: "node child.js" },
      // A real orphan alongside, so the row still fails.
      { pid: 3003, etime: "01:00:00", command: `node ${root}/.tumwater/worktrees/_slot-e/leak.js` },
    ],
    {},
    { 3002: `${live}-xx` },
  ).probe;
  const scan = await findOrphans(root, probe);
  assert.ok("rows" in scan);
  const detail = orphanFailDetail(root, scan);
  assert.ok(detail);
  assert.match(detail, /1 parentless tree left alone \(a live run's own command: pid 3001/);
  assert.match(detail, /pid 3003/);
});

test("dueForOrphanReap fires at and after the interval, never before, from literal times", () => {
  assert.equal(dueForOrphanReap(0, 0, 900_000), false, "zero elapsed is not due");
  assert.equal(dueForOrphanReap(0, 899_999, 900_000), false, "a millisecond short is not due");
  assert.equal(dueForOrphanReap(0, 900_000, 900_000), true, "exactly the interval is due");
  assert.equal(dueForOrphanReap(5_000, 1_000_000, 900_000), true, "past the interval is due");
  // The default is the production 15-minute interval; a fresh state's last=0 against a real
  // now (the very first poll) is always due.
  assert.equal(ORPHAN_REAP_INTERVAL_MS, 15 * 60 * 1000);
  assert.equal(dueForOrphanReap(0, Date.now()), true);
});

test("a fresh PollState has no reap stamp, so the first poll reaps immediately", () => {
  assert.equal(newPollState().lastOrphanReapAt, 0);
});
