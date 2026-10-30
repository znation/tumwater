import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readEventsTailWithEnd } from "../src/events/event-read.js";
import { eventFeedItem, eventMatchesGrep } from "../src/events/event-format.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { runNotFoundLastMessage } from "../src/run/run-detail.js";
import { handleBrief, handleConfig, handleDoctor, handleDiff, handleReport, handleFailures, handleHistory, handleLogs, handlePromptText, handleRun, handleRole } from "../src/gui/gui-endpoints.js";
import { EDITABLE_CONFIG_KEYS } from "../src/config/config-editable-keys.js";
import { handleBriefEdit, handleBudget, handleRoleCap, handleRoleEnable, handleRoleDisable, handleRoleInstances, handleRoleInterval, handleRoleInstructions, handleRoleModel, handleRoleQuietHours, handleConfigSet, handleConfigUnset, handleNotifyTest, handleBacklogFile, handleBacklogCancel, handleBacklogRelease, handleBacklogTop, handleBacklogEdit, handlePromptEdit, handlePromptTop, handleQuestionAnswer, handleReclaim, handleKillOrphans, handleDropBrokenPins, handleCommitBacklog, handleResyncInstall, handleRetireLeftovers, handleArchiveBacklog, handleRestart, handleRoleNotes, handleStopSchedule } from "../src/gui/gui-endpoint-commands.js";
import { rootInstallResyncLines, type RootInstallResync } from "../src/build/dep-install.js";
import { renderRunDetail } from "../src/run/run-detail-render.js";
import { readRunDetail, type RunDetail } from "../src/run/run-detail-data.js";
import { consumeRestartRequest } from "../src/operator/operator-requests.js";
import { scheduledStopAt } from "../src/team/team-state.js";
import { writeJsonFile } from "../src/files/json-files.js";
import { configPath, roleInboxDir, roleNotesPath, wakeRequestPath } from "../src/paths.js";
import { orchestratorStatePath, reclaimRequestPath, restartRequestPath } from "../src/paths.js";
import { DIRECTOR_PROMPT_MAX_CHARS } from "../src/inbox/inbox-submit.js";
import { queuedFiles, queuedRolePromptRecords } from "../src/inbox/inbox.js";
import { WINDOW_DAY_CASES } from "./fixtures/window-days.js";
import { atLocalTs as at, dayKey } from "./helpers/oracles.js";
import { LOGS_SINCE_MAX_MS } from "../src/events/event-window.js";
import { writeEvents, eventsOfType } from "./fixtures/log-fixtures.js";
import { BRIEF_TEXT_MAX_CHARS, PROMPT_START, readBrief } from "../src/brief/brief.js";
import { initializedRepo, sh, assertClean, tmpdir, commitIn, makeRepo, writeBacklogFile } from "./fixtures/repo-fixtures.js";
import { startLocalGui } from "./fixtures/gui-fixtures.js";
import { collectChangeOverlaps, scopeChangeOverlaps, collectTeamChanges, collectRoleChange } from "../src/change/change-data.js";
import { collectReportSince } from "../src/report/report-since-data.js";
import { renderSinceReportMarkdown } from "../src/report/report-since-render.js";
import { entryKey } from "../src/backlog/backlog-parts.js";
import { saveRunnerState } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { collectFailureReportSince } from "../src/failure/failure-data.js";
import { renderFailureMarkdown } from "../src/failure/failure-render.js";
import { setConfigKey } from "../src/config/config-write.js";
import { initProject } from "../src/init/init.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { captureJson, fakeReq } from "./fakes/fake-res.js";
import { readJson } from "./helpers/json-read.js";
import { rolePayload } from "../src/roles/role-view.js";
import { readRunRowsSince, summarizeRunRows, summarizeRunRowsByModel } from "../src/history/history-data.js";
import { bugWakeText, planWakeText } from "../src/backlog/backlog-write.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { ROLE_NOTES_MAX_BYTES } from "../src/agent/role-notes-write.js";
import { ROLE_INSTRUCTIONS_MAX_CHARS } from "../src/config/config-schema.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

// The GET report/failures endpoints of the dashboard (src/gui/gui-report-endpoints.ts),
// exercised at the unit level: handleReport and handleFailures have no other direct coverage —
// gui.test.ts drives /api/prompt, /api/transcript, and /api/backlog through the live server but
// never these two.
// Both handlers only read the parsed query (the server threads it down from the one
// parseRequestTarget call) and write one JSON response, so a fake res that captures
// writeHead/end is enough; the domain work runs for real against a seeded repo.

function serveReport(root: string, query = "") {
  return captureJson((res) => handleReport(new URLSearchParams(query), res, root));
}

test("handleReport serves seeded usage as JSON: status, content-type, and real totals", async () => {
  const root = tmpdir();
  writeEvents(root, [
    // Out of the 5-day window — must not count in any total.
    JSON.stringify({ ts: at(6), loop: "feature", type: "run_end", run: 1, result: "no_change", tokens: 999 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(4), loop: "feature", type: "run_end", run: 2, result: "changed", tokens: 500, costUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(3), loop: "feature", type: "merged", commit: "abc1234", summary: "x" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "steward", type: "merged", commit: "def5678", summary: "y" }), // retired-name-ok: legacy event field in a fixture
  ]);
  // A PLANS.md Done entry dated today counts as one feature done in the window.
  writeBacklogFile(root, "PLANS.md", [
    { heading: "## Done", body: `### Something (planned 2026-09-20, done ${dayKey(at(0))}; commit abc1234)` },
  ]);

  const { captured, data } = await serveReport(root, "?days=5");
  const report = data as { days: number; series: { date: string; tokensOut: number; commits: number; featuresDone: number; costByRole: Record<string, number> }[]; totals: { tokensOut: number; runs: number; commits: number; featuresDone: number; costUsd: number } };

  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  assert.equal(report.days, 5);
  assert.equal(report.series.length, 5);
  assert.equal(report.series[report.series.length - 1]?.date, dayKey(at(0)));
  assert.equal(report.totals.tokensOut, 500); // the out-of-window 999 is excluded
  assert.equal(report.totals.runs, 1);
  assert.equal(report.totals.commits, 2);
  assert.equal(report.totals.featuresDone, 1);
  assert.deepEqual(report.series[0]?.costByRole, { feature: 0.5 });
});

test("handleReport degrades a bad days value to the default and clamps the range", async () => {
  const root = tmpdir();
  // windowDays's documented rule, shared as WINDOW_DAY_CASES: a URL typo degrades to the
  // default window, never an error.
  for (const [query, expectedDays] of WINDOW_DAY_CASES) {
    const { captured, data } = await serveReport(root, query);
    const report = data as { days: number; series: unknown[] };
    assert.equal(captured.status, 200, query);
    assert.equal(report.days, expectedDays, query);
    assert.equal(report.series.length, expectedDays, query);
  }
});

test("handleFailures serves the digest as JSON markdown, empty and after an error run", async () => {
  // Empty log: the digest still answers 200 with its header, not an error.
  const empty = tmpdir();
  const { captured, data } = await serveFailures(empty);
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  assert.match((data as { markdown: string }).markdown, /^# tumwater failure digest/);

  // A seeded error run surfaces as a real outcome row in the same digest.
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "bugfix", type: "run_end", run: 1, result: "error" }), // retired-name-ok: legacy event field in a fixture
  ]);
  const seeded = await serveFailures(root);
  const markdown = (seeded.data as { markdown: string }).markdown;
  assert.match(markdown, /^# tumwater failure digest/);
  assert.match(markdown, /bugfix/);
  assert.match(markdown, /error/);
});

function serveFailures(root: string, query = "") {
  return captureJson((res) => handleFailures(new URLSearchParams(query), res, root));
}

// ---- ?sinceMs= on both report endpoints: the CLI's trailing-window shape ----
// The dashboard's Usage and Failures tabs read through the same collectors and renders as
// `tumwater report --since` / `report --failures --since`, so the browser and terminal cannot
// disagree about a window. Timestamps are wall-clock offsets, not day keys: a sub-day window is
// the whole point.
test("handleReport serves the trailing-window totals as { markdown } when ?sinceMs is set", async () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [
    // 30 min old — inside a 1 h window; counts.
    JSON.stringify({ ts: now - 30 * 60 * 1000, loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 1234 }), // retired-name-ok: legacy event field in a fixture
    // 3 h old — outside a 1 h window; must not count.
    JSON.stringify({ ts: now - 3 * 60 * 60 * 1000, loop: "feature", type: "run_end", run: 2, result: "changed", tokens: 9999 }), // retired-name-ok: legacy event field in a fixture
  ]);

  const { captured, data } = await serveReport(root, "?sinceMs=3600000");
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  const payload = data as { markdown: string; series?: unknown; days?: unknown };
  assert.equal("series" in payload, false, "the since shape is markdown, not the day series");
  assert.equal("days" in payload, false);
  assert.match(payload.markdown, /window: last 1h/);
  assert.match(payload.markdown, /1234 output tokens/, "the 30-minute-old run counts");
  assert.doesNotMatch(payload.markdown, /9999/, "the 3-hour-old run is outside the window");
});

test("handleReport's ?untilMs ends the since window that long ago", async () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [
    JSON.stringify({ ts: now - 30 * 60 * 1000, loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 111 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: now - 3 * 60 * 60 * 1000, loop: "feature", type: "run_end", run: 2, result: "changed", tokens: 999 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const ok = await serveReport(root, "?sinceMs=14400000&untilMs=3600000");
  assert.equal(ok.captured.status, 200);
  const { markdown } = ok.data as { markdown: string };
  assert.match(markdown, /window: 4h to 1h ago/);
  assert.match(markdown, /999 output tokens/);
  assert.doesNotMatch(markdown, /111/);
  for (const [qs, err] of [
    ["?untilMs=3600000", /requires sinceMs/],
    ["?days=7&untilMs=3600000", /requires sinceMs/],
    ["?sinceMs=3600000&untilMs=3600000", /must be shorter than sinceMs/],
    ["?sinceMs=3600000&untilMs=abc", /untilMs/],
  ] as const) {
    const r = await serveReport(root, qs);
    assert.equal(r.captured.status, 400, qs);
    assert.match((r.data as { error: string }).error, err, qs);
  }
});

test("handleReport's ?sinceMs is bounded, rival to ?days, and scoped by ?role", async () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [
    JSON.stringify({ ts: now - 10 * 60 * 1000, loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 10 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: now - 10 * 60 * 1000, loop: "bugfix", type: "run_end", run: 2, result: "changed", tokens: 20 }), // retired-name-ok: legacy event field in a fixture
  ]);

  assert.equal((await serveReport(root, "?sinceMs=604800001")).captured.status, 400, "above the 7d cap is a 400, not a clamp");
  assert.equal((await serveReport(root, "?sinceMs=3600000&days=7")).captured.status, 400, "?days and ?sinceMs are rival shapes");

  const scoped = (await serveReport(root, "?sinceMs=3600000&role=feature")).data as { markdown: string };
  assert.match(scoped.markdown, /^role: feature$/m, "?role scopes the since collector");
  assert.match(scoped.markdown, /10 output tokens/, "only the feature run's usage counts");
  assert.doesNotMatch(scoped.markdown, /bugfix/);

  const multi = (await serveReport(root, "?sinceMs=3600000&role=feature,steward")).data as { markdown: string };
  // The "since <time>" stamp is read from the clock per call and can straddle a second boundary.
  const stripSince = (md: string) => md.replace(/\(since [^)]*\)/, "(since)");
  assert.equal(stripSince(multi.markdown), stripSince(renderSinceReportMarkdown(collectReportSince(root, 3600000, ["feature", "steward"]))));
  assert.equal((await serveReport(root, "?sinceMs=3600000&role=feature,bogus")).captured.status, 400);
});

test("handleFailures serves the windowed digest as { markdown } when ?sinceMs is set", async () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [
    JSON.stringify({ ts: now - 10 * 60 * 1000, loop: "bugfix", type: "run_end", run: 1, result: "error", error: "pi exited 1" }), // retired-name-ok: legacy event field in a fixture
  ]);

  const { captured, data } = await serveFailures(root, "?sinceMs=3600000");
  assert.equal(captured.status, 200);
  const payload = data as { markdown: string };
  assert.match(payload.markdown, /^# tumwater failure digest/);
  assert.match(payload.markdown, /window: last 1h/);
  assert.match(payload.markdown, /bugfix/);

  assert.equal((await serveFailures(root, "?sinceMs=604800001")).captured.status, 400);
  assert.equal((await serveFailures(root, "?sinceMs=3600000&days=7")).captured.status, 400);

  const scoped = (await serveFailures(root, "?sinceMs=3600000&role=feature")).data as { markdown: string };
  assert.match(scoped.markdown, /^role: feature$/m, "?role scopes the windowed digest");

  const multi = (await serveFailures(root, "?sinceMs=3600000&role=feature,steward")).data as { markdown: string };
  const stripSince = (md: string) => md.replace(/\(since [^)]*\)/, "(since)");
  assert.equal(stripSince(multi.markdown), stripSince(renderFailureMarkdown(collectFailureReportSince(root, 3600000, ["feature", "steward"]))));
  assert.equal((await serveFailures(root, "?sinceMs=3600000&role=feature,bogus")).captured.status, 400);
});

test("handleFailures' ?untilMs ends the since window that long ago", async () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [
    JSON.stringify({ ts: now - 30 * 60_000, loop: "bugfix", type: "run_end", run: 1, result: "error", error: "recent boom" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: now - 3 * 3600_000, loop: "feature", type: "run_end", run: 1, result: "error", error: "old boom" }), // retired-name-ok: legacy event field in a fixture
  ]);
  const ok = await serveFailures(root, "?sinceMs=14400000&untilMs=3600000");
  assert.equal(ok.captured.status, 200);
  const md = (ok.data as { markdown: string }).markdown;
  assert.match(md, /window: 4h to 1h ago/);
  assert.match(md, /feature/);
  assert.doesNotMatch(md, /bugfix/);
  const cases: [string, RegExp][] = [
    ["?untilMs=3600000", /requires sinceMs/],
    ["?days=7&untilMs=3600000", /requires sinceMs/],
    ["?sinceMs=3600000&untilMs=3600000", /must be shorter than sinceMs/],
    ["?sinceMs=3600000&untilMs=abc", /untilMs/],
  ];
  for (const [query, err] of cases) {
    const bad = await serveFailures(root, query);
    assert.equal(bad.captured.status, 400, query);
    assert.match(JSON.stringify(bad.data), err, query);
  }
});

// ---- POST /api/restart: the build-stale alert's refresh button ----
// handleRestart reads a request body (the shared readJsonObject front half), so a fake req is
// an EventEmitter that emits the body then ends — the same shape readBody's callbacks expect.
function serveRestart(root: string, body = "{}") {
  return captureJson((res) => handleRestart(fakeReq(body), res, root));
}

/** Seed an orchestrator info file whose pid is this test process (alive, by definition) with
 * the given published build — the staleness requestRestart consults. */
function seedTeam(root: string, build: Record<string, unknown> | null): void {
  writeFileDeep(orchestratorStatePath(root), JSON.stringify({ pid: process.pid, ...(build ? { build } : {}) }));
}

test("handleRestart writes the marker and replies ok while the running build is stale", async () => {
  const root = tmpdir();
  seedTeam(root, { sha: "a".repeat(40), builtAt: 1, stale: true, aheadCommits: 3 });
  const { captured, data } = await serveRestart(root);
  assert.equal(captured.status, 200);
  assert.equal((data as { ok: boolean }).ok, true);
  assert.match((data as { message: string }).message, /restart requested/);
  assert.match((data as { message: string }).message, /cooldown is waived/);
  assert.match((data as { message: string }).message, /blocked restart still blocks/);
  assert.equal(fs.existsSync(restartRequestPath(root)), true, "the marker a live team consumes is on disk");
});

test("handleKillOrphans answers the kill's lines and ok", async () => {
  const root = makeRepo();
  const killed = await captureJson((res) => handleKillOrphans(fakeReq("{}"), res, root, async () => ({ killed: [{ pid: 4242, command: "node x", descendants: 1 }], failed: [] })));
  assert.deepEqual(killed.data, { ok: true, message: "killed pid 4242 (+1 descendant) node x" });
  const broken = await captureJson((res) => handleKillOrphans(fakeReq("{}"), res, root, async () => ({ error: "boom" })));
  assert.deepEqual(broken.data, { ok: false, message: "could not scan the process table — boom; nothing killed" });
});

test("handleDropBrokenPins answers the drop lines and ok", async () => {
  const root = makeRepo();
  const { data: dropped } = await captureJson((res) => handleDropBrokenPins(fakeReq("{}"), res, root, async () => ({ dropped: [{ ref: "refs/tumwater/merge/broken", sha: "2".repeat(40) }], failed: [] })));
  assert.deepEqual(dropped, { ok: true, message: "1 dropped broken pin: refs/tumwater/merge/broken names 22222222" });
  const { data: unDropped } = await captureJson((res) => handleDropBrokenPins(fakeReq("{}"), res, root, async () => ({ dropped: [], failed: [{ ref: "refs/tumwater/merge/broken", reason: "boom" }] })));
  assert.deepEqual(unDropped, { ok: false, message: "1 pin could not be dropped: refs/tumwater/merge/broken — boom" });
  let notCalled = true;
  const { captured: badBody } = await captureJson((res) => handleDropBrokenPins(fakeReq("{nope"), res, root, async () => { notCalled = false; return { dropped: [], failed: [] }; }));
  assert.equal(badBody.status, 400);
  assert.equal(notCalled, true, "a malformed body never calls the drop seam");
});

test("handleRetireLeftovers answers the retire lines and ok", async () => {
  const root = makeRepo();
  const { data: retired } = await captureJson((res) => handleRetireLeftovers(fakeReq("{}"), res, root, async () => ({ retired: [{ role: "clean", removed: ["branch"] }], failed: [] })));
  assert.deepEqual(retired, { ok: true, message: "retired clean: the branch (tumwater/clean)" });
  const { data: refused } = await captureJson((res) => handleRetireLeftovers(fakeReq("{}"), res, root, async () => ({ retired: [], failed: [{ role: "dedupe", reason: "boom" }] })));
  assert.deepEqual(refused, { ok: false, message: "failed to retire dedupe: boom" });
  let notCalled = true;
  const { captured: badBody } = await captureJson((res) => handleRetireLeftovers(fakeReq("{nope"), res, root, async () => { notCalled = false; return { retired: [], failed: [] }; }));
  assert.equal(badBody.status, 400);
  assert.equal(notCalled, true, "a malformed body never calls the retire seam");
});

test("handleCommitBacklog answers the commit lines and ok", async () => {
  const root = makeRepo();
  let called = 0;
  const committed = await captureJson((res) => handleCommitBacklog(fakeReq("{}"), res, root, async () => { called += 1; return { base: "main", committed: ["PLANS.md"], failed: [], skipped: null }; }));
  assert.equal(called, 1);
  assert.equal(committed.captured.status, 200);
  assert.deepEqual(committed.data, { ok: true, message: "committed PLANS.md on main", committed: ["PLANS.md"], failed: [], skipped: null, base: "main" });
  const failed = await captureJson((res) => handleCommitBacklog(fakeReq("{}"), res, root, async () => ({ base: "main", committed: [], failed: ["BUGS.md"], skipped: null })));
  assert.deepEqual(failed.data, { ok: false, message: "could not commit BUGS.md — commit it by hand", committed: [], failed: ["BUGS.md"], skipped: null, base: "main" });
  const empty = await captureJson((res) => handleCommitBacklog(fakeReq("{}"), res, root, async () => ({ base: "main", committed: [], failed: [], skipped: null })));
  assert.deepEqual(empty.data, { ok: true, message: "nothing to commit — every watched backlog or brief file is committed", committed: [], failed: [], skipped: null, base: "main" });
  const skipped = await captureJson((res) => handleCommitBacklog(fakeReq("{}"), res, root, async () => ({ base: "main", committed: [], failed: [], skipped: "your checkout is not on main; nothing committed" })));
  assert.deepEqual(skipped.data, { ok: true, message: "your checkout is not on main; nothing committed", committed: [], failed: [], skipped: "your checkout is not on main; nothing committed", base: "main" });
  let notCalled = true;
  const badBody = await captureJson((res) => handleCommitBacklog(fakeReq("{nope"), res, root, async () => { notCalled = false; return { base: "main", committed: [], failed: [], skipped: null }; }));
  assert.equal(badBody.captured.status, 400);
  assert.equal(notCalled, true, "a malformed body never calls the commit seam");
});

