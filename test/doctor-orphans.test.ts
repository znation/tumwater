import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkOrphans } from "../src/doctor/doctor-orphans.js";
import { runDoctor } from "../src/doctor/doctor.js";
import type { ProcessProbe } from "../src/process-table.js";
import { tmpdir } from "./repo-fixtures.js";
import { fakeBins, fakeProbe, noProcesses, readyRepo } from "./doctor-fixtures.js";

// Unit coverage for the orphaned-worktree-process check (src/doctor/doctor-orphans.ts): every leak
// shape below is a real leak the fleet produced, driven through a fake process table — no
// orphan is ever spawned. The real ps/lsof reader is smoked in test/process.test.ts; the
// other doctor checks' unit coverage lives in test/doctor-checks.test.ts.

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
      " — nothing reaps these; kill each with its descendants",
  });
  // One cwd lookup, over the parentless processes argv did not already settle — never the
  // workers (they have a parent) and never the absolute-argv match.
  assert.deepEqual(asked, [[88052, 73241]]);
});

test("checkOrphans leaves the live fleet and other checkouts' orphans alone", async () => {
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
      `pid 3100 (age 11:22:33, cpu 1:02.30) node /tmp/twprobe/server.js (run ${dead}-deadbeef; harness ${dead} exited)` +
      " — nothing reaps these; kill each with its descendants",
  });
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
      " — nothing reaps these; kill each with its descendants",
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
  const wt = path.join(fs.realpathSync(root), ".tumwater", "worktrees", "_land-dry");
  const long = `node ${root}/.tumwater/worktrees/_land-dry/dist/src/cli.js run --note ${"a".repeat(100)}`;
  const rows = Array.from({ length: 10 }, (_, i) => ({ pid: 45355 + i, command: i === 0 ? long : "perl -e while(1){}" }));
  const { probe } = fakeProbe(rows, Object.fromEntries(rows.map((r) => [r.pid, wt])));
  const r = await checkOrphans(root, probe);
  assert.equal(r.level, "fail");
  assert.match(r.detail, /^10 orphaned processes \(PPID 1\): /);
  assert.equal(r.detail.match(/pid \d+ \(age/g)?.length, 8);
  assert.match(r.detail, /; and 2 more — nothing reaps these/);
  // The root is cut first, then the command is trimmed to 80 characters with an ellipsis.
  const shown = `node .tumwater/worktrees/_land-dry/dist/src/cli.js run --note ${"a".repeat(100)}`.slice(0, 79);
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
