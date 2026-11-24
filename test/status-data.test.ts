// Core status-data suite: snapshot()'s own contract and per-poll cache — the config it
// resolves against (quiet hours, custom roles), the role rows it builds, and the stat-keyed
// reads that serve them. Split by facet from one status-data test file; the
// budget/cap fields live in status-data-budget.test.ts, the team/pause/health fields in
// status-data-team.test.ts, the queue fields in status-data-inbox.test.ts, and the model
// selector/seam rows in status-data-models.test.ts.

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { maintenanceForPoll, pollStallForPoll, snapshot } from "../src/status/status-data.js";
import { githubIssuesPath, heartbeatPath, maintenancePath } from "../src/paths.js";
import {
  readGithubIssuesForPoll,
  writeGithubIssues,
  type GithubIssueRow,
  type GithubIssuesLedger,
} from "../src/github/github-issues-state.js";
import { writeJsonFile } from "../src/files/json-files.js";
import { runnerStateForPoll } from "../src/status/status-polls.js";
import { quietHoursStatus } from "../src/scheduling/quiet-hours.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { quietBadge } from "../src/ui/badges.js";
import { initProject } from "../src/init/init.js";
import { makeRepo, writeConfig } from "./fixtures/repo-fixtures.js";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { allRoleIds } from "../src/roles/roles.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { withCountedReads } from "./helpers/fs-faults.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { backdate } from "./helpers/backdate.js";

// Quiet hours 2/2 (plans: "Quiet hours … part 2/2, observability"): the snapshot carries the
// configured window and the in-window flag — present only while the value parses to a real
// window, so a schedule the gate is not holding is never advertised — and the payload ships
// the same fields with the header badge preformatted.
test("snapshot carries the quiet-hours window when configured and nothing when not", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");

  const unset = await snapshot(repo);
  assert.equal(unset.quietHours, undefined);
  assert.equal(unset.inQuietHours, false);

  writeConfig(repo, { quietHours: "23:00-07:00" });
  const set = await snapshot(repo);
  assert.equal(set.quietHours, "23:00-07:00");
  // The flag is the gate's own predicate (inQuietHours), evaluated for the poll's clock.
  assert.equal(set.inQuietHours, quietHoursStatus("23:00-07:00", new Date()).inWindow);
  // The payload's badge is the snapshot's fields through quietBadge — agreeing with the
  // header whatever the wall clock reads (this suite can run inside or outside the window).
  assert.equal(
    ((await statusPayload(repo)) as { quietBadge: string }).quietBadge,
    quietBadge(set.quietHours, set.inQuietHours),
  );

  // A malformed value degrades with the whole config — status/status-polls.ts's configForStatus
  // serves the last-known-good one, so the badge never flashes off on a single broken write.
  writeConfig(repo, { quietHours: "23:00" });
  const broken = await snapshot(repo);
  assert.equal(broken.quietHours, "23:00-07:00", "a broken config serves the last-known-good window");

  // From a cold start (no last-known-good), a broken config means the defaults: nothing.
  const cold = makeRepo();
  await initProject(cold, "test project");
  writeConfig(cold, { quietHours: "23:00" });
  const fromDefaults = await snapshot(cold);
  assert.equal(fromDefaults.quietHours, undefined);
  assert.equal(fromDefaults.inQuietHours, false);
});

test("snapshot lists one row per role id for a multi-instance role (part 5b/7)", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  const config = loadConfig(repo);
  config.roles.feature = { ...(config.roles.feature ?? { enabled: true }), instances: 2 };
  saveConfig(repo, config);
  const ids = (await snapshot(repo)).roles.map((l) => l.role);
  assert.equal(ids.includes("feature"), true);
  assert.equal(ids.includes("feature-2"), true);
});

// Per-role quiet hours key config by BASE role (gate-polls.ts's roleQuietHeld resolves an
// instance through baseRoleOf), so the snapshot must resolve the window the same way while
// keying the map by the role id rolePhase looks up — otherwise feature-2 reads queued while
// the scheduler holds it.
test("snapshot resolves a per-role quiet window through the base role for instances", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  // A window that holds right now wherever the suite runs: start at the current minute and
  // end one minute earlier (wrapping midnight), so `now` is always inside the half-open range.
  const now = new Date();
  const at = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const window = `${at(now)}-${at(new Date(now.getTime() - 60_000))}`;
  const config = loadConfig(repo);
  config.roles.feature = { ...(config.roles.feature ?? { enabled: true }), instances: 2 };
  config.quietHoursPerRole = { feature: window };
  saveConfig(repo, config);

  const paused = (await snapshot(repo)).roleQuietPaused;
  assert.equal(paused.feature, window);
  assert.equal(paused["feature-2"], window, "the instance inherits its base role's window");
});