test("handleArchiveBacklog answers the archive lines and ok", async () => {
  const root = makeRepo();
  let called = 0;
  const archived = await captureJson((res) => handleArchiveBacklog(fakeReq("{}"), res, root, async () => { called += 1; return { status: "archived", commit: "a".repeat(40), moved: [{ file: "PLANS.md", archive: "PLANS-DONE.md", titles: ["Done plan"], dropped: [] }] }; }));
  assert.equal(called, 1);
  assert.equal(archived.captured.status, 200);
  assert.deepEqual(archived.data, { ok: true, message: "PLANS.md → PLANS-DONE.md: 1 entry; committed aaaaaaaa", archived: true, commit: "a".repeat(40), moved: [{ file: "PLANS.md", archive: "PLANS-DONE.md", titles: ["Done plan"], dropped: [] }] });
  const nothing = await captureJson((res) => handleArchiveBacklog(fakeReq("{}"), res, root, async () => ({ status: "nothing" })));
  assert.equal(nothing.captured.status, 200);
  assert.deepEqual(nothing.data, { ok: true, message: "nothing to archive: PLANS.md ## Done and BUGS.md ## Fixed hold no finished entries" });
  const skipped = await captureJson((res) => handleArchiveBacklog(fakeReq("{}"), res, root, async () => ({ status: "skipped", reason: "your checkout is on x, not main" })));
  assert.deepEqual(skipped.data, { ok: false, message: "nothing archived: your checkout is on x, not main" });
  let notCalled = true;
  const badBody = await captureJson((res) => handleArchiveBacklog(fakeReq("{nope"), res, root, async () => { notCalled = false; return { status: "nothing" }; }));
  assert.equal(badBody.captured.status, 400);
  assert.equal(notCalled, true, "a malformed body never calls the archive seam");
});

test("handleResyncInstall answers the re-sync lines and ok", async () => {
  const root = makeRepo();
  const report = (shape: RootInstallResync) =>
    captureJson((res) => handleResyncInstall(fakeReq("{}"), res, root, async () => shape));
  const noDrift = await report({ attempted: false, ok: true, packages: [], durationMs: 0, pinned: true });
  assert.equal(noDrift.captured.status, 200);
  assert.deepEqual(noDrift.data, { ok: true, message: rootInstallResyncLines({ attempted: false, ok: true, packages: [], durationMs: 0, pinned: true }).join("; ") });
  const lockedOut = await report({ attempted: false, ok: true, packages: [], durationMs: 0, pinned: false });
  assert.deepEqual(lockedOut.data, { ok: true, message: rootInstallResyncLines({ attempted: false, ok: true, packages: [], durationMs: 0, pinned: false }).join("; ") });
  const reSynced = await report({ attempted: true, ok: true, packages: ["a", "b"], durationMs: 1234, pinned: true });
  assert.deepEqual(reSynced.data, { ok: true, message: rootInstallResyncLines({ attempted: true, ok: true, packages: ["a", "b"], durationMs: 1234, pinned: true }).join("; ") });
  const failed = await report({ attempted: true, ok: false, packages: [], durationMs: 0, pinned: true, detail: "boom" });
  assert.deepEqual(failed.data, { ok: false, message: rootInstallResyncLines({ attempted: true, ok: false, packages: [], durationMs: 0, pinned: true, detail: "boom" }).join("; ") });
  let notCalled = true;
  const badBody = await captureJson((res) => handleResyncInstall(fakeReq("{nope"), res, root, async () => { notCalled = false; return { attempted: false, ok: true, packages: [], durationMs: 0, pinned: true }; }));
  assert.equal(badBody.captured.status, 400);
  assert.equal(notCalled, true, "a malformed body never calls the resync seam");
});

test("handleReclaim with no worktrees answers nothing to reclaim", async () => {
  const root = makeRepo();
  const { captured, data } = await captureJson((res) => handleReclaim(fakeReq("{}"), res, root));
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, message: "nothing to reclaim" });
});

test("handleReclaim with a live team drops the reclaim marker", async () => {
  const root = makeRepo();
  seedTeam(root, null);
  const { captured, data } = await captureJson((res) => handleReclaim(fakeReq("{}"), res, root));
  assert.equal(captured.status, 200);
  assert.match((data as { message: string }).message, /reclaim requested/);
  assert.equal(fs.existsSync(reclaimRequestPath(root)), true);
});

test("handleReclaim rejects a malformed body with 400 and writes no marker", async () => {
  const root = makeRepo();
  seedTeam(root, null);
  const { captured } = await captureJson((res) => handleReclaim(fakeReq("{nope"), res, root));
  assert.equal(captured.status, 400);
  assert.equal(fs.existsSync(reclaimRequestPath(root)), false);
});

test("handleRestart refuses with nothing written when the running build is not stale", async () => {
  const root = tmpdir();
  seedTeam(root, { sha: "a".repeat(40), builtAt: 1, stale: false });
  const { captured, data } = await serveRestart(root);
  assert.equal(captured.status, 409);
  assert.match((data as { error: string }).error, /no update is waiting/);
  assert.equal(fs.existsSync(restartRequestPath(root)), false, "a fresh build's press writes nothing");
});

test("handleRestart with no team running writes the marker harmlessly and says so", async () => {
  const root = tmpdir();
  const { captured, data } = await serveRestart(root);
  assert.equal(captured.status, 200);
  assert.equal((data as { ok: boolean }).ok, true);
  assert.match((data as { message: string }).message, /tumwater is not running/);
  assert.equal(fs.existsSync(restartRequestPath(root)), true, "the marker waits for the next run's first poll");
});

// The live server's dispatch arm for POST /api/restart. The tests above drive handleRestart
// directly with a fake req, so the routing branch in gui-server.ts's request dispatcher — the
// method+path match that turns the build-stale alert's refresh button into a handler call —
// had no coverage: a renamed path or a dropped else-if would leave every endpoint test green
// while the button 404s. This pins the wiring through a real listening server.
test("the live server routes POST /api/restart to the handler and refuses other methods", async () => {
  const root = tmpdir();
  seedTeam(root, { sha: "a".repeat(40), builtAt: 1, stale: true, aheadCommits: 3 });
  const { server, base } = await startLocalGui(root);
  try {
    const res = await fetch(base + "/api/restart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean; message: string };
    assert.equal(data.ok, true);
    assert.match(data.message, /restart requested/);
    assert.equal(
      fs.existsSync(restartRequestPath(root)),
      true,
      "the handler the router reached wrote the marker",
    );

    // The method gate: a GET on the same path falls through the dispatcher's POST-only arm
    // to the 404 else — it must never reach the handler, so a stray GET writes no marker.
    const get = await fetch(base + "/api/restart");
    assert.equal(get.status, 404);
    assert.equal(fs.existsSync(restartRequestPath(root)), true, "the earlier POST's marker stands");
  } finally {
    server.close();
  }
});

function serveStopSchedule(root: string, body: unknown) {
  return captureJson((res) => handleStopSchedule(fakeReq(JSON.stringify(body)), res, root));
}

test("handleStopSchedule schedules a stop on a live team and cancel drops it", async () => {
  const root = tmpdir();
  seedTeam(root, null);
  const { captured, data } = await serveStopSchedule(root, { inSeconds: 7200 });
  assert.equal(captured.status, 200);
  assert.match((data as { message: string }).message, /stop scheduled in 2h/);
  assert.ok(Math.abs((scheduledStopAt(root) ?? 0) - (Date.now() + 7_200_000)) < 5000);
  let cancel = await serveStopSchedule(root, { cancel: true });
  assert.equal(cancel.captured.status, 200);
  assert.equal((cancel.data as { message: string }).message, "scheduled stop cancelled");
  assert.equal(scheduledStopAt(root), undefined);
  cancel = await serveStopSchedule(root, { cancel: true });
  assert.equal((cancel.data as { message: string }).message, "no stop scheduled");
});

test("handleStopSchedule refuses a stopped team with 409 and writes no marker", async () => {
  const root = tmpdir();
  const { captured, data } = await serveStopSchedule(root, { inSeconds: 7200 });
  assert.equal(captured.status, 409);
  assert.match((data as { error: string }).error, /tumwater is not running/);
  assert.equal(scheduledStopAt(root), undefined);
});

test("handleStopSchedule rejects a missing, invalid, over-cap, or combined body with 400", async () => {
  const root = tmpdir();
  seedTeam(root, null);
  for (const body of [{}, { inSeconds: -1 }, { inSeconds: 8_000_000 }, { cancel: true, inSeconds: 60 }]) {
    const { captured } = await serveStopSchedule(root, body);
    assert.equal(captured.status, 400, JSON.stringify(body));
    assert.equal(scheduledStopAt(root), undefined, JSON.stringify(body));
  }
});

test("the live server routes POST /api/stop-schedule and refuses GET", async () => {
  const root = tmpdir();
  seedTeam(root, null);
  const { server, base } = await startLocalGui(root);
  try {
    const res = await fetch(base + "/api/stop-schedule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inSeconds: 3600 }),
    });
    assert.equal(res.status, 200);
    assert.notEqual(scheduledStopAt(root), undefined);
    assert.equal((await fetch(base + "/api/stop-schedule")).status, 404);
  } finally {
    server.close();
  }
});

function serveLogs(root: string, query = "") {
  return captureJson((res) => handleLogs(new URLSearchParams(query), res, root));
}

function serveHistory(root: string, query = "") {
  return captureJson((res) => handleHistory(new URLSearchParams(query), res, root));
}

test("handleLogs serves the matched tail oldest-first as feed items, composing grep and role", async () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: 1000, loop: "feature", type: "run_end", run: 1, result: "changed", summary: "added a thing" }, // retired-name-ok: legacy event field in a fixture
    { ts: 2000, loop: "bugfix", type: "merge_failed", commit: "abc1234", status: "rejected" }, // retired-name-ok: legacy event field in a fixture
    { ts: 3000, loop: "feature", type: "run_end", run: 2, result: "no_change", summary: "nothing here" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { captured, data } = await serveLogs(root, "?grep=added");
  const events = (data as { events: { ts: number; source: string; type: string; result?: string; message: string }[] }).events;
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  assert.deepEqual(events.map((e) => e.ts), [1000]);
  assert.deepEqual(events[0], {
    ts: 1000, source: "feature", type: "run_end", result: "changed",
    message: "run #1 merged — added a thing",
  });
  // The answer is exactly the shared computation: the scanned tail through eventMatchesGrep and
  // eventFeedItem — the one home each the CLI and the status payload also read (INV-A3).
  const tail = readEventsTailWithEnd(root, 500).events;
  assert.deepEqual(events, tail.filter((e) => eventMatchesGrep(e, "added")).map(eventFeedItem));
  assert.deepEqual(
    (statusPayload(root, 4000) as { eventItems: unknown[] }).eventItems,
    tail.map(eventFeedItem),
    "statusPayload's eventItems come from the same eventFeedItem projection",
  );
  // role is a filter and composes with grep: the merged failure is bugfix, so role=feature
  // drops it.
  const composed = await serveLogs(root, "?grep=land&role=feature");
  assert.deepEqual((composed.data as { events: unknown[] }).events, []);
  // An id with no events is a legitimate empty answer, not a 400 (the handleHistory rule).
  const none = await serveLogs(root, "?role=ghost");
  assert.equal(none.captured.status, 200);
  assert.deepEqual((none.data as { events: unknown[] }).events, []);
});

test("handleLogs ?sinceMs serves the trailing window's events, composing grep and role", async () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [
    { ts: now - 3 * 3600_000, loop: "feature", type: "run_end", run: 1, result: "changed", summary: "landed old" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 30 * 60_000, loop: "feature", type: "run_end", run: 2, result: "changed", summary: "landed new" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 20 * 60_000, loop: "bugfix", type: "run_end", run: 1, result: "changed", summary: "landed other" }, // retired-name-ok: legacy event field in a fixture
  ]);
  interface Answer { events: { ts: number }[]; covered: boolean; note: string }
  const all = await serveLogs(root, "?sinceMs=3600000");
  const answer = all.data as Answer;
  assert.equal(all.captured.status, 200);
  assert.deepEqual(answer.events.map((e) => e.ts), [now - 30 * 60_000, now - 20 * 60_000]);
  assert.equal(answer.covered, true);
  assert.equal(answer.note, "");
  const feature = await serveLogs(root, "?sinceMs=3600000&role=feature");
  assert.deepEqual((feature.data as Answer).events.map((e) => e.ts), [now - 30 * 60_000]);
  const other = await serveLogs(root, "?sinceMs=3600000&grep=other");
  assert.deepEqual((other.data as Answer).events.map((e) => e.ts), [now - 20 * 60_000]);
});

test("handleLogs' ?untilMs drops the window's newer events", async () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [
    { ts: now - 3 * 3600_000, loop: "feature", type: "run_end", run: 1, result: "changed", summary: "landed old" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 30 * 60_000, loop: "feature", type: "run_end", run: 2, result: "changed", summary: "landed new" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 20 * 60_000, loop: "bugfix", type: "run_end", run: 1, result: "changed", summary: "landed other" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 5 * 60_000, loop: "bugfix", type: "run_end", run: 2, result: "changed", summary: "landed newest" }, // retired-name-ok: legacy event field in a fixture
  ]);
  interface Answer { events: { ts: number }[]; covered: boolean; note: string }
  const all = await serveLogs(root, "?sinceMs=3600000&untilMs=600000");
  const answer = all.data as Answer;
  assert.equal(all.captured.status, 200);
  assert.deepEqual(answer.events.map((e) => e.ts), [now - 30 * 60_000, now - 20 * 60_000]);
  assert.equal(answer.covered, true);
  assert.equal(answer.note, "");
  const bugfix = await serveLogs(root, "?sinceMs=3600000&untilMs=600000&role=bugfix");
  assert.deepEqual((bugfix.data as Answer).events.map((e) => e.ts), [now - 20 * 60_000]);
  const cases: [string, RegExp][] = [
    ["?untilMs=600000", /requires sinceMs/],
    ["?n=5&untilMs=600000", /requires sinceMs/],
    ["?sinceMs=600000&untilMs=600000", /must be shorter than sinceMs/],
  ];
  for (const [query, err] of cases) {
    const bad = await serveLogs(root, query);
    assert.equal(bad.captured.status, 400, query);
    assert.match(JSON.stringify(bad.data), err, query);
  }
});

test("handleLogs refuses sinceMs with n, a malformed sinceMs, and one over the cap", async () => {
  const root = tmpdir();
  writeEvents(root, []);
  const rival = await serveLogs(root, "?sinceMs=3600000&n=5");
  assert.equal(rival.captured.status, 400);
  assert.match(JSON.stringify(rival.data), /rival shapes/);
  assert.equal((await serveLogs(root, "?sinceMs=abc")).captured.status, 400);
  assert.equal((await serveLogs(root, "?sinceMs=0")).captured.status, 400);
  const over = await serveLogs(root, `?sinceMs=${LOGS_SINCE_MAX_MS + 1}`);
  assert.equal(over.captured.status, 400);
  assert.match(JSON.stringify(over.data), /capped at/);
});

test("handleLogs bounds the scanned tail by n, defaults it, and rejects a bad n", async () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: 1000, loop: "feature", type: "run_end", run: 1, result: "changed", summary: "match me" }, // retired-name-ok: legacy event field in a fixture
    { ts: 2000, loop: "feature", type: "run_end", run: 2, result: "changed", summary: "later one" }, // retired-name-ok: legacy event field in a fixture
    { ts: 3000, loop: "feature", type: "run_end", run: 3, result: "changed", summary: "latest one" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const scan = await serveLogs(root, "?grep=match&n=2");
  assert.deepEqual((scan.data as { events: unknown[] }).events, [], "the match is older than the last 2 events");
  const zero = await serveLogs(root, "?grep=match&n=0");
  assert.deepEqual((zero.data as { events: unknown[] }).events, [], "n=0 clamps to scanning one event");
  const defaulted = await serveLogs(root, "?grep=match");
  assert.equal((defaulted.data as { events: { ts: number }[] }).events.length, 1, "absent n scans the default 500");
  const bad = await serveLogs(root, "?n=-1");
  assert.equal(bad.captured.status, 400);
});

test("the live server routes GET /api/logs to the slice handler", async () => {
  const root = tmpdir();
  writeEvents(root, [{ ts: 1000, loop: "feature", type: "run_end", run: 1, result: "changed", summary: "routed" }]); // retired-name-ok: legacy event field in a fixture
  const { server, base } = await startLocalGui(root);
  try {
    const res = await fetch(base + "/api/logs?n=10&role=feature");
    assert.equal(res.status, 200);
    const data = (await res.json()) as { events: { source: string; message: string }[] };
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0]?.source, "feature");
    assert.match(data.events[0]?.message ?? "", /routed/);
  } finally {
    server.close();
  }
});

test("handleDoctor answers the run's DoctorReport and passes it the root", async () => {
  const report = { header: "h", checks: [{ name: "Node", level: "ok" as const, detail: "d" }], routing: [], verdict: "v" };
  let seen = "";
  const out = await captureJson((res) => handleDoctor(res, "/some/root", async (r) => ((seen = r), report)));
  assert.equal(out.captured.status, 200);
  assert.deepEqual(JSON.parse(out.captured.body as string), report);
  assert.equal(seen, "/some/root");
});

test("the live server routes GET /api/doctor to the doctor report", async () => {
  const { server, base } = await startLocalGui(tmpdir());
  try {
    const res = await fetch(base + "/api/doctor");
    assert.equal(res.status, 200);
    const d = (await res.json()) as { header: unknown; verdict: unknown; checks: { name: unknown; level: string; detail: unknown }[] };
    assert.equal(typeof d.header, "string");
    assert.equal(typeof d.verdict, "string");
    assert.ok(Array.isArray(d.checks));
    for (const c of d.checks) {
      assert.equal(typeof c.name, "string");
      assert.ok(["ok", "warn", "fail"].includes(c.level));
      assert.equal(typeof c.detail, "string");
    }
  } finally {
    server.close();
  }
});

test("handleHistory ?summary folds the served rows into an additive per-role summary", async () => {
  const root = tmpdir();
  const now = Date.now();
  // All timestamps sit inside the last hour, so both the count arm and a 1h trailing window
  // hold every row. The two changes-class runs are at 50m (feature) and 15m (clean) ago, so
  // the newest change is clean's, at now - 900_000.
  writeEvents(root, [
    { ts: now - 3_000_000, loop: "feature", type: "run_end", run: 1, result: "changed", summary: "a", tokens: 100, costUsd: 0.01 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 1_800_000, loop: "feature", type: "run_end", run: 2, result: "no_change", summary: "b", tokens: 200, costUsd: 0.02 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 900_000, loop: "clean", type: "run_end", run: 1, result: "changed", summary: "c", tokens: 300, costUsd: 0.03 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 300_000, loop: "clean", type: "run_end", run: 2, result: "error", summary: "d", tokens: 400, costUsd: 0.04 }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { captured, data } = await serveHistory(root, "?n=50&summary=1");
  assert.equal(captured.status, 200);
  const { rows, summary } = data as {
    rows: Parameters<typeof summarizeRunRows>[0];
    summary: { roles: { role: string; lastChangeTs: number | null }[]; total: { runs: number; changes: number; none: number; refused: number; problems: number; tokens: number; costUsd: number; lastChangeTs: number } };
  };
  assert.equal(rows.length, 4);
  // The summary folds the exact served rows through the shared collector, so it can never
  // disagree with the table it scrolls beside (`history --summary`'s own tally).
  assert.deepEqual(summary, summarizeRunRows(rows));
  assert.deepEqual(summary.roles.map((l) => l.role), ["clean", "feature"]);
  assert.equal(summary.total.runs, 4);
  assert.equal(summary.total.changes, 2);
  assert.equal(summary.total.none, 1);
  assert.equal(summary.total.problems, 1);
  assert.equal(summary.total.tokens, 1000);
  assert.equal(summary.total.lastChangeTs, now - 900_000, "the newest changes-class run across every role");
  assert.equal(summary.roles[0]?.lastChangeTs, now - 900_000, "clean changed only at 15m ago");
  assert.equal(summary.roles[1]?.lastChangeTs, now - 3_000_000, "feature changed only at 50m ago");
  // The count shape without the flag is today's byte-for-byte: no summary key.
  const bare = await serveHistory(root, "?n=50");
  assert.ok(!("summary" in (bare.data as object)));
  assert.deepEqual((bare.data as { rows: Parameters<typeof summarizeRunRows>[0] }).rows, rows);
  // A bad summary value counts as the flag present (its mere presence triggers it).
  const blank = await serveHistory(root, "?n=50&summary=");
  assert.ok("summary" in (blank.data as object), "an empty value still counts as the flag present");
  // The trailing-window arm folds the same way, riding { rows, covered, note }.
  const win = await serveHistory(root, "?sinceMs=3600000&summary=1");
  const wdata = win.data as { rows: Parameters<typeof summarizeRunRows>[0]; covered: boolean; note: string; summary: { total: { runs: number } } };
  assert.equal(wdata.rows.length, 4);
  assert.equal(wdata.summary.total.runs, 4);
  assert.deepEqual(wdata.summary, summarizeRunRows(wdata.rows));
});

test("handleHistory's ?untilMs drops the window's newer rows", async () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [
    { ts: now - 30 * 60 * 1000, loop: "clean", type: "run_start", run: 9 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 20 * 60 * 1000, loop: "clean", type: "run_end", run: 9, result: "changed" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 5 * 60 * 1000, loop: "feature", type: "run_end", run: 1, result: "changed" }, // retired-name-ok: legacy event field in a fixture
  ].map((e) => JSON.stringify(e)));
  const win = await serveHistory(root, "?sinceMs=7200000&untilMs=600000");
  assert.equal(win.captured.status, 200);
  const rows = (win.data as { rows: { role: string; run: number }[] }).rows;
  assert.deepEqual(rows, readRunRowsSince(root, 7200000, null, 600000).rows);
  assert.deepEqual(rows.map((r) => [r.role, r.run]), [["clean", 9]]);
  for (const qs of ["?n=20&untilMs=600000", "?untilMs=600000"]) {
    const r = await serveHistory(root, qs);
    assert.equal(r.captured.status, 400, qs);
    assert.match((r.data as { error: string }).error, /requires sinceMs/, qs);
  }
  assert.equal((await serveHistory(root, "?sinceMs=600000&untilMs=600000")).captured.status, 400);
});

test("handleHistory ?summary also folds the served rows per model", async () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [
    { ts: now - 3_000_000, loop: "feature", type: "run_start", run: 1, model: "m-b" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 2_990_000, loop: "feature", type: "run_end", run: 1, result: "changed", summary: "a", tokens: 100, costUsd: 0.01 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 1_800_000, loop: "clean", type: "run_start", run: 1, model: "m-a" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 1_790_000, loop: "clean", type: "run_end", run: 1, result: "no_change", summary: "b", tokens: 200, costUsd: 0.02 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 300_000, loop: "qa", type: "run_end", run: 1, result: "error", summary: "c", tokens: 50, costUsd: 0.01 }, // retired-name-ok: legacy event field in a fixture
  ]);
  type Rows = Parameters<typeof summarizeRunRowsByModel>[0];
  interface Body { rows: Rows; modelSummary: { models: { model: string | null }[] } }
  const count = (await serveHistory(root, "?n=50&summary=1")).data as Body;
  assert.equal(count.rows.length, 3);
  assert.deepEqual(count.modelSummary, summarizeRunRowsByModel(count.rows));
  assert.deepEqual(count.modelSummary.models.map((m) => m.model), ["m-a", "m-b", null], "the null bucket is last");
  const win = (await serveHistory(root, "?sinceMs=3600000&summary=1")).data as Body;
  assert.deepEqual(win.modelSummary, summarizeRunRowsByModel(win.rows));
  const bare = await serveHistory(root, "?n=50");
  assert.ok(!("modelSummary" in (bare.data as object)));
});

test("handleHistory ?model keeps exact selectors in both shapes, before the summaries fold", async () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [
    { ts: now - 3_000_000, loop: "feature", type: "run_start", run: 1, model: "m-b" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 2_990_000, loop: "feature", type: "run_end", run: 1, result: "changed", summary: "a", tokens: 100, costUsd: 0.01 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 1_800_000, loop: "clean", type: "run_start", run: 1, model: "m-a" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 1_790_000, loop: "clean", type: "run_end", run: 1, result: "no_change", summary: "b", tokens: 200, costUsd: 0.02 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 300_000, loop: "qa", type: "run_end", run: 1, result: "error", summary: "c", tokens: 50, costUsd: 0.01 }, // retired-name-ok: legacy event field in a fixture
  ]);
  type Rows = Parameters<typeof summarizeRunRowsByModel>[0];
  interface Body { rows: Rows & { role: string }[]; modelSummary: unknown }
  const get = async (q: string) => (await serveHistory(root, q)).data as Body;
  assert.deepEqual((await get("?n=50&model=m-a")).rows.map((r) => r.role), ["clean"]);
  const two = await get("?n=50&model=m-a,m-b&summary=1");
  assert.equal(two.rows.length, 2);
  assert.deepEqual(two.modelSummary, summarizeRunRowsByModel(two.rows));
  assert.deepEqual((await get("?sinceMs=3600000&model=m-a")).rows.map((r) => r.role), ["clean"]);
  assert.equal((await get("?n=50&model=")).rows.length, 3);
  assert.equal((await get("?n=50&model=,")).rows.length, 3);
  const none = await serveHistory(root, "?n=50&model=nope");
  assert.equal(none.captured.status, 200);
  assert.deepEqual((none.data as Body).rows, []);
});

test("handleHistory ?result keeps outcome classes in both shapes, before model and the summaries fold", async () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [
    { ts: now - 3_000_000, loop: "feature", type: "run_start", run: 1, model: "m-b" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 2_990_000, loop: "feature", type: "run_end", run: 1, result: "changed", summary: "a", tokens: 100, costUsd: 0.01 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 1_800_000, loop: "clean", type: "run_start", run: 1, model: "m-a" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 1_790_000, loop: "clean", type: "run_end", run: 1, result: "no_change", summary: "b", tokens: 200, costUsd: 0.02 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 300_000, loop: "qa", type: "run_end", run: 1, result: "error", summary: "c", tokens: 50, costUsd: 0.01 }, // retired-name-ok: legacy event field in a fixture
  ]);
  type Rows = Parameters<typeof summarizeRunRows>[0];
  interface Body { rows: (Rows[number] & { role: string })[]; summary: unknown; error?: string }
  const get = async (q: string) => (await serveHistory(root, q)).data as Body;
  const roles = async (q: string) => (await get(q)).rows.map((r) => r.role).sort();
  assert.deepEqual(await roles("?n=50&result=problems"), ["qa"]);
  assert.deepEqual(await roles("?n=50&result=merged,none"), ["clean", "feature"]);
  assert.deepEqual(await roles("?sinceMs=3600000&result=none"), ["clean"]);
  const composed = await serveHistory(root, "?n=50&result=merged&model=m-a");
  assert.equal(composed.captured.status, 200);
  assert.deepEqual((composed.data as Body).rows, []);
  const folded = await get("?n=50&result=none&summary=1");
  assert.deepEqual(folded.summary, summarizeRunRows(folded.rows));
  assert.equal((await get("?n=50&result=")).rows.length, 3);
  assert.equal((await get("?n=50&result=,")).rows.length, 3);
  for (const q of ["?n=50&result=bogus", "?sinceMs=3600000&result=bogus"]) {
    const bad = await serveHistory(root, q);
    assert.equal(bad.captured.status, 400);
    assert.match((bad.data as Body).error ?? "", /result must be one of/);
  }
});

function serveRun(root: string, query: string) {
  return captureJson((res) => handleRun(new URLSearchParams(query), res, root));
}

test("handleRun serves one run's collector payload plus its pre-rendered text", async () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: 1_000, loop: "clean", type: "run_start", run: 3 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: 2_000, loop: "clean", type: "review_verdict", verdict: "approve" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: 47_000, loop: "clean", type: "run_end", run: 3, result: "changed", summary: "tidy up", tokens: 500, costUsd: 0.25 }), // retired-name-ok: legacy event field in a fixture
    // Another role's same-numbered run must not leak into clean's block.
    JSON.stringify({ ts: 48_000, loop: "feature", type: "run_end", run: 3, result: "no_change" }), // retired-name-ok: legacy event field in a fixture
  ]);
  const { captured, data } = await serveRun(root, "?role=clean&run=3");
  const detail = readRunDetail(root, "clean", 3);
  assert.ok(detail);
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  // The payload is the collector's own — the same object `tumwater history <role> <n> --json`
  // prints — plus `text`, the renderRunDetail rendering the browser shows instead of
  // re-formatting events.
  assert.deepEqual(data, { ...detail, text: renderRunDetail(detail!), stat: "(no commit: this run sent nothing to merge)", revertSha: null, hasCommit: false });
  const d = data as RunDetail & { text: string };
  assert.equal(d.durationMs, 46_000, "duration pairs the run's own run_start");
  assert.deepEqual(d.events.map((e) => e.type), ["run_start", "review_verdict", "run_end"]);
  assert.match(d.text, /^clean run #3 — merged · 46s/);
  assert.match(d.text, /tidy up/);
});

test("handleRun serves a reverted run's culprit as reverted.sha", async () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: 1_000, loop: "clean", type: "run_start", run: 3 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: 1_500, loop: "clean", source: "clean", type: "merged", commit: "landed1" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: 2_000, loop: "clean", type: "run_end", run: 3, result: "changed", summary: "tidy up" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: 4_000, source: "tumwater", loop: "tumwater", type: "operator_revert", commit: "landed1", revert: "rev1", runner: "clean", failingTests: ["a.test.ts"] }), // retired-name-ok: legacy event field in a fixture
  ]);
  const { data } = await serveRun(root, "?role=clean&run=3");
  assert.equal((data as RunDetail).reverted?.sha, "landed1");
  assert.equal((data as RunDetail).reverted?.failingTests[0], "a.test.ts");
});

test("handleRun ?last serves the newest run, narrowed by result and model", async () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: 1_000, source: "clean", type: "run_start", run: 3, model: "m-a" },
    { ts: 2_000, source: "clean", type: "run_end", run: 3, result: "changed" },
    { ts: 3_000, source: "clean", type: "run_start", run: 4, model: "m-b" },
    { ts: 4_000, source: "clean", type: "run_end", run: 4, result: "error" },
    { ts: 5_000, source: "feature", type: "run_end", run: 5, result: "no_change" },
  ].map((e) => JSON.stringify(e)));
  const runOf = async (query: string) => ((await serveRun(root, query)).data as { run: number }).run;
  const newest = await serveRun(root, "?role=clean&last=1");
  assert.equal(newest.captured.status, 200);
  assert.equal((newest.data as { run: number }).run, 4);
  assert.deepEqual(newest.data, (await serveRun(root, "?role=clean&run=4")).data);
  assert.equal(await runOf("?role=clean&last=1&result=merged"), 3);
  assert.equal(await runOf("?role=clean&last=1&result=changes"), 3);
  assert.equal(await runOf("?role=clean&last=1&result=problems"), 4);
  assert.equal(await runOf("?role=clean&last=1&model=m-a"), 3);
  assert.equal(await runOf("?role=clean&last=1&result="), 4);
  const miss = await serveRun(root, "?role=clean&last=1&model=m-b&result=merged");
  assert.equal(miss.captured.status, 404);
  assert.equal((miss.data as { error: string }).error, runNotFoundLastMessage("clean", ["changes"], ["m-b"]));
  const bogus = await serveRun(root, "?role=clean&last=1&result=bogus");
  assert.equal(bogus.captured.status, 400);
  assert.match((bogus.data as { error: string }).error, /result must be one of/);
  assert.match((bogus.data as { error: string }).error, /got "bogus"/);
  for (const q of ["?role=clean&last=1&run=3", "?role=clean&run=3&result=changes", "?role=clean&run=3&model=m-a"]) {
    assert.equal((await serveRun(root, q)).captured.status, 400, q);
  }
  const unknown = await serveRun(root, "?role=nope&last=1");
  assert.equal(unknown.captured.status, 400);
  assert.match((unknown.data as { error: string }).error, /unknown role "nope"/);
  const none = await serveRun(root, "?role=steward&last=1");
  assert.equal(none.captured.status, 404);
  assert.match((none.data as { error: string }).error, /no completed run for steward/);
});

test("handleRun ?last with no role serves the newest run of any role", async () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: 1_000, source: "clean", type: "run_start", run: 3, model: "m-a" },
    { ts: 2_000, source: "clean", type: "run_end", run: 3, result: "changed" },
    { ts: 3_000, source: "clean", type: "run_start", run: 4, model: "m-b" },
    { ts: 4_000, source: "clean", type: "run_end", run: 4, result: "error" },
    { ts: 5_000, source: "feature", type: "run_end", run: 5, result: "no_change" },
  ].map((e) => JSON.stringify(e)));
  const pick = async (query: string) => (await serveRun(root, query)).data as { role: string; run: number };
  const newest = await serveRun(root, "?last=1");
  assert.equal(newest.captured.status, 200);
  assert.deepEqual(await pick("?last=1").then((d) => [d.role, d.run]), ["feature", 5]);
  assert.deepEqual(newest.data, (await serveRun(root, "?role=feature&run=5")).data);
  assert.deepEqual(await pick("?last=1&result=problems").then((d) => [d.role, d.run]), ["clean", 4]);
  assert.deepEqual(await pick("?last=1&model=m-a").then((d) => [d.role, d.run]), ["clean", 3]);
  const miss = await serveRun(root, "?last=1&model=m-b&result=merged");
  assert.equal(miss.captured.status, 404);
  assert.equal((miss.data as { error: string }).error, runNotFoundLastMessage(null, ["changes"], ["m-b"]));
  const bogus = await serveRun(root, "?last=1&result=bogus");
  assert.equal(bogus.captured.status, 400);
  assert.match((bogus.data as { error: string }).error, /result must be one of/);
  assert.equal((await serveRun(root, "?last=1&run=3")).captured.status, 400);
});

test("handleRun's stat names a pinned commit that is not in the repository", async () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: 1_000, loop: "clean", type: "run_start", run: 3 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: 2_000, loop: "clean", type: "merge_queued", commit: "abcdef1234567890abcdef1234567890abcdef12" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: 3_000, loop: "clean", type: "run_end", run: 3, result: "changed" }), // retired-name-ok: legacy event field in a fixture
  ]);
  const { data } = await serveRun(root, "?role=clean&run=3");
  assert.match((data as { stat: string }).stat, /^\(commit [0-9a-f]+ is not in this repository\)$/);
});

test("handleRun's error cases: role and run 400s, a missed run 404", async () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: 1_000, loop: "clean", type: "run_start", run: 3 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: 2_000, loop: "clean", type: "run_end", run: 3, result: "no_change" }), // retired-name-ok: legacy event field in a fixture
  ]);
  // The role is a target here, not a filter: missing and unknown are 400s naming the valid ids.
  assert.equal((await serveRun(root, "?run=3")).captured.status, 400);
  const unknown = await serveRun(root, "?role=nope&run=3");
  assert.equal(unknown.captured.status, 400);
  assert.match((unknown.data as { error: string }).error, /unknown role "nope"/);
  // The run is an explicit count: required, and a positive integer through intQuery.
  assert.equal((await serveRun(root, "?role=clean")).captured.status, 400);
  for (const bad of ["abc", "0", "-5", "1e3"]) {
    const r = await serveRun(root, `?role=clean&run=${bad}`);
    assert.equal(r.captured.status, 400, `run=${bad} → 400`);
    assert.match((r.data as { error: string }).error, /run must be a positive integer/);
  }
  // A run the scanned window does not hold — never ran, or rotation ate it — is a not-found
  // status with the CLI's wording, not a crash.
  const missing = await serveRun(root, "?role=clean&run=9");
  assert.equal(missing.captured.status, 404);
  assert.match((missing.data as { error: string }).error, /no run #9 for clean in the scanned window/);
  for (const r of [unknown, missing]) assert.equal("stat" in (r.data as object), false, "error bodies carry no stat");
});

function serveRole(root: string, query: string) {
  return captureJson((res) => handleRole(new URLSearchParams(query), res, root));
}

test("handleRole serves a role's notes and next prompt, refusing a missing or unknown role", async () => {
  const root = tmpdir();
  // A notes written by the role's own earlier run — the text the drawer's Notes
  // section must show verbatim.
  const notes = roleNotesPath(root, "feature");
  writeFileDeep(notes, "the scheduler lives in team.ts\n");

  const { captured, data } = await serveRole(root, "?role=feature");
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  // The body is rolePayload's own collection — the note and the assembled next prompt
  // `tumwater role <id>` renders — so the dashboard and the CLI cannot drift.
  const payload = rolePayload(root, "feature");
  const d = data as { notes: string | null; nextPrompt: string | null };
  assert.equal(d.notes, payload.notes);
  assert.equal(d.notes, "the scheduler lives in team.ts\n");
  assert.equal(d.nextPrompt, payload.nextPrompt);
  assert.match(d.nextPrompt ?? "", /Implement the SINGLE most valuable planned feature in PLANS\.md/);

  // The role is a target, not a filter: a missing or unknown id is rejectBadRole's 400.
  const missing = await serveRole(root, "");
  assert.equal(missing.captured.status, 400);
  assert.match((missing.data as { error: string }).error, /^role required \(valid ids: /);
  const unknown = await serveRole(root, "?role=nope");
  assert.equal(unknown.captured.status, 400);
  assert.match((unknown.data as { error: string }).error, /^unknown role "nope"/);
});

test("consumeRestartRequest forces the redeployer once and removes the marker", () => {
  const root = tmpdir();
  let forced = 0;
  writeJsonFile(restartRequestPath(root), { at: Date.now() });
  consumeRestartRequest(root, { forceRestart: () => void forced++ });
  assert.equal(forced, 1);
  assert.equal(fs.existsSync(restartRequestPath(root)), false, "consumed");
  consumeRestartRequest(root, { forceRestart: () => void forced++ });
  assert.equal(forced, 1, "no marker, no force");
  consumeRestartRequest(root, null);
  assert.equal(forced, 1, "no redeployer (a non-self-hosting team): the marker is still cleaned up");
  assert.equal(fs.existsSync(restartRequestPath(root)), false);
});

// The Settings view's endpoints (the curated keys, 2026-10-02): GET /api/config
// reads through the same load path `tumwater config get` uses; POST /api/config-set writes
// through setConfigKey, so the browser cannot drift from the CLI's rules.

function serveConfig(root: string) {
  return captureJson((res) => handleConfig(res, root));
}

function serveConfigSet(root: string, body: unknown) {
  return captureJson((res) => handleConfigSet(fakeReq(JSON.stringify(body)), res, root));
}

function serveConfigUnset(root: string, body: unknown) {
  return captureJson((res) => handleConfigUnset(fakeReq(JSON.stringify(body)), res, root));
}

test("handleConfig returns exactly the curated keys, resolved values with null for unset", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { model: "gpt-5", quietHours: "23:00-07:00", customRoles: [{ name: "watch", task: "watch" }], check: { command: "npm test" } });
  const { captured, data } = await serveConfig(root);
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  assert.deepEqual(Object.keys(data as Record<string, unknown>).sort(), [...EDITABLE_CONFIG_KEYS].sort());
  const cfg = data as Record<string, unknown>;
  assert.equal(cfg.model, "gpt-5");
  assert.equal(cfg.quietHours, "23:00-07:00");
  assert.equal(cfg.provider, null);
  assert.equal(cfg.fallback, null);
  // maxDailyCostUsd resolves to loadConfig's default cap (50) when the file does not set it.
  assert.equal(cfg.maxDailyCostUsd, 50);
  assert.equal(cfg.notify, null);
  // agents resolves to the default empty map when the file names none.
  assert.deepEqual(cfg.backends, {});
  // The declared check serves its file value (an object), null when unset.
  assert.deepEqual(cfg.check, { command: "npm test" });
  const unsetRoot = tmpdir();
  writeJsonFile(configPath(unsetRoot), { model: "gpt-5" });
  const unsetServed = await serveConfig(unsetRoot);
  assert.equal((unsetServed.data as Record<string, unknown>).check, null);
  // The run-concurrency knobs: maxConcurrent resolves to loadConfig's default (6) when the
  // file does not set it, and the optional worktreeSlots reads null.
  assert.equal(cfg.maxConcurrent, 6);
  assert.equal(cfg.worktreeSlots, null);
  // customRoles is deliberately not served: the panel's reach is the curated set.
  assert.equal("customRoles" in cfg, false);
});