test("snapshot survives a broken tumwater.json and recovers when it is fixed", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  // Both instance roles pinned to one instance: at the shipped default the snapshot also lists
  // each base's extra runners, which would change the baseline this states.
  const pinned = loadConfig(repo);
  pinned.roles.feature!.instances = 1;
  pinned.roles.bugfix!.instances = 1;
  saveConfig(repo, pinned);
  // Baseline: every catalog role but the opt-in selfcheck and feedback enabled by default.
  assert.equal((await snapshot(repo)).roles.length, allRoleIds().length - 2);

  // A valid config that disables one role becomes the last known-good one.
  const cfg = loadConfig(repo);
  cfg.roles.dedupe!.enabled = false;
  saveConfig(repo, cfg);
  let snap = await snapshot(repo);
  assert.ok(!snap.roles.some((l) => l.role === "dedupe"));

  // The file breaks mid-edit (invalid JSON): observers must not throw.
  fs.writeFileSync(path.join(repo, "tumwater.json"), "{ still editing");
  snap = await snapshot(repo);
  // The last known-good role set is kept: dedupe stays hidden and nothing crashes, and the
  // broken poll carries the parse error as the standing configProblem.
  assert.ok(!snap.roles.some((l) => l.role === "dedupe"));
  assert.match(snap.configProblem ?? "", /is not valid JSON/);

  // A validation error (valid JSON, invalid value) is equally survivable and surfaces its
  // own error as configProblem.
  writeConfig(repo, { maxConcurrent: "six" });
  snap = await snapshot(repo);
  assert.ok(snap.roles.length > 0);
  assert.ok(snap.configProblem, "the validation-error poll surfaces configProblem");

  // Repair with a different valid config: the fresh load takes effect again.
  cfg.roles.dedupe!.enabled = true;
  cfg.roles.clean!.enabled = false;
  saveConfig(repo, cfg);
  snap = await snapshot(repo);
  assert.ok(snap.roles.some((l) => l.role === "dedupe"));
  assert.ok(!snap.roles.some((l) => l.role === "clean"));
  assert.equal(snap.configProblem, undefined, "a repaired config drops the standing problem");
});

test("snapshot serves unchanged runner state from the stat-keyed cache without re-reading", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  const state = freshRunnerState("clean");
  state.runs = 3;
  saveRunnerState(repo, state);
  assert.equal((await snapshot(repo)).roles.find((l) => l.role === "clean")!.runs, 3); // populates the cache

  await withCountedReads(
    async (reads) => {
      const snap = await snapshot(repo);
      assert.equal(snap.roles.find((l) => l.role === "clean")!.runs, 3); // unchanged — served from cache
      assert.equal(reads(), 0); // no re-read of the state file at all
      // Each poll still gets its own objects: mutating one snapshot must not poison later ones.
      snap.roles.find((l) => l.role === "clean")!.runs = 99;
      assert.equal((await snapshot(repo)).roles.find((l) => l.role === "clean")!.runs, 3);
    },
    (file) => typeof file === "string" && file.endsWith(`${path.sep}state${path.sep}clean.json`),
  );

  // A same-size edit is picked up via mtime, not just size: runs 3 → 4 keeps the file's byte
  // length identical, so utimes forces a distinct mtime regardless of filesystem timestamp
  // granularity (two fast writes could otherwise share one on coarse-grained filesystems).
  const bumped = freshRunnerState("clean");
  bumped.runs = 4;
  saveRunnerState(repo, bumped);
  backdate(path.join(repo, ".tumwater", "state", "clean.json"), -5000);
  assert.equal((await snapshot(repo)).roles.find((l) => l.role === "clean")!.runs, 4);
});

test("runnerStateForPoll yields a fresh state for a role with no state file", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  // No state file was ever saved for the role: the stat-keyed cache misses and the missing
  // file yields a fresh state rather than throwing at the stat boundary.
  assert.deepEqual(runnerStateForPoll(repo, "clean"), freshRunnerState("clean"));
});

test("snapshot serves unchanged orchestrator info from the stat-keyed cache", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  // A live orchestrator's info file: both consumers (the pid column and the running flag)
  // have data to work with.
  writeOrchestratorMarker(repo, ["feature"]);
  assert.equal((await snapshot(repo)).running, true); // first read populates the cache

  await withCountedReads(
    async (reads) => {
      const snap = await snapshot(repo);
      assert.equal(snap.pid, process.pid); // the info was read once and serves both the pid…
      assert.equal(snap.running, true); // …and the liveness check from that same cached read
      assert.equal(reads(), 0); // unchanged — no re-read of the info file at all
      // Each poll still gets its own objects: mutating one snapshot must not poison later ones.
      snap.providerHolds = [{ kind: "x", until: 1 }];
      assert.equal((await snapshot(repo)).providerHolds, undefined);
    },
    (file) =>
      typeof file === "string" && file.endsWith(`${path.sep}state${path.sep}orchestrator.json`),
  );

  // A changed info file (the orchestrator republished its build) is picked up on the next
  // poll — the stat-keyed cache must not serve stale team state.
  writeOrchestratorMarker(repo, ["feature"], { build: { sha: "abc", builtAt: Date.now(), stale: true } });
  assert.ok(
    (await snapshot(repo)).build !== undefined,
    "a republished info file is re-read, not served stale",
  );
});

// The `custom` flag marks user-defined roles (tumwater.json's customRoles) for the
// dashboards' asterisk. It is computed in snapshot from the same last-known-good config that
// produced the role list — so a transiently broken file keeps marking its customs rather than
// flipping them unmarked mid-poll.
test("snapshot rows carry the custom flag matching the config", async () => {
  const repo = makeRepo();
  await initProject(repo, "custom flag test");
  assert.ok((await snapshot(repo)).roles.every((l) => !l.custom), "built-ins unmarked by default");

  const cfg = loadConfig(repo);
  cfg.customRoles.push({ name: "nightly", task: "do the nightly thing" });
  saveConfig(repo, cfg);
  let snap = await snapshot(repo);
  assert.ok(snap.roles.some((l) => l.role === "nightly" && l.custom), "listed custom is marked");
  assert.ok(
    snap.roles.filter((l) => !l.custom).length >= allRoleIds().length - 2,
    "every enabled built-in stays unmarked",
  );

  // The file breaks mid-edit: the last known-good config keeps marking the custom.
  fs.writeFileSync(path.join(repo, "tumwater.json"), "{ still editing");
  snap = await snapshot(repo);
  assert.ok(snap.roles.some((l) => l.role === "nightly" && l.custom), "broken file keeps last-known-good customs");
});

// The session-prune marker's snapshot reader (status-data.ts maintenanceForPoll): present only
// while the live orchestrator wrote it, and carrying an ETA only once ten deletes have landed.
function writeMaintenance(root: string, marker: object): void {
  const file = maintenancePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(marker));
}

const pruneMarker = (over: object = {}) => ({
  pid: 4242,
  task: "session-prune",
  backend: "codex",
  done: 10,
  total: 110,
  startedAt: 0,
  halfStartedAt: 0,
  updatedAt: 10_000,
  ...over,
});

test("maintenanceForPoll reads the marker only for the live orchestrator's pid", () => {
  const repo = makeRepo();
  assert.equal(maintenanceForPoll(repo, 4242), undefined, "no marker file reads as absent");
  writeMaintenance(repo, pruneMarker());
  assert.equal(maintenanceForPoll(repo, 999), undefined, "a marker another pid wrote reads as absent");
  assert.equal(maintenanceForPoll(repo, undefined), undefined, "no live orchestrator reads as absent");
  assert.equal(maintenanceForPoll(repo, 4242)?.done, 10);
});