test("handleConfig answers 500 with validateConfig's message on a broken tumwater.json", async () => {
  const root = tmpdir();
  fs.writeFileSync(configPath(root), "{ not json");
  const { captured, data } = await serveConfig(root);
  assert.equal(captured.status, 500);
  assert.match((data as { error: string }).error, /./); // an actionable message, not an empty body
});

test("handleConfigSet round-trips: set, then GET shows the new value and the file holds it", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { maxDailyCostUsd: 25 });
  const { captured, data } = await serveConfigSet(root, { key: "maxDailyCostUsd", value: 30 });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, key: "maxDailyCostUsd", value: 30, oldValue: 25 });
  const after = await serveConfig(root);
  assert.equal((after.data as Record<string, unknown>).maxDailyCostUsd, 30);
  // The file on disk is what the running team polls — the write went through setConfigKey.
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal(onDisk.maxDailyCostUsd, 30);
});

test("handleConfigSet writes the run-concurrency knobs and refuses a type-invalid value byte-identically", async () => {
  const root = tmpdir();
  const runOne = await serveConfigSet(root, { key: "maxConcurrent", value: 8 });
  assert.equal(runOne.captured.status, 200);
  assert.deepEqual(runOne.data, { ok: true, key: "maxConcurrent", value: 8, oldValue: 6 });
  const slots = await serveConfigSet(root, { key: "worktreeSlots", value: 9 });
  assert.equal(slots.captured.status, 200);
  assert.deepEqual(slots.data, { ok: true, key: "worktreeSlots", value: 9 });
  assert.equal("oldValue" in (slots.data as Record<string, unknown>), false, "the file never held worktreeSlots, so JSON omits the undefined oldValue");
  // The file on disk holds each under its top-level key, polled live by the running team
  // (max_concurrent_changed / worktree_slots_changed).
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal(onDisk.maxConcurrent, 8);
  assert.equal(onDisk.worktreeSlots, 9);
  // A type-invalid value and a negative worktreeSlots return the shared validator's 400 and
  // leave the file byte-identical to what the successful writes produced.
  const before = fs.readFileSync(configPath(root), "utf8");
  const bad = await serveConfigSet(root, { key: "maxConcurrent", value: "many" });
  assert.equal(bad.captured.status, 400);
  assert.match((bad.data as { error: string }).error, /maxConcurrent/);
  const neg = await serveConfigSet(root, { key: "worktreeSlots", value: -1 });
  assert.equal(neg.captured.status, 400);
  assert.match((neg.data as { error: string }).error, /worktreeSlots/);
  assert.equal(fs.readFileSync(configPath(root), "utf8"), before, "the refused writes leave the file byte-identical");
  // POST /api/config-unset clears each file override; unsetting maxConcurrent re-serializes
  // the merged config with its default (6) filled in, while the optional worktreeSlots drops out.
  await serveConfigUnset(root, { key: "maxConcurrent" });
  await serveConfigUnset(root, { key: "worktreeSlots" });
  const after = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal(after.maxConcurrent, 6, "the file reverted maxConcurrent to the default");
  assert.equal("worktreeSlots" in after, false);
  const served = await serveConfig(root);
  assert.equal((served.data as Record<string, unknown>).maxConcurrent, 6);
  assert.equal((served.data as Record<string, unknown>).worktreeSlots, null);
});

test("handleConfigSet writes the declared check and refuses an invalid one byte-identically", async () => {
  const root = tmpdir();
  const ok = await serveConfigSet(root, { key: "check", value: { command: "npm test" } });
  assert.equal(ok.captured.status, 200);
  assert.deepEqual(ok.data, { ok: true, key: "check", value: { command: "npm test" } });
  // The file on disk holds the object, polled live by the running team; GET serves it back.
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.deepEqual(onDisk.check, { command: "npm test" });
  const served = await serveConfig(root);
  assert.deepEqual((served.data as Record<string, unknown>).check, { command: "npm test" });
  // A value validateConfig refuses (command not a non-blank string) answers 400 and leaves the
  // file byte-identical — the same whole-candidate write path every other curated key uses.
  const before = fs.readFileSync(configPath(root), "utf8");
  const bad = await serveConfigSet(root, { key: "check", value: { command: 42 } });
  assert.equal(bad.captured.status, 400);
  assert.equal(fs.readFileSync(configPath(root), "utf8"), before, "the refused write leaves the file byte-identical");
  // POST /api/config-unset removes it; GET then serves null.
  await serveConfigUnset(root, { key: "check" });
  const afterUnset = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal("check" in afterUnset, false);
  const servedAfterUnset = await serveConfig(root);
  assert.equal((servedAfterUnset.data as Record<string, unknown>).check, null);
});

test("handleBudget refuses a finite-but-unrepresentable cap with the shared screen's message", async () => {
  // BUGS.md 2026-10-02: /api/budget is the browser surface for the same one-zero typo the
  // TUI's parseBudgetInput guards — 1e24 is finite, so the old checkDailyBudgetUsd admitted
  // it and the write made the daily spend cap effectively uncapped.
  const root = tmpdir();
  const { captured } = await captureJson((res) => handleBudget(fakeReq(JSON.stringify({ maxDailyCostUsd: 1e24 })), res, root));
  assert.equal(captured.status, 400);
  assert.match(captured.body, /at most 9007199254740991/);
  assert.match(captured.body, /got 1e\+24/);
  // The config file was never created by the refused write.
  assert.equal(fs.existsSync(configPath(root)), false);
});

function serveRoleCap(root: string, body: unknown) {
  return captureJson((res) => handleRoleCap(fakeReq(JSON.stringify(body)), res, root));
}

// POST /api/role-cap: the role drawer's per-role daily-cap editor, the endpoint the amber
// role-cap alert's Open-role drawer lands on. Writes through the CLI's own setConfigKey dotted
// path (per-key checkDailyBudgetUsd + whole-config validateConfig), so the browser cannot
// drift from `tumwater config set maxDailyCostUsdPerRole.<role>`; /api/budget is untouched.
test("handleRoleCap writes the role's cap through setConfigKey and answers 200", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { maxDailyCostUsd: 25 });
  const { captured, data } = await serveRoleCap(root, { role: "feature", maxDailyCostUsd: 2 });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, role: "feature", maxDailyCostUsd: 2 });
  // The file on disk is what the running team polls — the write went through setConfigKey.
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.maxDailyCostUsdPerRole as Record<string, unknown>).feature, 2);
});

test("handleRoleCap maps an instance id to its base role's cap", async () => {
  const root = tmpdir();
  const { captured, data } = await serveRoleCap(root, { role: "feature-2", maxDailyCostUsd: 4 });
  assert.equal(captured.status, 200);
  // The cap is about the role, so a bare role id writes the base role's key.
  assert.deepEqual(data, { ok: true, role: "feature", maxDailyCostUsd: 4 });
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.maxDailyCostUsdPerRole as Record<string, unknown>).feature, 4);
});

test("handleRoleCap rejects a bad value, the director, an unknown role, and a missing field", async () => {
  const root = tmpdir();
  // A negative value is refused with the per-role dotted key named.
  const neg = await serveRoleCap(root, { role: "feature", maxDailyCostUsd: -1 });
  assert.equal(neg.captured.status, 400);
  assert.match((neg.data as { error: string }).error, /maxDailyCostUsdPerRole\.feature/);
  // A non-number value is refused the same way.
  const nan = await serveRoleCap(root, { role: "feature", maxDailyCostUsd: "two" });
  assert.equal(nan.captured.status, 400);
  assert.match((nan.data as { error: string }).error, /maxDailyCostUsdPerRole\.feature/);
  // The director has no cap.
  const dir = await serveRoleCap(root, { role: "director", maxDailyCostUsd: 2 });
  assert.equal(dir.captured.status, 400);
  assert.match((dir.data as { error: string }).error, /the director has no daily cap/);
  assert.doesNotMatch((dir.data as { error: string }).error, /maxDailyCostUsdPerRole/);
  // An unknown role id is refused through validateConfig, writing nothing.
  const unknown = await serveRoleCap(root, { role: "nope", maxDailyCostUsd: 2 });
  assert.equal(unknown.captured.status, 400);
  assert.equal(fs.existsSync(configPath(root)), false, "a refused write never creates the file");
  // A missing role or value is refused.
  const noRole = await serveRoleCap(root, { maxDailyCostUsd: 2 });
  assert.equal(noRole.captured.status, 400);
  const noValue = await serveRoleCap(root, { role: "feature" });
  assert.equal(noValue.captured.status, 400);
});

function serveRoleInstructions(root: string, body: unknown) {
  return captureJson((res) => handleRoleInstructions(fakeReq(JSON.stringify(body)), res, root));
}

// POST /api/role-instructions: the role drawer's standing-instructions editor. Writes through
// the CLI's own setConfigKey/unsetConfigKey, so an empty text clears (like --clear-instructions)
// and validateConfig owns the 4096-char cap; an instance id maps to its base role's override;
// the director is editable here (its override reaches its runs), unlike handleRoleNotes.
test("handleRoleInstructions writes the base role's override through setConfigKey and answers 200", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), {});
  const { captured, data } = await serveRoleInstructions(root, { role: "feature", text: "Prefer small plans." });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, role: "feature", message: "feature: instructions saved (19 chars)" });
  // The file on disk is what run-prompt reads — the write went through setConfigKey.
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  const rolesOnDisk = onDisk.roles as { feature: Record<string, unknown>; director: Record<string, unknown> };
  assert.equal(rolesOnDisk.feature.instructions, "Prefer small plans.");
});

test("handleRoleInstructions maps an instance id to its base role's override and the director is editable", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), {});
  const inst = await serveRoleInstructions(root, { role: "feature-2", text: "Say the version." });
  assert.equal(inst.captured.status, 200);
  // An instance id writes roles.feature.instructions (the key its runs carry).
  assert.deepEqual(inst.data, { ok: true, role: "feature", message: "feature: instructions saved (16 chars)" });
  // The director is editable here (its override reaches its runs), unlike handleRoleNotes.
  const dir = await serveRoleInstructions(root, { role: "director", text: "Be terse." });
  assert.equal(dir.captured.status, 200);
  assert.deepEqual(dir.data, { ok: true, role: "director", message: "director: instructions saved (9 chars)" });
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  const roles = onDisk.roles as { feature: Record<string, unknown>; director: Record<string, unknown> };
  assert.equal(roles.feature.instructions, "Say the version.");
  assert.equal(roles.director.instructions, "Be terse.");
});

test("handleRoleInstructions clears on empty text and rejects bad input without writing", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { feature: { instructions: "x" } } });
  const post = (body: unknown) => captureJson((res) => handleRoleInstructions(fakeReq(JSON.stringify(body)), res, root));
  // An empty or whitespace-only buffer removes the key (unsetConfigKey), like --clear-instructions.
  const cleared = await post({ role: "feature", text: "   " });
  assert.equal(cleared.captured.status, 200);
  assert.deepEqual(cleared.data, { ok: true, role: "feature", message: "feature: instructions cleared" });
  let onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.roles as { feature?: Record<string, unknown> } | undefined)?.feature?.instructions, undefined);
  // A non-string text is refused with the gotSuffix wording.
  const nonString = await post({ role: "feature", text: 5 });
  assert.equal(nonString.captured.status, 400);
  assert.match((nonString.data as { error: string }).error, /"text" must be a string/);
  // An over-cap text is refused 400 naming the dotted key, writing nothing.
  const tooLong = await post({ role: "feature", text: "a".repeat(ROLE_INSTRUCTIONS_MAX_CHARS + 1) });
  assert.equal(tooLong.captured.status, 400);
  assert.match((tooLong.data as { error: string }).error, new RegExp("roles\\.feature\\.instructions"));
  onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.roles as { feature?: Record<string, unknown> } | undefined)?.feature?.instructions, undefined, "a refused write never touches the file");
});

test("handleRoleInstructions refuses an unknown role id and creates no file", async () => {
  const root = tmpdir();
  const { captured } = await serveRoleInstructions(root, { role: "nope", text: "z" });
  assert.equal(captured.status, 400);
  assert.equal(fs.existsSync(configPath(root)), false, "a refused write never creates the file");
});

function serveRoleQuietHours(root: string, body: unknown) {
  return captureJson((res) => handleRoleQuietHours(fakeReq(JSON.stringify(body)), res, root));
}

// POST /api/role-quiet-hours: the role drawer's own-window editor. Writes through the CLI's
// own setConfigKey/unsetConfigKey, so an empty window clears (like --clear-quiet-hours) and
// checkQuietHours (naming quietHoursPerRole.<base>) plus validateConfig's unknown-role check
// own the truth; an instance id maps to its base role's key; the director is refused (its key
// is inert — roleQuietHold and doctor both exempt it), unlike handleRoleInstructions.
test("handleRoleQuietHours writes the role's own window through setConfigKey and answers 200", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), {});
  const { captured, data } = await serveRoleQuietHours(root, { role: "feature", window: "23:00-07:00" });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, role: "feature", message: "feature: quiet hours set to 23:00-07:00" });
  // The file on disk is what roleQuietHold reads — the write went through setConfigKey.
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.quietHoursPerRole as Record<string, unknown>).feature, "23:00-07:00");
});

test("handleRoleQuietHours maps an instance id to its base role's key", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { feature: { instances: 2 } } });
  const { captured, data } = await serveRoleQuietHours(root, { role: "feature-2", window: "23:00-07:00" });
  assert.equal(captured.status, 200);
  // The window governs the role, so a bare role id writes the base role's key.
  assert.deepEqual(data, { ok: true, role: "feature", message: "feature: quiet hours set to 23:00-07:00" });
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.quietHoursPerRole as Record<string, unknown>).feature, "23:00-07:00");
});

test("handleRoleQuietHours clears on an empty window and rejects bad input without writing", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { quietHoursPerRole: { feature: "23:00-07:00" } });
  const post = (body: unknown) => captureJson((res) => handleRoleQuietHours(fakeReq(JSON.stringify(body)), res, root));
  // An empty or whitespace-only window removes the key (unsetConfigKey), like --clear-quiet-hours.
  const cleared = await post({ role: "feature", window: "   " });
  assert.equal(cleared.captured.status, 200);
  assert.deepEqual(cleared.data, { ok: true, role: "feature", message: "feature: quiet hours cleared" });
  let onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.quietHoursPerRole as Record<string, unknown> | undefined)?.feature, undefined);
  // A non-string window is refused with the gotSuffix wording.
  const nonString = await post({ role: "feature", window: 5 });
  assert.equal(nonString.captured.status, 400);
  assert.match((nonString.data as { error: string }).error, /"window" must be a string/);
  // A malformed window is refused 400 naming the dotted key, writing nothing.
  for (const bad of ["nope", "23:00", "23:00-23:00"]) {
    const rejected = await post({ role: "feature", window: bad });
    assert.equal(rejected.captured.status, 400);
    assert.match((rejected.data as { error: string }).error, /quietHoursPerRole\.feature/);
  }
  onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.quietHoursPerRole as Record<string, unknown> | undefined)?.feature, undefined, "a refused write never touches the file");
});

test("handleRoleQuietHours refuses the director, an unknown role, and a missing field", async () => {
  const root = tmpdir();
  // The director has no quiet hours (its key is inert).
  const dir = await serveRoleQuietHours(root, { role: "director", window: "23:00-07:00" });
  assert.equal(dir.captured.status, 400);
  assert.match((dir.data as { error: string }).error, /the director has no quiet hours/);
  assert.doesNotMatch((dir.data as { error: string }).error, /quietHoursPerRole/);
  // An unknown role id is refused through validateConfig, writing nothing.
  const unknown = await serveRoleQuietHours(root, { role: "nope", window: "23:00-07:00" });
  assert.equal(unknown.captured.status, 400);
  assert.equal(fs.existsSync(configPath(root)), false, "a refused write never creates the file");
  // Clearing an unknown role is refused too — unsetConfigKey's no-op path would otherwise
  // clear nothing and report success, so the clear branch carries rejectBadRole's own 400.
  const unknownClear = await serveRoleQuietHours(root, { role: "nope", window: "" });
  assert.equal(unknownClear.captured.status, 400);
  assert.match((unknownClear.data as { error: string }).error, /unknown role "nope"/);
  assert.equal(fs.existsSync(configPath(root)), false, "a refused clear never creates the file");
  // A missing role or a missing/blank role is refused.
  const noRole = await serveRoleQuietHours(root, { window: "23:00-07:00" });
  assert.equal(noRole.captured.status, 400);
  assert.match((noRole.data as { error: string }).error, /role required/);
  const blankRole = await serveRoleQuietHours(root, { role: "  ", window: "23:00-07:00" });
  assert.equal(blankRole.captured.status, 400);
});

test("handleRoleQuietHours clearing a key the file never set writes nothing", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), {});
  const before = fs.readFileSync(configPath(root), "utf8");
  const { captured, data } = await serveRoleQuietHours(root, { role: "feature", window: "" });
  assert.equal(captured.status, 200);
  // Clearing an absent map entry is a no-op success — the file bytes stay identical.
  assert.equal(fs.readFileSync(configPath(root), "utf8"), before);
  assert.match((data as { message: string }).message, /is not set in tumwater\.json, so nothing was cleared/);
});
function serveRoleInterval(root: string, body: unknown) {
  return captureJson((res) => handleRoleInterval(fakeReq(JSON.stringify(body)), res, root));
}

// POST /api/role-model: the role drawer's Model overrides editor sets or clears one role's
// provider/model/thinking/backend set (roles.<base>.*) in one atomic write through
// setRoleModelFields — the per-role hold the Model row renders read-only. Same body
// discipline as /api/role-interval; a missing/blank role, a non-string field, or a body
// with none of the four is a 400; an instance id maps to its base role's keys; the
// director is accepted; a bad thinking level or an unknown backend id is refused naming
// roles.<base>.<field>; an unknown role is refused on the set and the no-op/clear path alike.
function serveRoleModel(root: string, body: unknown) {
  return captureJson((res) => handleRoleModel(fakeReq(JSON.stringify(body)), res, root));
}