test("the maintenance ETA is linear over the progress so far, and absent below ten deletes", () => {
  const repo = makeRepo();
  writeMaintenance(repo, pruneMarker({ done: 9 }));
  assert.equal(maintenanceForPoll(repo, 4242)?.etaMs, undefined, "nine deletes give no ETA");
  writeMaintenance(repo, pruneMarker({ done: 10 }));
  // (10,000 ms elapsed − 0) ÷ 10 deletes = 1,000 ms each, × 100 left = 100,000 ms.
  assert.equal(maintenanceForPoll(repo, 4242)?.etaMs, 100_000);
  // A later half (done/total reset) times only itself: an earlier half's 50 s is not in the rate.
  writeMaintenance(repo, pruneMarker({ startedAt: -50_000 }));
  assert.equal(maintenanceForPoll(repo, 4242)?.etaMs, 100_000);
});

// The poll heartbeat's stall reader (status-data.ts pollStallForPoll): stalled only for the live
// orchestrator's own heartbeat, older than POLL_STALL_MS, with no maintenance pass explaining it.
function writeHeartbeat(root: string, beat: object): void {
  const file = heartbeatPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(beat));
}

test("a live orchestrator's heartbeat four minutes old, with no marker, reads as stalled", () => {
  const repo = makeRepo();
  const now = Date.UTC(2026, 10, 21, 22, 40, 0);
  writeHeartbeat(repo, { pid: 4242, lastPollAt: now - 4 * 60_000 });
  assert.deepEqual(pollStallForPoll(repo, 4242, false, now), { lastPollAt: now - 4 * 60_000 });
});

test("a heartbeat one minute old is fresh, not stalled", () => {
  const repo = makeRepo();
  const now = Date.UTC(2026, 10, 21, 22, 40, 0);
  writeHeartbeat(repo, { pid: 4242, lastPollAt: now - 60_000 });
  assert.equal(pollStallForPoll(repo, 4242, false, now), undefined);
});

test("a stale heartbeat reads as absent for a dead pid, another pid, or a missing file", () => {
  const repo = makeRepo();
  const now = Date.UTC(2026, 10, 21, 22, 40, 0);
  assert.equal(pollStallForPoll(repo, 4242, false, now), undefined, "no heartbeat file reads as absent");
  writeHeartbeat(repo, { pid: 999, lastPollAt: now - 4 * 60_000 });
  assert.equal(pollStallForPoll(repo, 4242, false, now), undefined, "a heartbeat another pid wrote reads as absent");
  writeHeartbeat(repo, { pid: 4242, lastPollAt: now - 4 * 60_000 });
  assert.equal(pollStallForPoll(repo, undefined, false, now), undefined, "no live orchestrator reads as absent");
});

test("a standing maintenance pass suppresses the stall, which the blue banner explains instead", () => {
  const repo = makeRepo();
  const now = Date.UTC(2026, 10, 21, 22, 40, 0);
  writeHeartbeat(repo, { pid: 4242, lastPollAt: now - 4 * 60_000 });
  assert.equal(pollStallForPoll(repo, 4242, true, now), undefined);
});

test("snapshot folds the GitHub issues ledger to its counts and omits it when absent or disabled", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  assert.equal((await snapshot(repo)).githubIssues, undefined);

  const issue = (number: number, trusted: boolean, mirrored: boolean): GithubIssueRow => ({
    number,
    title: `issue ${number}`,
    url: `https://github.com/acme/widgets/issues/${number}`,
    author: "someone",
    trusted,
    mirrored,
    labels: [],
    updatedAt: "2026-11-21T00:00:00Z",
  });
  writeGithubIssues(repo, {
    repo: "acme/widgets",
    branch: "main",
    checkedAt: 1000,
    gh: "ok",
    open: [issue(1, true, false), issue(2, true, false), issue(3, false, false), issue(4, true, true)],
  });
  assert.deepEqual((await snapshot(repo)).githubIssues, {
    repo: "acme/widgets",
    gh: "ok",
    checkedAt: 1000,
    unmirrored: 2,
    untrusted: 1,
    waitingPush: 0,
    mirrorLabel: "tumwater",
    upstreamClosed: 0,
  });

  writeConfig(repo, { githubIssues: { enabled: false } });
  assert.equal((await snapshot(repo)).githubIssues, undefined);
});