test("handleRoleModel writes the triple through setRoleModelFields and answers 200", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { feature: { enabled: true } } });
  const { captured, data } = await serveRoleModel(root, { role: "feature", provider: "huggingface", model: "claude-opus-5", thinking: "high" });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, role: "feature", message: "feature: model updated" });
  // The file on disk is what the scheduler polls — the write went through setRoleModelFields.
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  const feat = (onDisk.roles as { feature: Record<string, unknown> }).feature;
  assert.equal(feat.enabled, true, "the entry's other fields preserved");
  assert.equal(feat.provider, "huggingface");
  assert.equal(feat.model, "claude-opus-5");
  assert.equal(feat.thinking, "high");
  // Clearing with empty strings removes all three in one write.
  const cleared = await serveRoleModel(root, { role: "feature", provider: "", model: "", thinking: "" });
  assert.equal(cleared.captured.status, 200);
  const after = readJson(configPath(root)) as Record<string, unknown>;
  const feat2 = (after.roles as { feature: Record<string, unknown> }).feature;
  assert.deepEqual(feat2, { enabled: true }, "all three overrides cleared, the entry's other fields kept");
});

test("handleRoleModel maps an instance id to its base role's keys and accepts the director", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { feature: { instances: 2 } } });
  const inst = await serveRoleModel(root, { role: "feature-2", provider: "huggingface", model: "opus" });
  assert.equal(inst.captured.status, 200);
  assert.deepEqual(inst.data, { ok: true, role: "feature", message: "feature: model updated" });
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  const feat = (onDisk.roles as { feature: Record<string, unknown> }).feature;
  assert.equal(feat.instances, 2, "the entry's other fields preserved");
  assert.equal(feat.provider, "huggingface");
  assert.equal(feat.model, "opus");
  // The director is accepted — configForRole resolves roles.director.* like any role's.
  const dir = await serveRoleModel(root, { role: "director", thinking: "low" });
  assert.equal(dir.captured.status, 200);
  const onDiskDir = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDiskDir.roles as { director: Record<string, unknown> }).director.thinking, "low");
});

test("handleRoleModel trims values and refuses a bad thinking level, writing nothing", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { feature: { provider: "huggingface" } } });
  // Values are trimmed before the write.
  const trimmed = await serveRoleModel(root, { role: "feature", provider: "  huggingface  ", model: " opus " });
  assert.equal(trimmed.captured.status, 200);
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  const feat = (onDisk.roles as { feature: Record<string, unknown> }).feature;
  assert.equal(feat.provider, "huggingface");
  assert.equal(feat.model, "opus");
  // A bad thinking level answers 400 naming roles.feature.thinking, file untouched.
  const beforeBad = fs.readFileSync(configPath(root), "utf8");
  const bad = await serveRoleModel(root, { role: "feature", thinking: "bogus" });
  assert.equal(bad.captured.status, 400);
  assert.match((bad.data as { error: string }).error, /roles\.feature\.thinking/);
  assert.equal(fs.readFileSync(configPath(root), "utf8"), beforeBad, "a rejected write never touches the file");
});

test("handleRoleModel refuses a missing role, a non-string field, none-of-the-three, and an unknown role", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { feature: { provider: "huggingface" } } });
  const before = fs.readFileSync(configPath(root), "utf8");
  // A missing/blank role answers 400 role required.
  for (const bad of [{}, { role: "  " }, { role: 5 }, { role: null }]) {
    const rejected = await serveRoleModel(root, bad);
    assert.equal(rejected.captured.status, 400);
    assert.match((rejected.data as { error: string }).error, /role required/);
  }
  // A non-string field names that field.
  const nonString = await serveRoleModel(root, { role: "feature", provider: 5 });
  assert.equal(nonString.captured.status, 400);
  assert.match((nonString.data as { error: string }).error, /"provider" must be a string/);
  // A body with none of the four fields answers 400.
  const none = await serveRoleModel(root, { role: "feature" });
  assert.equal(none.captured.status, 400);
  assert.match((none.data as { error: string }).error, /provider, model, thinking or backend required/);
  // An unknown role id is refused through validateConfig, writing nothing.
  const unknown = await serveRoleModel(root, { role: "nope", provider: "huggingface" });
  assert.equal(unknown.captured.status, 400);
  assert.match((unknown.data as { error: string }).error, /unknown role|nope/i);
  assert.equal(fs.readFileSync(configPath(root), "utf8"), before, "every refused write leaves the file byte-identical");
  // A no-op on an unknown role (clearing fields that role never had) is refused too, not a
  // false 200 "updated": setRoleModelFields's up-front known-role guard covers the path
  // validateConfig is skipped on.
  const unknownNoop = await serveRoleModel(root, { role: "nope", provider: "" });
  assert.equal(unknownNoop.captured.status, 400);
  assert.match((unknownNoop.data as { error: string }).error, /unknown role|nope/i);
});

test("handleRoleModel writes a backend override and clears it, refusing an unknown backend id", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { feature: { enabled: true } } });
  // A body carrying only backend, none of the other three, is accepted and written.
  const { captured, data } = await serveRoleModel(root, { role: "feature", backend: "claude" });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, role: "feature", message: "feature: model updated" });
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  const feat = (onDisk.roles as { feature: Record<string, unknown> }).feature;
  assert.equal(feat.enabled, true, "the entry's other fields preserved");
  assert.equal(feat.backend, "claude");
  assert.equal("provider" in feat, false, "only the named fields are written");
  // An empty backend clears it through setRoleModelFields's delete arm.
  const cleared = await serveRoleModel(root, { role: "feature", backend: "" });
  assert.equal(cleared.captured.status, 200);
  const after = readJson(configPath(root)) as Record<string, unknown>;
  assert.deepEqual((after.roles as { feature: Record<string, unknown> }).feature, { enabled: true }, "clearing backend leaves the other fields kept");
  // An unknown backend id is refused by validateConfig's checkEntryBackend, file untouched.
  const beforeBad = fs.readFileSync(configPath(root), "utf8");
  const bad = await serveRoleModel(root, { role: "feature", backend: "claud" });
  assert.equal(bad.captured.status, 400);
  assert.match((bad.data as { error: string }).error, /claude|backend|opencode|codex/i);
  assert.equal(fs.readFileSync(configPath(root), "utf8"), beforeBad, "a rejected write never touches the file");
});

test("handleRoleModel refuses a body with none of the four fields and accepts a backend with the model triple", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { feature: { provider: "huggingface" } } });
  const before = fs.readFileSync(configPath(root), "utf8");
  // A body with none of provider/model/thinking/backend answers 400.
  const none = await serveRoleModel(root, { role: "feature" });
  assert.equal(none.captured.status, 400);
  assert.match((none.data as { error: string }).error, /provider, model, thinking or backend required/);
  assert.equal(fs.readFileSync(configPath(root), "utf8"), before, "a refused write leaves the file byte-identical");
  // The existing provider/model/thinking-only bodies still write through.
  const trio = await serveRoleModel(root, { role: "feature", provider: "huggingface", model: "opus", thinking: "low" });
  assert.equal(trio.captured.status, 200);
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  const feat = (onDisk.roles as { feature: Record<string, unknown> }).feature;
  assert.equal(feat.model, "opus");
  assert.equal(feat.thinking, "low");
  assert.equal("backend" in feat, false, "a backend-less body writes no backend field");
});

// POST /api/role-interval: the role drawer's min run interval editor. Writes through the
// CLI's own setConfigKey dotted path (per-key checkMinRunInterval + whole-config
// validateConfig), so the browser cannot drift from `tumwater config set
// roles.<id>.minRunIntervalSeconds`; null/empty/whitespace clears through unsetConfigKey.
test("handleRoleInterval writes the role's override through setConfigKey and answers 200", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { minRunIntervalSeconds: 20 });
  const { captured, data } = await serveRoleInterval(root, { role: "feature", minRunIntervalSeconds: 300 });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, role: "feature", minRunIntervalSeconds: 300, message: "feature: min run interval set to 300s" });
  // The file on disk is what the scheduler polls — the write went through setConfigKey.
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.roles as { feature: { minRunIntervalSeconds: number } }).feature.minRunIntervalSeconds, 300);
});

test("handleRoleInterval maps an instance id to its base role's override and the director is accepted", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { feature: { instances: 2 } } });
  const inst = await serveRoleInterval(root, { role: "feature-2", minRunIntervalSeconds: 240 });
  assert.equal(inst.captured.status, 200);
  // An instance id writes roles.feature.minRunIntervalSeconds (the key its runs carry).
  assert.deepEqual(inst.data, { ok: true, role: "feature", minRunIntervalSeconds: 240, message: "feature: min run interval set to 240s" });
  // The director runs on the same clock — no exemption like the cap's.
  const dir = await serveRoleInterval(root, { role: "director", minRunIntervalSeconds: 60 });
  assert.equal(dir.captured.status, 200);
  assert.deepEqual(dir.data, { ok: true, role: "director", minRunIntervalSeconds: 60, message: "director: min run interval set to 60s" });
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  const roles = onDisk.roles as { feature: { minRunIntervalSeconds: number }; director: { minRunIntervalSeconds: number } };
  assert.equal(roles.feature.minRunIntervalSeconds, 240);
  assert.equal(roles.director.minRunIntervalSeconds, 60);
});

test("handleRoleInterval clears on null/empty/whitespace and rejects bad input without writing", async () => {
  const root = tmpdir();
  const seed = () => writeJsonFile(configPath(root), { roles: { feature: { minRunIntervalSeconds: 300 } } });
  seed();
  // Each empty form clears: null (the drawer posts for an empty input), "" and whitespace.
  for (const empty of [null, "", "   "]) {
    const cleared = await serveRoleInterval(root, { role: "feature", minRunIntervalSeconds: empty });
    assert.equal(cleared.captured.status, 200);
    assert.deepEqual(cleared.data, { ok: true, role: "feature", message: "feature: min run interval cleared" });
    let onDisk = readJson(configPath(root)) as Record<string, unknown>;
    assert.equal((onDisk.roles as { feature?: Record<string, unknown> } | undefined)?.feature?.minRunIntervalSeconds, undefined);
    seed(); // re-seed for the next empty form
  }
  // A bad value is refused with the per-role dotted key named.
  for (const bad of [-1, 2147484, "abc", { n: 1 }]) {
    const rej = await serveRoleInterval(root, { role: "feature", minRunIntervalSeconds: bad });
    assert.equal(rej.captured.status, 400);
    assert.match((rej.data as { error: string }).error, /roles\.feature\.minRunIntervalSeconds/);
  }
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.roles as { feature?: Record<string, unknown> } | undefined)?.feature?.minRunIntervalSeconds, 300, "a refused write never touches the file");
});

test("handleRoleInterval clears a key the file never set without writing and refuses a missing field or unknown role", async () => {
  const root = tmpdir();
  const before = Buffer.from(JSON.stringify({ minRunIntervalSeconds: 20 }, null, 2) + "\n");
  writeFileDeep(configPath(root), before);
  // Unsetting a key the file never set is a no-op: the file's bytes stay identical.
  const cleared = await serveRoleInterval(root, { role: "feature", minRunIntervalSeconds: null });
  assert.equal(cleared.captured.status, 200);
  assert.match((cleared.data as { message: string }).message, /is not set in tumwater\.json, so nothing was cleared/);
  const after = fs.readFileSync(configPath(root));
  assert.equal(after.equals(before), true, "clearing a never-set key leaves the file byte-identical");
  // A missing role or a missing value (absent, not null) is refused.
  const noRole = await serveRoleInterval(root, { minRunIntervalSeconds: 300 });
  assert.equal(noRole.captured.status, 400);
  assert.match((noRole.data as { error: string }).error, /role required/);
  const noValue = await serveRoleInterval(root, { role: "feature" });
  assert.equal(noValue.captured.status, 400);
  assert.match((noValue.data as { error: string }).error, /minRunIntervalSeconds required/);
  // An unknown role id is refused through validateConfig, writing nothing.
  const fresh = tmpdir();
  const unknown = await serveRoleInterval(fresh, { role: "nope", minRunIntervalSeconds: 300 });
  assert.equal(unknown.captured.status, 400);
  assert.equal(fs.existsSync(configPath(fresh)), false, "a refused write never creates the file");
  // Clearing an unknown role is refused too — unsetConfigKey's no-op map path (a role the
  // file never holds) skips validateConfig, so the clear branch checks the id explicitly.
  const fresh2 = tmpdir();
  const unknownClear = await serveRoleInterval(fresh2, { role: "nope", minRunIntervalSeconds: null });
  assert.equal(unknownClear.captured.status, 400);
  assert.match((unknownClear.data as { error: string }).error, /unknown role "nope"/);
  assert.equal(fs.existsSync(configPath(fresh2)), false, "a refused clear never creates the file");
});

test("handleRoleInterval writes and clears a seeded built-in role's override the same way", async () => {
  // qa is a built-in whose catalog seed fills roles.qa.minRunIntervalSeconds (7200) in the
  // merged config even when the file never sets it — the drawer's tag/clear path must not
  // rely on that seed. The route writes through setConfigKey/unsetConfigKey: setting qa's
  // override lands in the file, and clearing a key the file never set is a real no-op that
  // keeps the seeded value in the merged view but leaves the file bytes identical.
  const root = tmpdir();
  const before = Buffer.from(JSON.stringify({ minRunIntervalSeconds: 20 }, null, 2) + "\n");
  writeFileDeep(configPath(root), before);
  // Clearing a never-set built-in's override writes nothing (no-op success).
  const cleared = await serveRoleInterval(root, { role: "qa", minRunIntervalSeconds: null });
  assert.equal(cleared.captured.status, 200);
  assert.equal(fs.readFileSync(configPath(root)).equals(before), true, "a built-in's never-set clear is a byte-identical no-op");
  // Setting it writes roles.qa.minRunIntervalSeconds.
  const set = await serveRoleInterval(root, { role: "qa", minRunIntervalSeconds: 300 });
  assert.equal(set.captured.status, 200);
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.roles as { qa: { minRunIntervalSeconds: number } }).qa.minRunIntervalSeconds, 300);
});

function serveRoleInstances(root: string, body: unknown) {
  return captureJson((res) => handleRoleInstances(fakeReq(JSON.stringify(body)), res, root));
}

// POST /api/role-instances: the role drawer's parallel-runner-count editor. Writes through the
// CLI's own setConfigKey dotted path, so whole-candidate validateConfig owns the final truth
// (only feature and bugfix may split, and the count is an integer 1–8); null/empty/whitespace
// clears through unsetConfigKey, and a bare instance id maps to its base role's count.
test("handleRoleInstances writes the role's count through setConfigKey and answers 200", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), {});
  const { captured, data } = await serveRoleInstances(root, { role: "feature", instances: 3 });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, role: "feature", instances: 3, message: "feature: instances set to 3" });
  // The file on disk is what the scheduler polls — the write went through setConfigKey.
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.roles as { feature: { instances: number } }).feature.instances, 3);
});

test("handleRoleInstances maps an instance id to its base role's count", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { feature: { instances: 2 } } });
  const inst = await serveRoleInstances(root, { role: "feature-2", instances: 3 });
  assert.equal(inst.captured.status, 200);
  // An instance id writes roles.feature.instances (the key its runs read).
  assert.deepEqual(inst.data, { ok: true, role: "feature", instances: 3, message: "feature: instances set to 3" });
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.roles as { feature: { instances: number } }).feature.instances, 3);
});

test("handleRoleInstances clears on null/empty/whitespace and rejects bad input without writing", async () => {
  const root = tmpdir();
  const seed = () => writeJsonFile(configPath(root), { roles: { feature: { instances: 3 } } });
  seed();
  // Each empty form clears: null (the drawer posts for an empty input), "" and whitespace.
  for (const empty of [null, "", "   "]) {
    const cleared = await serveRoleInstances(root, { role: "feature", instances: empty });
    assert.equal(cleared.captured.status, 200);
    assert.deepEqual(cleared.data, { ok: true, role: "feature", message: "feature: instances cleared" });
    const onDisk = readJson(configPath(root)) as Record<string, unknown>;
    assert.equal((onDisk.roles as { feature?: Record<string, unknown> } | undefined)?.feature?.instances, undefined);
    seed(); // re-seed for the next empty form
  }
  // A bad value is refused through validateConfig with the per-role dotted key named.
  for (const bad of [0, 9, 1.5, "abc"]) {
    const rej = await serveRoleInstances(root, { role: "feature", instances: bad });
    assert.equal(rej.captured.status, 400);
    assert.match((rej.data as { error: string }).error, /roles\.feature\.instances/);
  }
  // Only feature and bugfix may split; the director and steward are refused through
  // validateConfig's INSTANCE_ROLES branch.
  for (const id of ["steward", "director"]) {
    const rej = await serveRoleInstances(root, { role: id, instances: 2 });
    assert.equal(rej.captured.status, 400);
    assert.match((rej.data as { error: string }).error, /only valid for feature and bugfix/);
  }
  // An unknown id is refused earlier, at validateConfig's known-role guard.
  const unknown = await serveRoleInstances(root, { role: "nope", instances: 2 });
  assert.equal(unknown.captured.status, 400);
  assert.match((unknown.data as { error: string }).error, /nope is not a known role/);
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.roles as { feature?: Record<string, unknown> } | undefined)?.feature?.instances, 3, "a refused write never touches the file");
});

test("handleRoleInstances clears a key the file never set without writing and refuses a missing field or unknown role", async () => {
  const root = tmpdir();
  const before = Buffer.from(JSON.stringify({ roles: { feature: { enabled: true } } }, null, 2) + "\n");
  writeFileDeep(configPath(root), before);
  // Unsetting a key the file never set is a no-op: the file's bytes stay identical.
  const cleared = await serveRoleInstances(root, { role: "feature", instances: null });
  assert.equal(cleared.captured.status, 200);
  assert.match((cleared.data as { message: string }).message, /is not set in tumwater\.json, so nothing was cleared/);
  const after = fs.readFileSync(configPath(root));
  assert.equal(after.equals(before), true, "clearing a never-set key leaves the file byte-identical");
  // A missing role or a missing value (absent, not null) is refused.
  const noRole = await serveRoleInstances(root, { instances: 3 });
  assert.equal(noRole.captured.status, 400);
  assert.match((noRole.data as { error: string }).error, /role required/);
  const noValue = await serveRoleInstances(root, { role: "feature" });
  assert.equal(noValue.captured.status, 400);
  assert.match((noValue.data as { error: string }).error, /instances required/);
  // An unknown role id is refused on the set branch through validateConfig, writing nothing.
  const fresh = tmpdir();
  const unknown = await serveRoleInstances(fresh, { role: "nope", instances: 2 });
  assert.equal(unknown.captured.status, 400);
  assert.equal(fs.existsSync(configPath(fresh)), false, "a refused write never creates the file");
  // Clearing an unknown role is refused too — unsetConfigKey's no-op map path (a role the
  // file never holds) skips validateConfig, so the clear branch checks the id explicitly.
  const fresh2 = tmpdir();
  const unknownClear = await serveRoleInstances(fresh2, { role: "nope", instances: null });
  assert.equal(unknownClear.captured.status, 400);
  assert.match((unknownClear.data as { error: string }).error, /unknown role "nope"/);
  assert.equal(fs.existsSync(configPath(fresh2)), false, "a refused clear never creates the file");
});

function serveRoleEnable(root: string, body: unknown) {
  return captureJson((res) => handleRoleEnable(fakeReq(JSON.stringify(body)), res, root));
}

// POST /api/role-enable: the Settings view's "Disabled roles" card Enable button. Writes the
// role's enabled key through the CLI's own setConfigKey (raw JSON literal "true", so the value
// lands as the boolean checkBoolean expects); the director is accepted (it cannot be disabled);
// an instance id maps to its base role's key; an unknown id is refused through validateConfig.
test("handleRoleEnable writes roles.<role>.enabled true and answers 200", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { improve: { enabled: false } } });
  const { captured, data } = await serveRoleEnable(root, { role: "improve" });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, role: "improve", message: "improve: enabled" });
  // The file on disk is what the running team polls — the write went through setConfigKey.
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.roles as { improve: Record<string, unknown> }).improve.enabled, true);
});