test("the snapshot's unmirrored count spares a director-declined issue and still counts a queued one", async () => {
  // The standing blue banner reads this fold, but the queue will not offer a declined issue again
  // until GitHub's copy moves — so a declined issue must not keep the banner standing, while an
  // issue merely queued 2 h ago still is waiting (isDeclinedHold, INV-DE4).
  const now = Date.UTC(2026, 10, 21, 10, 0, 0);
  const updatedAt = "2026-11-21T00:00:00Z";
  const declinedAt = now - 2 * 60 * 60 * 1000;
  const repo = makeRepo();
  await initProject(repo, "test project");
  const row = (number: number, rowUpdatedAt: string): GithubIssueRow => ({
    number,
    title: `issue ${number}`,
    url: `https://github.com/acme/widgets/issues/${number}`,
    author: "someone",
    trusted: true,
    mirrored: false,
    labels: [],
    updatedAt: rowUpdatedAt,
  });
  const writeDeclinedMirror = (declined?: GithubIssuesLedger["declined"]): void => {
    writeGithubIssues(repo, {
      repo: "acme/widgets",
      branch: "main",
      checkedAt: now,
      gh: "ok",
      open: [row(1, updatedAt), row(2, updatedAt)],
      queued: { "1": { at: declinedAt, updatedAt } },
      ...(declined === undefined ? {} : { declined }),
    });
  };

  // #2 declined at its own updatedAt: settled, so only #1 — queued, never settled — is waiting.
  writeDeclinedMirror({ "2": { at: declinedAt, updatedAt, reason: "dup" } });
  assert.deepEqual((await snapshot(repo, undefined, now)).githubIssues, {
    repo: "acme/widgets",
    gh: "ok",
    checkedAt: now,
    unmirrored: 1,
    untrusted: 0,
    waitingPush: 0,
    mirrorLabel: "tumwater",
    upstreamClosed: 0,
  });
  const [declinedBanner] = (await statusPayload(repo, now)).alerts.filter((a) => a.key === "github-mirror");
  assert.equal(
    declinedBanner?.detail,
    "1 open issue on acme/widgets is waiting for the director to mirror it",
  );

  // GitHub edited #2 after the decline: its updatedAt no longer matches, so it waits again.
  writeGithubIssues(repo, {
    repo: "acme/widgets",
    branch: "main",
    checkedAt: now,
    gh: "ok",
    open: [row(1, updatedAt), row(2, "2026-11-22T00:00:00Z")],
    queued: { "1": { at: declinedAt, updatedAt } },
    declined: { "2": { at: declinedAt, updatedAt, reason: "dup" } },
  });
  assert.equal((await snapshot(repo, undefined, now)).githubIssues?.unmirrored, 2);
  const [editedBanner] = (await statusPayload(repo, now)).alerts.filter((a) => a.key === "github-mirror");
  assert.equal(
    editedBanner?.detail,
    "2 open issues on acme/widgets are waiting for the director to mirror them",
  );

  // No `declined` record at all: the fold is what it always was.
  writeDeclinedMirror();
  assert.equal((await snapshot(repo, undefined, now)).githubIssues?.unmirrored, 2);
});

test("the snapshot serves the GitHub issues ledger from the stat-keyed cache without re-reading", async () => {
  // The ledger changes at the hourly scan, but both dashboards poll snapshot() every second, so
  // an unchanged file must cost one stat, not a re-read and re-parse of the whole open-issue list
  // (body excerpts and all) to fold it to five counts — the contract every other ledger's poll
  // reader already keeps.
  const repo = makeRepo();
  await initProject(repo, "test project");
  writeGithubIssues(repo, {
    repo: "acme/widgets",
    branch: "main",
    checkedAt: 1000,
    gh: "ok",
    open: [{
      number: 1,
      title: "a broken thing",
      url: "https://github.com/acme/widgets/issues/1",
      author: "someone",
      trusted: true,
      mirrored: false,
      labels: [],
      updatedAt: "2026-11-21T00:00:00Z",
      bodyExcerpt: "x".repeat(4000),
    }],
  });
  assert.equal((await snapshot(repo)).githubIssues?.unmirrored, 1); // populates the cache

  await withCountedReads(
    async (reads) => {
      const snap = await snapshot(repo);
      assert.equal(snap.githubIssues?.unmirrored, 1); // unchanged — served from cache
      assert.equal(reads(), 0, "no re-read of the ledger file at all");
      assert.equal((await snapshot(repo)).githubIssues?.unmirrored, 1);
    },
    (file) => typeof file === "string" && file.endsWith(`${path.sep}state${path.sep}github-issues.json`),
  );

  // Each read owns its data: the cached ledger's `open` list is copied, so emptying one read's
  // list cannot reach the next poll's (the same ownership the runner-state cache test pins).
  const polled = readGithubIssuesForPoll(repo);
  if (polled) polled.open.length = 0;
  assert.equal(readGithubIssuesForPoll(repo)?.open.length, 1, "the emptied list never reaches the cache");
});

test("a foreign-shaped GitHub issues ledger raises no githubIssues field and never throws", async () => {
  // readJsonFile only checks "a plain object", so a hand-edited or foreign-generation ledger with
  // no `open` list must read as no data — otherwise the fold's `open.filter` throws out of the
  // snapshot and takes the whole dashboard payload down with it (the same policy as the remote-CI
  // and ci-parity ledgers' shape guards).
  const repo = makeRepo();
  await initProject(repo, "test project");
  writeJsonFile(githubIssuesPath(repo), { repo: "acme/widgets", checkedAt: 1000, gh: "ok" });
  assert.equal((await snapshot(repo)).githubIssues, undefined);

  writeJsonFile(githubIssuesPath(repo), { repo: "acme/widgets", checkedAt: 1000, gh: "ok", open: "nope" });
  assert.equal((await snapshot(repo)).githubIssues, undefined);
  // A list holding only unusable entries is a different case: `readGithubIssues` drops the rows it
  // does not declare, so the ledger still reads as an empty mirror rather than no field — the arm
  // "the snapshot counts only the well-formed rows of a ledger holding a malformed one" pins.
});

test("the snapshot counts only the well-formed rows of a ledger holding a malformed one", async () => {
  // The row-level half of the same guard: `open.filter((issue) => issue.trusted …)` reads a field
  // of every entry, so a hand-edited ledger holding null or a half-written row in its `open` list
  // must count the rows that are there, not throw out of the fold — readGithubIssues drops the
  // entries that are not declared rows.
  const repo = makeRepo();
  await initProject(repo, "test project");
  writeJsonFile(githubIssuesPath(repo), {
    repo: "acme/widgets",
    branch: "main",
    checkedAt: 1000,
    gh: "ok",
    open: [
      {
        number: 1,
        title: "one",
        url: "https://github.com/acme/widgets/issues/1",
        author: "someone",
        trusted: true,
        mirrored: false,
        labels: [],
        updatedAt: "2026-11-21T00:00:00Z",
      },
      null,
      "not a row",
      { number: 2, title: "half a row" },
      { number: 3, title: "bad labels", url: "u", author: "a", trusted: true, mirrored: false, labels: [7], updatedAt: "t" },
    ],
  });
  assert.deepEqual((await snapshot(repo)).githubIssues, {
    repo: "acme/widgets",
    gh: "ok",
    checkedAt: 1000,
    unmirrored: 1,
    untrusted: 0,
    waitingPush: 0,
    mirrorLabel: "tumwater",
    upstreamClosed: 0,
  });
});

// The mirror's upstream-close count onto the snapshot (INV-DG2): the doctor row and the alert band
// both read this one fold, so the ledger's `upstreamClosed` list is the single count source.
test("the snapshot counts the ledger's upstream closes, screened rows only", async () => {
  const lost = (number: number): GithubIssueRow => ({
    number,
    title: `lost ${number}`,
    url: `https://github.com/acme/widgets/issues/${number}`,
    author: "someone",
    trusted: true,
    mirrored: false,
    labels: [],
    updatedAt: "2026-11-21T00:00:00Z",
    closedAt: 900,
  });
  const writeLost = async (rows: GithubIssueRow[] | undefined): Promise<string> => {
    const repo = makeRepo();
    await initProject(repo, "test project");
    writeGithubIssues(repo, {
      repo: "acme/widgets",
      branch: "main",
      checkedAt: 1000,
      gh: "ok",
      open: [],
      ...(rows === undefined ? {} : { upstreamClosed: rows }),
    });
    return repo;
  };

  assert.equal((await snapshot(await writeLost([lost(7), lost(8)]))).githubIssues?.upstreamClosed, 2);

  // An absent list — the shape every ledger had before the record existed — folds to 0.
  assert.equal((await snapshot(await writeLost(undefined))).githubIssues?.upstreamClosed, 0);

  // The standing banner rides the same fold: a positive count is the doctor row's one sentence.
  const bannerRepo = await writeLost([lost(7), lost(8)]);
  const [banner] = (await statusPayload(bannerRepo, 1000)).alerts.filter((a) => a.key === "github-upstream-closes");
  assert.equal(banner?.tone, "blue");
  assert.equal(
    banner?.detail,
    "2 open issues on acme/widgets were closed upstream with no fix merged by tumwater",
  );
});