test("handleRoleEnable maps an instance id to its base role's key and accepts the director", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { feature: { instances: 2, enabled: false } } });
  // A bare feature-2 style instance id writes the base role's enabled key.
  const inst = await serveRoleEnable(root, { role: "feature-2" });
  assert.equal(inst.captured.status, 200);
  assert.deepEqual(inst.data, { ok: true, role: "feature", message: "feature: enabled" });
  let onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.roles as { feature: Record<string, unknown> }).feature.enabled, true);
  // The director is accepted (harmless — it cannot be disabled); it already resolves enabled, so
  // setConfigKey writes nothing.
  const dir = await serveRoleEnable(root, { role: "director" });
  assert.equal(dir.captured.status, 200);
  assert.deepEqual(dir.data, { ok: true, role: "director", message: "director: already enabled" });
  onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.roles as Record<string, unknown>).director, undefined);
});

test("handleRoleEnable rejects a missing, blank, non-string, or unknown role without writing", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { improve: { enabled: false } } });
  const before = fs.readFileSync(configPath(root), "utf8");
  const post = (body: unknown) => captureJson((res) => handleRoleEnable(fakeReq(JSON.stringify(body)), res, root));
  // Missing, blank, and non-string roles each answer 400 and leave the file byte-identical.
  for (const bad of [{}, { role: "  " }, { role: 5 }, { role: null }]) {
    const rejected = await post(bad);
    assert.equal(rejected.captured.status, 400);
    assert.match((rejected.data as { error: string }).error, /role required/);
    assert.equal(fs.readFileSync(configPath(root), "utf8"), before, "a refused write never touches the file");
  }
  // An unknown id is refused through validateConfig's unknown-role answer, writing nothing.
  const unknown = await post({ role: "bogus" });
  assert.equal(unknown.captured.status, 400);
  assert.equal(fs.readFileSync(configPath(root), "utf8"), before, "a refused write never touches the file");
});

function serveRoleDisable(root: string, body: unknown) {
  return captureJson((res) => handleRoleDisable(fakeReq(JSON.stringify(body)), res, root));
}

// POST /api/role-disable: the role drawer's two-click Disable action, the drawer half of the
// enable/disable pair (the Settings card's Enable re-enables). Writes the role's enabled key
// through the CLI's own setConfigKey (raw JSON literal "false", so the value lands as the
// boolean checkBoolean expects); the director is refused (it cannot be disabled); an instance
// id maps to its base role's key; an unknown id is refused through validateConfig.
test("handleRoleDisable writes roles.<role>.enabled false and answers 200", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { improve: { enabled: true } } });
  const { captured, data } = await serveRoleDisable(root, { role: "improve" });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, role: "improve", message: "improve: disabled" });
  // The file on disk is what the running team polls — the write went through setConfigKey.
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.roles as { improve: Record<string, unknown> }).improve.enabled, false);
});

test("handleRoleDisable maps an instance id to its base role's key and refuses the director", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { feature: { instances: 2, enabled: true } } });
  // A bare feature-2 style instance id writes the base role's enabled key.
  const inst = await serveRoleDisable(root, { role: "feature-2" });
  assert.equal(inst.captured.status, 200);
  assert.deepEqual(inst.data, { ok: true, role: "feature", message: "feature: disabled" });
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal((onDisk.roles as { feature: Record<string, unknown> }).feature.enabled, false);
  // The director cannot be disabled — a disable is refused and leaves the file byte-identical.
  const dir = tmpdir();
  writeJsonFile(configPath(dir), { roles: { director: { enabled: true } } });
  const before = fs.readFileSync(configPath(dir));
  const refused = await serveRoleDisable(dir, { role: "director" });
  assert.equal(refused.captured.status, 400);
  assert.match((refused.data as { error: string }).error, /the director cannot be disabled/);
  assert.equal(fs.readFileSync(configPath(dir)).equals(before), true, "a refused write never touches the file");
  // Enabling the director still answers 200 (it stays harmless, and the Settings card's Enable
  // is unchanged).
  const reEnable = await serveRoleEnable(dir, { role: "director" });
  assert.equal(reEnable.captured.status, 200);
  assert.deepEqual(reEnable.data, { ok: true, role: "director", message: "director: already enabled" });
});

test("handleRoleDisable rejects a missing, blank, non-string, or unknown role without writing", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { roles: { improve: { enabled: true } } });
  const before = fs.readFileSync(configPath(root), "utf8");
  const post = (body: unknown) => captureJson((res) => handleRoleDisable(fakeReq(JSON.stringify(body)), res, root));
  // Missing, blank, and non-string roles each answer 400 and leave the file byte-identical.
  for (const bad of [{}, { role: "  " }, { role: 5 }, { role: null }]) {
    const rejected = await post(bad);
    assert.equal(rejected.captured.status, 400);
    assert.match((rejected.data as { error: string }).error, /role required/);
    assert.equal(fs.readFileSync(configPath(root), "utf8"), before, "a refused write never touches the file");
  }
  // An unknown id is refused through validateConfig's unknown-role answer, writing nothing.
  const unknown = await post({ role: "bogus" });
  assert.equal(unknown.captured.status, 400);
  assert.equal(fs.readFileSync(configPath(root), "utf8"), before, "a refused write never touches the file");
});

test("handleConfigSet refuses a key outside the curated set, naming it", async () => {
  const root = tmpdir();
  const unknownKey = await serveConfigSet(root, { key: "modle", value: "gpt-5" });
  assert.equal(unknownKey.captured.status, 400);
  assert.match((unknownKey.data as { error: string }).error, /modle/);
  assert.match((unknownKey.data as { error: string }).error, /did you mean `model`/);
  // A known-but-not-curated key is refused too — curation, not validity, is the gate. It is
  // far from every curated key, so it names the list with no hint.
  const curated = await serveConfigSet(root, { key: "customRoles", value: [] });
  assert.equal(curated.captured.status, 400);
  assert.match((curated.data as { error: string }).error, /customRoles/);
  assert.doesNotMatch((curated.data as { error: string }).error, /did you mean/);
  // A body with no key at all names no value — the shared gotSuffix convention appends
  // nothing for an absent field rather than echoing back a literal `null` it never carried.
  const missing = await serveConfigSet(root, { value: "gpt-5" });
  assert.equal(missing.captured.status, 400);
  assert.match((missing.data as { error: string }).error, /key must be one of/);
  assert.doesNotMatch((missing.data as { error: string }).error, /got null/);
  assert.doesNotMatch((missing.data as { error: string }).error, /did you mean/);
});

test("handleConfigUnset removes one curated key and leaves its siblings", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { model: "gpt-5", quietHours: "23:00-07:00" });
  const { captured, data } = await serveConfigUnset(root, { key: "model" });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, key: "model", oldValue: "gpt-5" });
  // The file on disk is what the running team polls — the removal went through unsetConfigKey.
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal("model" in onDisk, false);
  assert.equal(onDisk.quietHours, "23:00-07:00");
  // The GET surface now shows the reverted resolved value, not the removed one.
  const after = await serveConfig(root);
  assert.equal((after.data as Record<string, unknown>).model, null);
});

test("handleConfigUnset refuses a key outside the curated set, naming it", async () => {
  const root = tmpdir();
  const mis = await serveConfigUnset(root, { key: "modle" });
  assert.equal(mis.captured.status, 400);
  assert.match((mis.data as { error: string }).error, /did you mean `model`/);
  const curated = await serveConfigUnset(root, { key: "customRoles" });
  assert.equal(curated.captured.status, 400);
  assert.match((curated.data as { error: string }).error, /customRoles/);
  assert.doesNotMatch((curated.data as { error: string }).error, /did you mean/);
  // A body with no key at all names no value — the shared gotSuffix convention appends
  // nothing for an absent field rather than echoing back a literal `null` it never carried.
  const missing = await serveConfigUnset(root, {});
  assert.equal(missing.captured.status, 400);
  assert.match((missing.data as { error: string }).error, /key must be one of/);
  assert.doesNotMatch((missing.data as { error: string }).error, /got null/);
  assert.doesNotMatch((missing.data as { error: string }).error, /did you mean/);
});

test("handleConfigUnset on a key the file never held is a 200 no-op with no oldValue", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { quietHours: "23:00-07:00" });
  const before = fs.readFileSync(configPath(root), "utf8");
  const { captured, data } = await serveConfigUnset(root, { key: "model" });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, key: "model" });
  assert.equal("oldValue" in (data as Record<string, unknown>), false, "JSON omits the undefined oldValue");
  assert.equal(fs.readFileSync(configPath(root), "utf8"), before, "the no-op write leaves the file byte-identical");
});

test("handleConfigSet refuses a bad value through setConfigKey's validator, naming the key", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { quietHours: "23:00-07:00" });
  const bad = await serveConfigSet(root, { key: "quietHours", value: "25:00-07:00" });
  assert.equal(bad.captured.status, 400);
  assert.match((bad.data as { error: string }).error, /quietHours/);
  // A failed edit leaves the file untouched.
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal(onDisk.quietHours, "23:00-07:00");
  assert.equal(onDisk.model, undefined);
});

// ---- GET /api/diff: the Pending view's collector surface ----
// The handler only adapts HTTP onto change-data.ts's collectors, so these tests pin that the
// team document matches collectTeamChanges (same mainBranch/roles, no per-role patch fields)
// and the role document matches collectRoleChange — the documents `tumwater diff --json` and
// `tumwater diff --role <id> --json` print. The role is a target, so an unknown id is a 400.
function serveDiff(root: string, query = "") {
  return captureJson((res) => handleDiff(new URLSearchParams(query), res, root));
}

test("handleDiff serves the team roster with no patch fields, matching collectTeamChanges", async () => {
  const root = makeRepo();
  await initProject(root, "gui diff team");
  fs.writeFileSync(path.join(root, "notes.txt"), "seeded\n");
  commitIn(root, "seed notes.txt");
  const wt = await ensureWorktree(root, "feature", "main");
  fs.writeFileSync(path.join(wt, "feature.md"), "work\n");
  commitIn(wt, "feature work");
  fs.appendFileSync(path.join(wt, "notes.txt"), "uncommitted\n");

  const { captured, data } = await serveDiff(root);
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  assert.deepEqual(data, await collectTeamChanges(root), "the endpoint serves the collector document unchanged");
  const feature = (data as unknown as { roles: Array<Record<string, unknown>> }).roles.find((r) => r.role === "feature")!;
  assert.equal(feature.ahead, 1);
  const commits = feature.commits as Array<{ sha: string; subject: string }>;
  assert.equal(commits.length, 1);
  assert.match(commits[0]!.sha, /^[0-9a-f]+$/);
  assert.equal(commits[0]!.subject, "feature work");
  assert.deepEqual(feature.dirtyFiles, ["notes.txt"]);
  assert.ok(!("diff" in feature) && !("uncommittedDiff" in feature), "the team roster drops both patch halves");
});

test("handleDiff with ?role serves the full per-role view, matching collectRoleChange", async () => {
  const root = makeRepo();
  await initProject(root, "gui diff role");
  fs.writeFileSync(path.join(root, "notes.txt"), "seeded\n");
  commitIn(root, "seed notes.txt");
  const wt = await ensureWorktree(root, "feature", "main");
  fs.writeFileSync(path.join(wt, "feature.md"), "work\n");
  commitIn(wt, "feature work");

  const { captured, data } = await serveDiff(root, "?role=feature");
  assert.equal(captured.status, 200);
  assert.deepEqual(data, await collectRoleChange(root, "feature"));
  const view = data as { state: string; branch: string; diff: string };
  assert.equal(view.state, "ready");
  assert.match(view.branch, /feature/);
  assert.match(view.diff, /feature\.md/);
});

test("handleDiff degrades an absent worktree and a fresh repo without throwing", async () => {
  const root = makeRepo();
  await initProject(root, "gui diff absent");
  // qa is a valid id (rejectBadRole accepts it) whose worktree has never been created.
  const absent = await serveDiff(root, "?role=qa");
  assert.equal(absent.captured.status, 200);
  assert.equal((absent.data as { state: string }).state, "absent");

  // A directory that was never initialized has no git repo and no config: every role's entry
  // is no-base, and the team query still answers 200 rather than throwing.
  const fresh = tmpdir();
  const team = await serveDiff(fresh);
  assert.equal(team.captured.status, 200);
  const doc = team.data as { mainBranch: string; roles: Array<{ state: string }> };
  assert.ok(doc.roles.length > 0);
  assert.ok(doc.roles.every((r) => r.state === "no-base"));
});

test("handleDiff refuses an unknown role through rejectBadRole's 400", async () => {
  const root = makeRepo();
  await initProject(root, "gui diff badrole");
  const bad = await serveDiff(root, "?role=ghost");
  assert.equal(bad.captured.status, 400);
  assert.match((bad.data as { error: string }).error, /unknown role "ghost"/);
  // The 400 names the valid ids, and no traversal-shaped string reaches the collector.
  assert.match((bad.data as { error: string }).error, /valid ids:/);
  const traversal = await serveDiff(root, "?role=" + encodeURIComponent("../../../etc"));
  assert.equal(traversal.captured.status, 400);
});

test("handleDiff with ?overlaps serves collectChangeOverlaps's document, scoped by role", async () => {
  const root = makeRepo();
  await initProject(root, "gui diff overlaps");
  fs.writeFileSync(path.join(root, "notes.txt"), "seeded\n");
  fs.writeFileSync(path.join(root, "solo.md"), "seeded\n");
  commitIn(root, "seed notes.txt and solo.md");
  const feature = await ensureWorktree(root, "feature", "main");
  const qa = await ensureWorktree(root, "qa", "main");
  const bugfix = await ensureWorktree(root, "bugfix", "main");
  fs.appendFileSync(path.join(feature, "notes.txt"), "feature\n");
  fs.appendFileSync(path.join(qa, "notes.txt"), "qa\n");
  fs.appendFileSync(path.join(qa, "solo.md"), "qa\n");
  fs.appendFileSync(path.join(bugfix, "solo.md"), "bugfix\n");
  fs.writeFileSync(path.join(feature, "feature.md"), "work\n");
  commitIn(feature, "feature work");

  const ok = await serveDiff(root, "?overlaps=1");
  assert.equal(ok.captured.status, 200);
  assert.deepEqual(ok.data, await collectChangeOverlaps(root));
  assert.deepEqual((ok.data as unknown as { overlaps: unknown }).overlaps, [
    { path: "notes.txt", roles: ["feature", "qa"] },
    { path: "solo.md", roles: ["bugfix", "qa"] },
  ]);

  const one = await serveDiff(root, "?overlaps=1&role=feature");
  assert.equal(one.captured.status, 200);
  assert.deepEqual((one.data as unknown as { overlaps: unknown }).overlaps, [{ path: "notes.txt", roles: ["feature", "qa"] }]);
  const solo = await serveDiff(root, "?overlaps=1&role=bugfix");
  assert.deepEqual((solo.data as unknown as { overlaps: unknown }).overlaps, [{ path: "solo.md", roles: ["bugfix", "qa"] }]);
  const both = await serveDiff(root, "?overlaps=1&role=feature,bugfix");
  assert.equal(both.captured.status, 200);
  assert.deepEqual(both.data, scopeChangeOverlaps(await collectChangeOverlaps(root), ["feature", "bugfix"]));
  assert.deepEqual((both.data as unknown as { overlaps: { path: string }[] }).overlaps.map((o) => o.path), ["notes.txt", "solo.md"]);
  const byPath = await serveDiff(root, "?overlaps=1&path=notes.txt");
  assert.equal(byPath.captured.status, 200);
  assert.deepEqual((byPath.data as unknown as { overlaps: unknown }).overlaps, [{ path: "notes.txt", roles: ["feature", "qa"] }]);
  const none = await serveDiff(root, "?overlaps=1&role=bugfix&path=notes.txt");
  assert.deepEqual((none.data as unknown as { overlaps: unknown }).overlaps, []);
  const ghost = await serveDiff(root, "?overlaps=1&role=ghost");
  assert.equal(ghost.captured.status, 400);
  assert.match((ghost.data as { error: string }).error, /unknown role "ghost"/);
  assert.equal((await serveDiff(root, "?overlaps=1&role=")).captured.status, 400);

  const fresh = await serveDiff(tmpdir(), "?overlaps=1");
  assert.equal(fresh.captured.status, 200);
  const doc = fresh.data as unknown as { state: string; overlaps: unknown[] };
  assert.equal(doc.state, "no-base");
  assert.deepEqual(doc.overlaps, []);
});

test("handleDiff with ?role&path serves the path-scoped view, matching collectRoleChange", async () => {
  const root = makeRepo();
  await initProject(root, "gui diff path");
  fs.writeFileSync(path.join(root, "notes.txt"), "seeded\n");
  commitIn(root, "seed notes.txt");
  const feature = await ensureWorktree(root, "feature", "main");
  fs.appendFileSync(path.join(feature, "notes.txt"), "feature\n");
  fs.writeFileSync(path.join(feature, "feature.md"), "work\n");
  commitIn(feature, "feature work");
  fs.appendFileSync(path.join(feature, "notes.txt"), "more\n");

  const ok = await serveDiff(root, "?role=feature&path=notes.txt");
  assert.equal(ok.captured.status, 200);
  assert.deepEqual(ok.data, await collectRoleChange(root, "feature", { path: "notes.txt" }));
  const doc = ok.data as unknown as { path: string; dirtyFiles: string[]; diff: string };
  assert.equal(doc.path, "notes.txt");
  assert.deepEqual(doc.dirtyFiles, ["notes.txt"]);
  assert.ok(!doc.diff.includes("feature.md"));
  const dotted = await serveDiff(root, "?role=feature&path=" + encodeURIComponent("./notes.txt/"));
  assert.deepEqual(dotted.data, ok.data);
  const md = (await serveDiff(root, "?role=feature&path=feature.md")).data as unknown as { commits: unknown[]; dirtyFiles: string[] };
  assert.equal(md.commits.length, 1);
  assert.deepEqual(md.dirtyFiles, []);
});

test("handleDiff with ?role&stat serves the diffstat view, matching collectRoleChange with stat", async () => {
  const root = makeRepo();
  await initProject(root, "gui diff stat");
  fs.writeFileSync(path.join(root, "notes.txt"), "seeded\n");
  commitIn(root, "seed notes.txt");
  const feature = await ensureWorktree(root, "feature", "main");
  fs.writeFileSync(path.join(feature, "feature.md"), "work\n");
  fs.appendFileSync(path.join(feature, "notes.txt"), "feature\n");
  commitIn(feature, "feature work");
  fs.appendFileSync(path.join(feature, "notes.txt"), "more\n");

  const ok = await serveDiff(root, "?role=feature&stat=1");
  assert.equal(ok.captured.status, 200);
  assert.deepEqual(ok.data, await collectRoleChange(root, "feature", { stat: true }));
  const doc = ok.data as unknown as { diff: string; uncommittedDiff: string };
  assert.match(doc.diff, /feature\.md \| /);
  assert.ok(!doc.diff.includes("diff --git"));
  assert.match(doc.uncommittedDiff, /notes\.txt \| /);
  const scoped = await serveDiff(root, "?role=feature&stat=1&path=notes.txt");
  assert.deepEqual(scoped.data, await collectRoleChange(root, "feature", { stat: true, path: "notes.txt" }));
  assert.ok(!(scoped.data as unknown as { diff: string }).diff.includes("feature.md"));
});

test("handleDiff refuses stat without role and with overlaps", async () => {
  const root = makeRepo();
  await initProject(root, "gui diff stat refusals");
  await ensureWorktree(root, "feature", "main");
  const noRole = await serveDiff(root, "?stat=1");
  assert.equal(noRole.captured.status, 400);
  assert.match((noRole.data as { error: string }).error, /stat needs role/);
  const overlaps = await serveDiff(root, "?overlaps=1&stat=1");
  assert.equal(overlaps.captured.status, 400);
  assert.match((overlaps.data as { error: string }).error, /drop stat/);
});