test("the snapshot counts only the screened rows of a hand-edited upstreamClosed list", async () => {
  // The same row guard the `open` list passes (readGithubIssues screens both lists), so a
  // hand-edited list counts what survives instead of what the file names.
  const repo = makeRepo();
  await initProject(repo, "test project");
  writeJsonFile(githubIssuesPath(repo), {
    repo: "acme/widgets",
    branch: "main",
    checkedAt: 1000,
    gh: "ok",
    open: [],
    upstreamClosed: [
      { number: 7, title: "seven", url: "u", author: "a", trusted: true, mirrored: false, labels: [], updatedAt: "t", closedAt: 900 },
      null,
      { number: 8, title: "half a row" },
    ],
  });
  assert.equal((await snapshot(repo)).githubIssues?.upstreamClosed, 1);
});

// The mirror's stall onto the snapshot (the standing-banner plan): the poll decides it where the
// ledger is already open, so both dashboards render a banner instead of leaving the quiet mirror to
// `tumwater doctor`.
const stallLedger = (repo: string, checkedAt: number): void => {
  writeGithubIssues(repo, {
    repo: "a/b",
    branch: "main",
    checkedAt,
    gh: "ok",
    open: [],
  });
};

test("the snapshot carries githubScanStall only past the stall window", async () => {
  const now = Date.UTC(2026, 10, 21, 10, 0, 0);
  const DAY_MS = 86_400_000;

  // Four days old: past the three-day window, so the field names the repo and the stamp the alert
  // renders its age from.
  const stale = makeRepo();
  await initProject(stale, "test project");
  stallLedger(stale, now - 4 * DAY_MS);
  assert.deepEqual((await snapshot(stale, undefined, now)).githubScanStall, { repo: "a/b", checkedAt: now - 4 * DAY_MS });

  // An hour old: a fresh scan, so no field at all — and the ledger field itself is still there.
  const fresh = makeRepo();
  await initProject(fresh, "test project");
  stallLedger(fresh, now - 60 * 60 * 1000);
  const freshSnap = await snapshot(fresh, undefined, now);
  assert.equal(freshSnap.githubScanStall, undefined);
  assert.equal(freshSnap.githubIssues?.repo, "a/b", "the ledger itself still reads");

  // Exactly the window old is not a stall — the predicate's boundary is exclusive.
  const boundary = makeRepo();
  await initProject(boundary, "test project");
  stallLedger(boundary, now - 3 * DAY_MS);
  assert.equal((await snapshot(boundary, undefined, now)).githubScanStall, undefined);
});

test("the snapshot omits githubScanStall for no ledger, a foreign shape, or the feature off", async () => {
  const now = Date.UTC(2026, 10, 21, 10, 0, 0);

  // No ledger file at all (never scanned).
  const bare = makeRepo();
  await initProject(bare, "test project");
  const bareSnap = await snapshot(bare, undefined, now);
  assert.equal(bareSnap.githubScanStall, undefined);
  assert.equal(bareSnap.githubIssues, undefined);

  // A hand-edited ledger whose checkedAt is not a number: the fold reads no data at all.
  const junk = makeRepo();
  await initProject(junk, "test project");
  writeJsonFile(githubIssuesPath(junk), { repo: "a/b", branch: "main", checkedAt: "1764000000000", gh: "ok", open: [] });
  assert.equal((await snapshot(junk, undefined, now)).githubScanStall, undefined);

  // githubIssues.enabled: false — no ledger field, no stall field.
  const off = makeRepo();
  await initProject(off, "test project");
  stallLedger(off, now - 4 * 86_400_000);
  writeConfig(off, { githubIssues: { enabled: false } });
  const offSnap = await snapshot(off, undefined, now);
  assert.equal(offSnap.githubIssues, undefined);
  assert.equal(offSnap.githubScanStall, undefined);
});