test("handleDiff refuses path without role and outside the repo", async () => {
  const root = makeRepo();
  await initProject(root, "gui diff path refusals");
  await ensureWorktree(root, "feature", "main");
  const err = async (q: string) => {
    const r = await serveDiff(root, q);
    assert.equal(r.captured.status, 400);
    return (r.data as { error: string }).error;
  };
  assert.match(await err("?path=notes.txt"), /path needs role/);
  assert.match(await err("?overlaps=1&path=..%2Fx"), /repo-relative path/);
  for (const bad of ["../x", "/etc", "."]) {
    assert.match(await err("?role=feature&path=" + encodeURIComponent(bad)), /repo-relative path/);
  }
});

// ---- GET /api/prompt-text and POST /api/prompt-edit: the Queued tab's file-addressed edit
// seam (PLANS.md 2026-10-11, part 1/2). Both address one prompt by its queue-file basename,
// the /api/prompt-cancel address, and share inbox-edit.ts's core with the CLI's
// `prompt --edit` so the browser cannot drift from it.

/** Seed a queue file at an exact basename, so these endpoints can be driven without depending
 * on enqueueRolePrompt's stamp (the browser names whichever file a poll showed). */
function seedPromptFile(root: string, role: string, name: string, text: string): string {
  const dir = roleInboxDir(root, role);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

function servePromptText(root: string, query: string) {
  return captureJson((res) => handlePromptText(new URLSearchParams(query), res, root));
}

function servePromptEdit(root: string, body: unknown) {
  return captureJson((res) => handlePromptEdit(fakeReq(JSON.stringify(body)), res, root));
}

function servePromptTop(root: string, body: unknown) {
  return captureJson((res) => handlePromptTop(fakeReq(JSON.stringify(body)), res, root));
}

test("handlePromptText serves a queue file's editable body, with gone and the guards", async () => {
  const root = tmpdir();
  seedPromptFile(root, "qa", "q.md", "the queued body");

  const { captured, data } = await servePromptText(root, "?role=qa&file=q.md");
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  assert.deepEqual(data, { ok: true, text: "the queued body" });

  // A vanished file is data for the UI, not a server fault.
  const gone = await servePromptText(root, "?role=qa&file=missing.md");
  assert.equal(gone.captured.status, 200);
  assert.deepEqual(gone.data, { ok: true, status: "gone" });

  // A missing or hostile file name is the shared basename guard's 400.
  const missing = await servePromptText(root, "?role=qa");
  assert.equal(missing.captured.status, 400);
  assert.match((missing.data as { error: string }).error, /file required/);
  const bad = await servePromptText(root, "?role=qa&file=../escape.md");
  assert.equal(bad.captured.status, 400);
  assert.match((bad.data as { error: string }).error, /plain queue-file basename/);

  // The role is a target, not a filter: an unknown id is rejectBadRole's 400.
  const unknown = await servePromptText(root, "?role=ghost&file=q.md");
  assert.equal(unknown.captured.status, 400);
  assert.match((unknown.data as { error: string }).error, /unknown role "ghost"/);
});

test("handlePromptEdit rewrites the named file, leaving a sibling intact, with gone and the guards", async () => {
  const root = tmpdir();
  seedPromptFile(root, "qa", "q.md", "old body");
  seedPromptFile(root, "qa", "sibling.md", "sibling body");

  const { captured, data } = await servePromptEdit(root, { role: "qa", file: "q.md", text: "new body" });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, status: "edited", oldText: "old body", newText: "new body" });
  assert.equal(fs.readFileSync(path.join(roleInboxDir(root, "qa"), "q.md"), "utf8"), "new body");
  assert.equal(
    fs.readFileSync(path.join(roleInboxDir(root, "qa"), "sibling.md"), "utf8"),
    "sibling body",
    "a sibling queue file is untouched",
  );

  // A bad file name and an over-cap body are user-input 400s, the file left as it was.
  const bad = await servePromptEdit(root, { role: "qa", file: "q.txt", text: "x" });
  assert.equal(bad.captured.status, 400);
  assert.match((bad.data as { error: string }).error, /\.md/);
  const overCap = await servePromptEdit(root, {
    role: "qa",
    file: "q.md",
    text: "x".repeat(DIRECTOR_PROMPT_MAX_CHARS + 1),
  });
  assert.equal(overCap.captured.status, 400);
  assert.match((overCap.data as { error: string }).error, /shorten it to at most/);
  assert.equal(fs.readFileSync(path.join(roleInboxDir(root, "qa"), "q.md"), "utf8"), "new body");

  // A vanished file answers gone; a missing file field is the guard's 400.
  const gone = await servePromptEdit(root, { role: "qa", file: "missing.md", text: "new" });
  assert.equal(gone.captured.status, 200);
  assert.deepEqual(gone.data, { ok: true, status: "gone" });
  const missing = await servePromptEdit(root, { role: "qa", text: "new" });
  assert.equal(missing.captured.status, 400);
  assert.match((missing.data as { error: string }).error, /file required/);

  // The role is optional and validates exactly like /api/prompt-cancel.
  seedPromptFile(root, DIRECTOR_ROLE, "director.md", "director body");
  const asDirector = await servePromptEdit(root, { file: "director.md", text: "edited" });
  assert.equal(asDirector.captured.status, 200);
  const unknown = await servePromptEdit(root, { role: "ghost", file: "q.md", text: "x" });
  assert.equal(unknown.captured.status, 400);
  assert.match((unknown.data as { error: string }).error, /unknown role "ghost"/);
});

// ---- POST /api/prompt-top: the Queued tab's file-addressed Move to top. The handler reuses
// inbox-top.ts's topQueuedFile — the file-addressed twin of `prompt --top <n>` — so a stale
// poll reorders only the file it names, logging one prompt_topped event under the role.
test("handlePromptTop moves the named file to its role's queue head, with already_first, gone, and the guards", async () => {
  const root = tmpdir();
  seedPromptFile(root, "qa", "q1.md", "first body");
  seedPromptFile(root, "qa", "q2.md", "second body");
  seedPromptFile(root, "qa", "q3.md", "third body");

  const { captured, data } = await servePromptTop(root, { role: "qa", file: "q3.md" });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, status: "topped", preview: "third body" });
  // The moved prompt leads its role's queue; its two siblings keep their set of texts.
  const records = queuedRolePromptRecords(root, "qa");
  assert.equal(records[0]?.text, "third body");
  assert.deepEqual(queuedRolePromptRecords(root, "qa").map((r) => r.text).sort(), ["first body", "second body", "third body"]);
  // One prompt_topped event under the target role, previewing the moved prompt.
  const topped = eventsOfType(root, "prompt_topped");
  assert.equal(topped.length, 1);
  assert.equal(topped[0]?.source, "qa");
  assert.equal(topped[0]?.preview, "third body");

  // The head answers already_first with no write and no second event.
  const headName = path.basename(queuedFiles(root, "qa")[0] as string);
  const head = await servePromptTop(root, { role: "qa", file: headName });
  assert.equal(head.captured.status, 200);
  assert.deepEqual(head.data, { ok: true, status: "already_first" });
  assert.equal(eventsOfType(root, "prompt_topped").length, 1);

  // A vanished file answers gone.
  const gone = await servePromptTop(root, { role: "qa", file: "missing.md" });
  assert.equal(gone.captured.status, 200);
  assert.deepEqual(gone.data, { ok: true, status: "gone" });

  // A missing or hostile file name is the shared basename guard's 400, the queue unchanged.
  const missing = await servePromptTop(root, { role: "qa" });
  assert.equal(missing.captured.status, 400);
  assert.match((missing.data as { error: string }).error, /file required/);
  const bad = await servePromptTop(root, { role: "qa", file: "../escape.md" });
  assert.equal(bad.captured.status, 400);
  assert.match((bad.data as { error: string }).error, /plain queue-file basename/);
  assert.equal(queuedRolePromptRecords(root, "qa").length, 3, "nothing touched on a rejected name");

  // An unknown role is rejectBadRole's 400; an absent role targets the director's queue.
  const unknown = await servePromptTop(root, { role: "ghost", file: "q1.md" });
  assert.equal(unknown.captured.status, 400);
  assert.match((unknown.data as { error: string }).error, /unknown role "ghost"/);
  seedPromptFile(root, DIRECTOR_ROLE, "0.md", "earlier director");
  seedPromptFile(root, DIRECTOR_ROLE, "d.md", "director body");
  const asDirector = await servePromptTop(root, { file: "d.md" });
  assert.equal(asDirector.captured.status, 200);
  assert.deepEqual(asDirector.data, { ok: true, status: "topped", preview: "director body" });
});

test("handleQuestionAnswer wakes the role named in the asked-by clause", async () => {
  const root = tmpdir();
  const T = "Ship X? (asked by plan 2026-10-12)";
  fs.writeFileSync(path.join(root, "QUESTIONS.md"), `# Questions\n\n## Open\n\n### ${T}\n\nbody\n\n## Answered\n`);
  const r = await captureJson((res) => handleQuestionAnswer(fakeReq(JSON.stringify({ position: 1, title: T, decision: "yes" })), res, root));
  assert.equal(r.captured.status, 200);
  assert.equal(typeof (r.data as { wake?: unknown }).wake, "string");
});

test("handleQuestionAnswer answers, goes gone on stale input, and guards bad bodies and fences", async () => {
  const root = tmpdir();
  const file = path.join(root, "QUESTIONS.md");
  const T1 = "First: which renderer?";
  const T2 = "Second: which backend?";
  fs.writeFileSync(file, `# Questions\n\n## Open\n\n### ${T1}\n\nbody one\n\n### ${T2}\n\nbody two\n\n## Answered\n`);
  const serve = (body: unknown) => captureJson((res) => handleQuestionAnswer(fakeReq(JSON.stringify(body)), res, root));

  const ok = await serve({ position: 1, title: T1, decision: "use\nink" });
  assert.equal(ok.captured.status, 200);
  assert.deepEqual(ok.data, { ok: true, status: "answered", question: T1, decision: "use\nink", committed: false });
  const md = fs.readFileSync(file, "utf8");
  assert.match(md, new RegExp(`## Answered[\\s\\S]*### ${T1}[\\s\\S]*\\*\\*Answered \\d{4}-\\d{2}-\\d{2} by the user:\\*\\*\\n\\nuse\\nink\\n`));

  // The first title is stale now (the second entry is position 1), and position 5 is out of range.
  const stale = await serve({ position: 1, title: T1, decision: "x" });
  assert.deepEqual([stale.captured.status, stale.data], [200, { ok: true, status: "gone" }]);
  const range = await serve({ position: 5, title: T2, decision: "x" });
  assert.deepEqual([range.captured.status, range.data], [200, { ok: true, status: "gone" }]);
  assert.equal(fs.readFileSync(file, "utf8"), md);

  for (const bad of ["fine\n## Phantom\nmore", "x\n```\nunclosed"]) {
    const r = await serve({ position: 1, title: T2, decision: bad });
    assert.equal(r.captured.status, 400, bad);
    assert.ok((r.data as { error: string }).error.length > 0);
    assert.equal(fs.readFileSync(file, "utf8"), md);
  }

  assert.equal((await serve({ position: 1, title: T2, decision: "  " })).captured.status, 400);
  assert.equal((await serve({ position: 1.5, title: T2, decision: "x" })).captured.status, 400);
  assert.equal((await serve({ position: 1, decision: "x" })).captured.status, 400);
  assert.equal(fs.readFileSync(file, "utf8"), md);

  const fenced = "# Questions\n\n## Open\n\n### Q\n\n```\nunclosed\n\n## Answered\n";
  fs.writeFileSync(file, fenced);
  const f = await serve({ position: 1, title: "Q", decision: "x" });
  assert.equal(f.captured.status, 409);
  assert.match((f.data as { error: string }).error, /unclosed code fence/);
  assert.equal(fs.readFileSync(file, "utf8"), fenced);
});

// ---- POST /api/backlog-file: the Plans/Bugs tabs' New control ----
function serveBacklogFile(root: string, body: unknown) {
  return captureJson((res) => handleBacklogFile(fakeReq(JSON.stringify(body)), res, root));
}

function queuedTexts(root: string, role: string): string[] {
  const dir = roleInboxDir(root, role);
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")) : [];
}

test("handleBacklogFile files a bug or plan and wakes its role, and 400s bad input untouched", async () => {
  const root = tmpdir();
  writeBacklogFile(root, "BUGS.md", [{ heading: "## Open" }, { heading: "## Fixed" }]);
  writeBacklogFile(root, "PLANS.md", [{ heading: "## Planned" }, { heading: "## Done" }]);
  const today = new Date().getFullYear().toString();

  const bug = await serveBacklogFile(root, { kind: "bug", title: "  x  y " });
  assert.equal(bug.captured.status, 200);
  assert.deepEqual(bug.data, { ok: true, file: "BUGS.md", title: "x y", committed: false });
  assert.match(fs.readFileSync(path.join(root, "BUGS.md"), "utf8"), new RegExp(`### x y \\(reported by the user ${today}`));
  assert.deepEqual(queuedTexts(root, "bugfix"), [bugWakeText("x y")]);

  const plan = await serveBacklogFile(root, { kind: "plan", title: "add z" });
  assert.equal(plan.captured.status, 200);
  assert.deepEqual(plan.data, { ok: true, file: "PLANS.md", title: "add z", committed: false });
  assert.match(fs.readFileSync(path.join(root, "PLANS.md"), "utf8"), /### add z \(reported by the user/);
  assert.deepEqual(queuedTexts(root, "feature"), [planWakeText("add z")]);

  const bugsBefore = fs.readFileSync(path.join(root, "BUGS.md"), "utf8");
  const plansBefore = fs.readFileSync(path.join(root, "PLANS.md"), "utf8");
  for (const body of [
    { kind: "todo", title: "x" },
    { kind: "bug", title: "   " },
    { kind: "plan" },
    { kind: "bug", title: "a".repeat(DIRECTOR_PROMPT_MAX_CHARS + 10) },
  ]) {
    const bad = await serveBacklogFile(root, body);
    assert.equal(bad.captured.status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal(fs.readFileSync(path.join(root, "BUGS.md"), "utf8"), bugsBefore);
  assert.equal(fs.readFileSync(path.join(root, "PLANS.md"), "utf8"), plansBefore);
  assert.equal(queuedTexts(root, "bugfix").length, 1);
  assert.equal(queuedTexts(root, "feature").length, 1);
});

test("handleBacklogFile files an optional normalized body and 400s a bad one untouched", async () => {
  const root = tmpdir();
  writeBacklogFile(root, "BUGS.md", [{ heading: "## Open" }, { heading: "## Fixed" }]);
  writeBacklogFile(root, "PLANS.md", [{ heading: "## Planned" }, { heading: "## Done" }]);
  const plan = await serveBacklogFile(root, { kind: "plan", title: "add z", body: "Goal.\r\n\r\n- a  \n- b\n\n" });
  assert.equal(plan.captured.status, 200);
  assert.match(fs.readFileSync(path.join(root, "PLANS.md"), "utf8"), /### add z \(reported by the user[^\n]*\n\nGoal\.\n\n- a\n- b\n/);
  assert.deepEqual(queuedTexts(root, "feature"), [planWakeText("add z")]);
  const bug = await serveBacklogFile(root, { kind: "bug", title: "sym", body: "Steps.\n1. go" });
  assert.equal(bug.captured.status, 200);
  assert.match(fs.readFileSync(path.join(root, "BUGS.md"), "utf8"), /### sym \(reported by the user[^\n]*\n\nSteps\.\n1\. go\n/);

  const bugsBefore = fs.readFileSync(path.join(root, "BUGS.md"), "utf8");
  const plansBefore = fs.readFileSync(path.join(root, "PLANS.md"), "utf8");
  for (const body of [
    { kind: "bug", title: "x", body: "### phantom" },
    { kind: "plan", title: "x", body: "```\nunclosed" },
    { kind: "plan", title: "x", body: 7 },
  ]) {
    assert.equal((await serveBacklogFile(root, body)).captured.status, 400, JSON.stringify(body));
  }
  assert.equal(fs.readFileSync(path.join(root, "BUGS.md"), "utf8"), bugsBefore);
  assert.equal(fs.readFileSync(path.join(root, "PLANS.md"), "utf8"), plansBefore);
  assert.equal(queuedTexts(root, "bugfix").length, 1);
  assert.equal(queuedTexts(root, "feature").length, 1);
});

// ---- POST /api/backlog-cancel: the entry drawer's cancel ----
test("handleBacklogCancel removes the entry, answers gone for a stale title, 400s bad input, wakes nobody", async () => {
  const root = tmpdir();
  writeBacklogFile(root, "BUGS.md", [{ heading: "## Open", body: "### one\n\nbody\n\n### two (found by x 2026-10-01)\n\nbody" }, { heading: "## Fixed" }]);
  writeBacklogFile(root, "PLANS.md", [{ heading: "## Planned", body: "### p1\n\nbody" }, { heading: "## Done" }]);
  const serve = (body: unknown) => captureJson((res) => handleBacklogCancel(fakeReq(JSON.stringify(body)), res, root));
  const bugsPath = path.join(root, "BUGS.md");

  const stale = await serve({ kind: "bug", position: 1, title: "two (found by x 2026-10-01)" });
  assert.equal(stale.captured.status, 200);
  assert.deepEqual(stale.data, { ok: true, status: "gone" });
  const before = fs.readFileSync(bugsPath, "utf8");
  assert.ok(before.includes("### one"));

  const done = await serve({ kind: "bug", position: 2, title: "two (found by x 2026-10-01)" });
  assert.equal(done.captured.status, 200);
  assert.deepEqual(done.data, { ok: true, status: "cancelled", file: "BUGS.md", title: "two (found by x 2026-10-01)", committed: false });
  assert.ok(!fs.readFileSync(bugsPath, "utf8").includes("### two"));
  assert.ok(fs.readFileSync(bugsPath, "utf8").includes("### one"));

  const plan = await serve({ kind: "plan", position: 1, title: "p1" });
  assert.deepEqual(plan.data, { ok: true, status: "cancelled", file: "PLANS.md", title: "p1", committed: false });
  assert.ok(!fs.readFileSync(path.join(root, "PLANS.md"), "utf8").includes("### p1"));

  const bugsNow = fs.readFileSync(bugsPath, "utf8");
  for (const body of [
    { kind: "todo", position: 1, title: "x" },
    { kind: "bug", position: 0, title: "one" },
    { kind: "bug", position: 1 },
    { kind: "bug", position: 1, title: "" },
  ]) {
    assert.equal((await serve(body)).captured.status, 400, JSON.stringify(body));
  }
  assert.equal(fs.readFileSync(bugsPath, "utf8"), bugsNow);
  for (const role of ["bugfix", "feature", "director"]) assert.deepEqual(queuedTexts(root, role), []);
});

test("handleBacklogCancel adds workingNote only when a role holds the entry's claim", async () => {
  const root = tmpdir();
  writeBacklogFile(root, "PLANS.md", [{ heading: "## Planned", body: "### p1\n\nbody\n\n### p2\n\nbody" }, { heading: "## Done" }]);
  saveRunnerState(root, {
    ...loadRunnerState(root, "feature-2"),
    claim: { file: "PLANS.md", key: entryKey("p1"), title: "p1", at: 1, source: "assigned" },
  });
  const serve = (body: unknown) => captureJson((res) => handleBacklogCancel(fakeReq(JSON.stringify(body)), res, root));
  const claimed = await serve({ kind: "plan", position: 1, title: "p1" });
  assert.equal((claimed.data as { status: string }).status, "cancelled");
  assert.ok(String((claimed.data as { workingNote?: string }).workingNote).includes("tumwater abort --role feature-2"));
  const free = await serve({ kind: "plan", position: 1, title: "p2" });
  assert.ok(!("workingNote" in (free.data as object)));
});

test("handleBacklogCancel adds releasedNote naming the planned part that required the cancelled one", async () => {
  const root = tmpdir();
  const p1 = "S, part 1/2: a (planned 2026-10-01)";
  const p2 = "S, part 2/2: b (planned 2026-10-02; requires part 1/2 landed)";
  writeBacklogFile(root, "PLANS.md", [{ heading: "## Planned", body: `### ${p1}\n\nbody\n\n### ${p2}\n\nbody\n\n### p3\n\nbody` }, { heading: "## Done" }]);
  const serve = (body: unknown) => captureJson((res) => handleBacklogCancel(fakeReq(JSON.stringify(body)), res, root));
  const plain = await serve({ kind: "plan", position: 2, title: "p3" });
  assert.ok(!("releasedNote" in (plain.data as object)));
  const required = await serve({ kind: "plan", position: 1, title: p1 });
  const note = String((required.data as { releasedNote?: string }).releasedNote);
  assert.match(note, /plan #1 required it/);
  assert.ok(note.includes("S, part 2/2: b"));
});

test("handleBacklogRelease lifts the Refused note, wakes the kind's role, and answers gone, not_refused, and 400s without writing", async () => {
  const root = tmpdir();
  const note = "**Refused 2026-10-16 by feature: x**";
  writeBacklogFile(root, "PLANS.md", [{ heading: "## Planned", body: `### p1\n\n${note}\n\nbody\n\n### p2\n\nbody` }, { heading: "## Done" }]);
  writeBacklogFile(root, "BUGS.md", [{ heading: "## Open", body: `### b1\n\n${note.replace("feature", "bugfix")}\n\nbody` }, { heading: "## Fixed" }]);
  const serve = (body: unknown) => captureJson((res) => handleBacklogRelease(fakeReq(JSON.stringify(body)), res, root));
  const plansPath = path.join(root, "PLANS.md");
  const bugsPath = path.join(root, "BUGS.md");
  const wakePath = wakeRequestPath(root);

  const stale = await serve({ kind: "plan", position: 1, title: "other" });
  assert.deepEqual(stale.data, { ok: true, status: "gone" });
  const unrefused = await serve({ kind: "plan", position: 2, title: "p2" });
  assert.deepEqual(unrefused.data, { ok: true, status: "not_refused", title: "p2" });
  assert.ok(fs.readFileSync(plansPath, "utf8").includes(note));
  assert.ok(!fs.existsSync(wakePath));

  const plan = await serve({ kind: "plan", position: 1, title: "p1" });
  assert.deepEqual(plan.data, { ok: true, status: "released", file: "PLANS.md", title: "p1", committed: false, lifted: "refused" });
  assert.ok(!fs.readFileSync(plansPath, "utf8").includes("Refused"));
  assert.match(fs.readFileSync(wakePath, "utf8"), /feature/);

  const bug = await serve({ kind: "bug", position: 1, title: "b1" });
  assert.deepEqual(bug.data, { ok: true, status: "released", file: "BUGS.md", title: "b1", committed: false, lifted: "refused" });
  assert.match(fs.readFileSync(wakePath, "utf8"), /bugfix/);

  const bugsNow = fs.readFileSync(bugsPath, "utf8");
  for (const body of [
    { kind: "todo", position: 1, title: "x" },
    { kind: "bug", position: 0, title: "b1" },
    { kind: "bug", position: 1 },
    { kind: "bug", position: 1, title: "" },
  ]) {
    assert.equal((await serve(body)).captured.status, 400, JSON.stringify(body));
  }
  assert.equal(fs.readFileSync(bugsPath, "utf8"), bugsNow);
});

test("handleBacklogRelease and handleBacklogTop report a still-held entry in heldNote and wake no role on release", async () => {
  const root = tmpdir();
  writeBacklogFile(root, "PLANS.md", [
    {
      heading: "## Planned",
      body:
        "### Export series, part 1/2: a (planned 2026-10-01)\n\nbody\n\n" +
        "### Export series, part 2/2: b (planned 2026-10-02; requires part 1/2 landed)\n\nbody\n\n**Refused 2026-10-02 by feature: no**",
    },
    { heading: "## Done" },
  ]);
  const title = "Export series, part 2/2: b (planned 2026-10-02; requires part 1/2 landed)";
  const release = await captureJson((res) => handleBacklogRelease(fakeReq(JSON.stringify({ kind: "plan", position: 2, title })), res, root));
  const released = release.data as { status: string; heldNote?: string };
  assert.equal(released.status, "released");
  assert.match(String(released.heldNote), /^still held \[blocked: requires Export series 1\/2\]/);
  assert.ok(!fs.existsSync(wakeRequestPath(root)));
  const top = await captureJson((res) => handleBacklogTop(fakeReq(JSON.stringify({ kind: "plan", position: 2, title })), res, root));
  const moved = top.data as { status: string; heldNote?: string };
  assert.equal(moved.status, "moved_to_top");
  assert.match(String(moved.heldNote), /^still held \[blocked: requires Export series 1\/2\]/);
});

test("handleBacklogRelease lifts a Needs review note from a bug", async () => {
  const root = tmpdir();
  writeBacklogFile(root, "BUGS.md", [{ heading: "## Open", body: "### w1\n\n**Needs review 2026-10-16 by feature: too large for one run (held 3)**\n\nbody" }, { heading: "## Fixed" }]);
  const out = await captureJson((res) => handleBacklogRelease(fakeReq(JSON.stringify({ kind: "bug", position: 1, title: "w1" })), res, root));
  assert.deepEqual(out.data, { ok: true, status: "released", file: "BUGS.md", title: "w1", committed: false, lifted: "needs-review" });
  assert.ok(!fs.readFileSync(path.join(root, "BUGS.md"), "utf8").includes("Needs review"));
  assert.match(fs.readFileSync(wakeRequestPath(root), "utf8"), /bugfix/);
});

test("handleBacklogTop moves a plan or bug to the head, wakes no role, and answers already_first, gone, and 400s without writing", async () => {
  const root = tmpdir();
  writeBacklogFile(root, "PLANS.md", [{ heading: "## Planned", body: "### p1\n\nbody\n\n### p2\n\nbody" }, { heading: "## Done" }]);
  writeBacklogFile(root, "BUGS.md", [{ heading: "## Open", body: "### b1\n\nbody\n\n### b2\n\nbody" }, { heading: "## Fixed" }]);
  const serve = (body: unknown) => captureJson((res) => handleBacklogTop(fakeReq(JSON.stringify(body)), res, root));
  const plansPath = path.join(root, "PLANS.md");
  const bugsPath = path.join(root, "BUGS.md");

  const plan = await serve({ kind: "plan", position: 2, title: "p2" });
  assert.deepEqual(plan.data, { ok: true, status: "moved_to_top", file: "PLANS.md", title: "p2", committed: false });
  const plans = fs.readFileSync(plansPath, "utf8");
  assert.ok(plans.indexOf("### p2") < plans.indexOf("### p1"));
  const bug = await serve({ kind: "bug", position: 2, title: "b2" });
  assert.deepEqual(bug.data, { ok: true, status: "moved_to_top", file: "BUGS.md", title: "b2", committed: false });
  const bugs = fs.readFileSync(bugsPath, "utf8");
  assert.ok(bugs.indexOf("### b2") < bugs.indexOf("### b1"));

  const first = await serve({ kind: "plan", position: 1, title: "p2" });
  assert.deepEqual(first.data, { ok: true, status: "already_first", title: "p2" });
  const stale = await serve({ kind: "plan", position: 2, title: "other" });
  assert.deepEqual(stale.data, { ok: true, status: "gone" });
  assert.ok(!fs.existsSync(wakeRequestPath(root)));

  for (const body of [
    { kind: "todo", position: 1, title: "x" },
    { kind: "bug", position: 0, title: "b1" },
    { kind: "bug", position: 1 },
    { kind: "bug", position: 1, title: "" },
  ]) {
    assert.equal((await serve(body)).captured.status, 400, JSON.stringify(body));
  }
  assert.equal(fs.readFileSync(bugsPath, "utf8"), bugs);
  assert.equal(fs.readFileSync(plansPath, "utf8"), plans);
});

test("backlog 400s name the offending value, and stay terse when the field is missing", async () => {
  const root = tmpdir();
  writeBacklogFile(root, "BUGS.md", [{ heading: "## Open" }, { heading: "## Fixed" }]);
  const serve = (body: unknown) => captureJson((res) => handleBacklogCancel(fakeReq(JSON.stringify(body)), res, root));

  const badKind = await serve({ kind: "todo", position: 1, title: "x" });
  assert.match((badKind.data as { error: string }).error, /kind must be "bug" or "plan" \(got "todo"\)/);
  const badPosition = await serve({ kind: "bug", position: 0, title: "x" });
  assert.match((badPosition.data as { error: string }).error, /position must be a positive integer \(got 0\)/);
  const badTitle = await serve({ kind: "bug", position: 1, title: "" });
  assert.match((badTitle.data as { error: string }).error, /title must be a non-empty string \(got ""\)/);

  // A field the request never carried stays unnamed — no "(got undefined)".
  const missingKind = await serve({ position: 1, title: "x" });
  assert.match((missingKind.data as { error: string }).error, /^kind must be "bug" or "plan"$/);
  assert.doesNotMatch((missingKind.data as { error: string }).error, /got undefined/);
  const missingPosition = await serve({ kind: "bug", title: "x" });
  assert.match((missingPosition.data as { error: string }).error, /^position must be a positive integer$/);
  assert.doesNotMatch((missingPosition.data as { error: string }).error, /got undefined/);
  const missingTitle = await serve({ kind: "bug", position: 1 });
  assert.match((missingTitle.data as { error: string }).error, /^title must be a non-empty string$/);
  assert.doesNotMatch((missingTitle.data as { error: string }).error, /got undefined/);
});

// ---- POST /api/backlog-edit: the entry drawer's edit ----
test("handleBacklogEdit names a hold that survives the edit", async () => {
  const root = tmpdir();
  const refused = "**Refused 2026-10-01 by feature: too big**";
  writeBacklogFile(root, "PLANS.md", [{ heading: "## Planned", body: `### p1 (planned 2026-10-01 by plan)\n\nold\n\n${refused}` }, { heading: "## Done" }]);
  const serve = (body: unknown) => captureJson((res) => handleBacklogEdit(fakeReq(JSON.stringify(body)), res, root));
  const kept = await serve({ kind: "plan", position: 1, title: "p1 (planned 2026-10-01 by plan)", newTitle: "p2", newBody: `new\n\n${refused}` });
  assert.equal((kept.data as { status: string }).status, "edited");
  assert.match((kept.data as { heldNote: string }).heldNote, /^still held \[blocked: refused\]/);
  const dropped = await serve({ kind: "plan", position: 1, title: "p2 (planned 2026-10-01 by plan)", newTitle: "p3", newBody: "plain" });
  assert.equal((dropped.data as { status: string }).status, "edited");
  assert.equal("heldNote" in (dropped.data as object), false);
});

test("handleBacklogEdit rewrites the entry, answers gone for a stale title, 400s bad input, wakes nobody", async () => {
  const root = tmpdir();
  writeBacklogFile(root, "PLANS.md", [{ heading: "## Planned", body: "### p1 (planned 2026-10-01 by plan)\n\nold" }, { heading: "## Done" }]);
  const serve = (body: unknown) => captureJson((res) => handleBacklogEdit(fakeReq(JSON.stringify(body)), res, root));
  const plansPath = path.join(root, "PLANS.md");

  const stale = await serve({ kind: "plan", position: 1, title: "other", newTitle: "n", newBody: "b" });
  assert.deepEqual(stale.data, { ok: true, status: "gone" });
  assert.ok(fs.readFileSync(plansPath, "utf8").includes("old"));

  const before = fs.readFileSync(plansPath, "utf8");
  for (const body of [
    { kind: "todo", position: 1, title: "x", newTitle: "n", newBody: "" },
    { kind: "plan", position: 0, title: "x", newTitle: "n", newBody: "" },
    { kind: "plan", position: 1, title: "", newTitle: "n", newBody: "" },
    { kind: "plan", position: 1, title: "p1 (planned 2026-10-01 by plan)", newTitle: "  ", newBody: "" },
    { kind: "plan", position: 1, title: "p1 (planned 2026-10-01 by plan)", newTitle: "n", newBody: 5 },
    { kind: "plan", position: 1, title: "p1 (planned 2026-10-01 by plan)", newTitle: "n", newBody: "a\n### H" },
  ]) {
    assert.equal((await serve(body)).captured.status, 400, JSON.stringify(body));
  }
  assert.equal(fs.readFileSync(plansPath, "utf8"), before);

  const same = await serve({ kind: "plan", position: 1, title: "p1 (planned 2026-10-01 by plan)", newTitle: "p1", newBody: "old" });
  assert.deepEqual(same.data, { ok: true, status: "unchanged", file: "PLANS.md", title: "p1" });
  assert.equal(fs.readFileSync(plansPath, "utf8"), before);

  const done = await serve({ kind: "plan", position: 1, title: "p1 (planned 2026-10-01 by plan)", newTitle: "p2", newBody: "l1\n\nl2" });
  assert.equal(done.captured.status, 200);
  assert.deepEqual(done.data, { ok: true, status: "edited", file: "PLANS.md", title: "p2", committed: false });
  assert.ok(fs.readFileSync(plansPath, "utf8").includes("### p2 (planned 2026-10-01 by plan)\n\nl1\n\nl2"));
  for (const role of ["bugfix", "feature", "director"]) assert.deepEqual(queuedTexts(root, role), []);
});

test("handleRoleNotes writes, clears, and rejects bad input without touching the note", async () => {
  const root = tmpdir();
  const notes = roleNotesPath(root, "feature");
  const post = (body: unknown) => captureJson((res) => handleRoleNotes(fakeReq(JSON.stringify(body)), res, root));

  const ok = await post({ role: "feature", text: "x\ny" });
  assert.equal(ok.captured.status, 200);
  assert.deepEqual(ok.data, { ok: true, message: "notes saved (3 bytes)" });
  assert.equal(fs.readFileSync(notes, "utf8"), "x\ny");

  const bad = [
    [{ role: "nope", text: "z" }, /^unknown role "nope"/],
    [{ role: DIRECTOR_ROLE, text: "z" }, /^the director has no notes$/],
    [{ role: "feature", text: 5 }, /"text" must be a string/],
    [{ role: "feature", text: "a".repeat(ROLE_NOTES_MAX_BYTES + 1) }, new RegExp(`note is ${ROLE_NOTES_MAX_BYTES + 1} bytes`)],
  ] as const;
  for (const [body, re] of bad) {
    const r = await post(body);
    assert.equal(r.captured.status, 400);
    assert.match((r.data as { error: string }).error, re);
    assert.equal(fs.readFileSync(notes, "utf8"), "x\ny", "note unchanged");
  }
  assert.equal(fs.existsSync(roleNotesPath(root, DIRECTOR_ROLE)), false);

  const cleared = await post({ role: "feature", text: "" });
  assert.deepEqual(cleared.data, { ok: true, message: "notes cleared" });
  assert.equal(fs.readFileSync(notes, "utf8"), "");
});

test("GET /api/brief serves the brief file and prompt; a repo without a prompt block is a 404", async () => {
  const repo = await initializedRepo();
  const ok = await captureJson((res) => handleBrief(res, repo));
  assert.equal(ok.captured.status, 200);
  assert.deepEqual(ok.data, { file: "README.md", prompt: "A test project." });
  const bare = await captureJson((res) => handleBrief(res, makeRepo()));
  assert.equal(bare.captured.status, 404);
  assert.match((bare.data as { error: string }).error, /tumwater init/);
});

test("POST /api/brief replaces the prompt and commits on main; refusals leave the file and history alone", async () => {
  const repo = await initializedRepo();
  const post = (body: unknown) => captureJson((res) => handleBriefEdit(fakeReq(JSON.stringify(body)), res, repo));
  const head = () => sh(repo, "git", "rev-parse", "HEAD");
  const ok = await post({ prompt: "new idea" });
  assert.equal(ok.captured.status, 200);
  assert.deepEqual(ok.data, { file: "README.md", changed: true, committed: true });
  assert.equal(readBrief(repo)?.prompt, "new idea");
  assertClean(repo);
  assert.equal(sh(repo, "git", "log", "-1", "--format=%s"), "tumwater(operator): Edit brief");
  const after = head();
  const again = await post({ prompt: "new idea" });
  assert.deepEqual(again.data, { file: "README.md", changed: false, committed: false });
  assert.equal(head(), after);
  const before = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  for (const prompt of ["  ", "x".repeat(BRIEF_TEXT_MAX_CHARS + 1), PROMPT_START, 5]) {
    const bad = await post({ prompt });
    assert.equal(bad.captured.status, 400);
    assert.match((bad.data as { error: string }).error, /\S/);
  }
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), before);
  assert.equal(head(), after);
  const missing = await post({});
  assert.equal(missing.captured.status, 400);
  assert.doesNotMatch((missing.data as { error: string }).error, /got undefined/);
});

test("handleNotifyTest runs the saved hook and answers its verdict; no hook is a 409", async () => {
  const root = await initializedRepo();
  const none = await captureJson((res) => handleNotifyTest(fakeReq("{}"), res, root));
  assert.equal(none.captured.status, 409);
  assert.match((none.data as { error: string }).error, /notify is not configured/);
  const out = path.join(root, "notify-out.txt");
  assert.ok(setConfigKey(root, "notify", `echo "$TUMWATER_EVENT_TYPE" >> ${out}`).ok);
  const ok = await captureJson((res) => handleNotifyTest(fakeReq("{}"), res, root));
  assert.equal(ok.captured.status, 200);
  assert.deepEqual(ok.data, { ok: true, passed: true, message: "notify hook exited 0" });
  assert.equal(fs.readFileSync(out, "utf8").split("\n").filter(Boolean).length, 1);
  assert.ok(setConfigKey(root, "notify", "exit 3").ok);
  const bad = await captureJson((res) => handleNotifyTest(fakeReq("{}"), res, root));
  assert.equal(bad.captured.status, 200);
  assert.equal((bad.data as { passed: boolean }).passed, false);
});

test("dashboard role and Settings writes say when the value was already in place", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), {});
  const bytes = () => fs.readFileSync(configPath(root));
  const msg = (r: { data: unknown }) => (r.data as { message: string }).message;
  // Each pair: the first write answers its usual message, the second is a byte-identical no-op.
  const cases: Array<[string, (b: unknown) => Promise<{ data: unknown }>, unknown, RegExp, RegExp]> = [
    ["interval", (b) => serveRoleInterval(root, b), { role: "feature", minRunIntervalSeconds: 300 }, /min run interval set to 300s/, /min run interval is already 300s/],
    ["instances", (b) => serveRoleInstances(root, b), { role: "feature", instances: 2 }, /instances set to 2/, /instances is already 2/],
    ["quiet hours", (b) => serveRoleQuietHours(root, b), { role: "feature", window: "23:00-07:00" }, /quiet hours set to/, /quiet hours unchanged/],
    ["model", (b) => serveRoleModel(root, b), { role: "feature", provider: "huggingface", model: "claude-opus-5", thinking: "high" }, /model updated/, /model overrides unchanged/],
    ["enable", (b) => serveRoleEnable(root, b), { role: "feature" }, /already enabled/, /already enabled/],
  ];
  for (const [name, serve, body, first, second] of cases) {
    const one = await serve(body);
    if (name !== "enable") assert.match(msg(one), first, name);
    const afterFirst = bytes();
    const two = await serve(body);
    assert.match(msg(two), second, name);
    assert.equal(bytes().equals(afterFirst), true, name + " second write leaves the file byte-identical");
  }
  const cap1 = await serveRoleCap(root, { role: "feature", maxDailyCostUsd: 2 });
  assert.equal((cap1.data as { unchanged?: boolean }).unchanged, undefined);
  const cap2 = await serveRoleCap(root, { role: "feature", maxDailyCostUsd: 2 });
  assert.equal((cap2.data as { unchanged?: boolean }).unchanged, true);
  const set1 = await serveConfigSet(root, { key: "maxDailyCostUsd", value: 30 });
  assert.equal((set1.data as { unchanged?: boolean }).unchanged, undefined);
  const set2 = await serveConfigSet(root, { key: "maxDailyCostUsd", value: 30 });
  assert.equal((set2.data as { unchanged?: boolean }).unchanged, true);
});
