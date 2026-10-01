// The status payload is the data contract behind /api/status, `status --json`, and every
// client-side render on the dashboard; these tests pin what it carries directly, without a
// server in the loop — the routes and page behavior live in test/gui.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { initProject } from "../src/init.js";
import { dequeuePrompt, submitPrompt } from "../src/inbox.js";
import { orchestratorStatePath, pausedPath, piLogPath } from "../src/paths.js";
import { freshLoopState, saveLoopState } from "../src/loop-state.js";
import { todayStamp } from "../src/budget.js";
import { writeLogLines, writeOrchestratorMarker, writeMarker } from "./log-fixtures.js";
import { makeRepo, writeBacklogFile } from "./repo-fixtures.js";
import { assistantLine } from "./pi-events.js";

const SESSION = JSON.stringify({ type: "session", version: 3, id: "x" });

test("status payload marks user-defined loops with the custom flag", async () => {
  const repo = makeRepo();
  await initProject(repo, "payload custom test");
  const cfg = loadConfig(repo);
  cfg.customLoops.push({ name: "nightly", task: "do the nightly thing" });
  saveConfig(repo, cfg);
  // The payload's structural fixture type tolerates the extra field — assert on it directly.
  const payload = statusPayload(repo) as { loops: Array<{ role: string; custom?: boolean }> };
  assert.ok(payload.loops.some((l) => l.role === "nightly" && l.custom === true), "listed custom is marked");
  assert.equal(
    payload.loops.filter((l) => l.custom).length,
    1,
    "only the custom carries the flag",
  );
});

test("status payload combines persisted + live token metrics for running loops only", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui metrics test");
  // Persisted totals from completed ticks...
  const s = freshLoopState("feature");
  s.generatedTokens = 1_000;
  s.peakContextTokens = 6_000;
  s.running = true; // a tick is in flight
  saveLoopState(repo, s);
  // ...and the in-flight tick's log tail (800 output so far, peak context 12k).
  const file = piLogPath(repo, "feature");
  writeLogLines(file, [SESSION, assistantLine("turn one", { tokens: 8_000, output: 300 }), assistantLine("turn two", { tokens: 12_000, output: 500 })]);
  const payload = statusPayload(repo) as {
    loops: Array<{ role: string; generated: number; peakCtx: number }>;
  };
  const feature = payload.loops.find((l) => l.role === "feature");
  assert.ok(feature, "feature loop present in payload");
  assert.equal(feature.generated, 1_800, "running loop gen = persisted + live output (1000+300+500)");
  assert.equal(feature.peakCtx, 12_000, "running loop peak ctx = max(persisted, live)");
});

test("status payload carries the current work item for running loops only", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui work item test");
  // A running loop whose in-flight tick has spoken its work item...
  const s = freshLoopState("feature");
  s.running = true;
  saveLoopState(repo, s);
  const file = piLogPath(repo, "feature");
  writeLogLines(file, [SESSION, assistantLine('implement plan "Linear history on main"')]);
  // ...and an idle loop whose log tail is a finished tick (must not leak its item).
  saveLoopState(repo, freshLoopState("clean"));
  const file2 = piLogPath(repo, "clean");
  writeLogLines(file2, [SESSION, assistantLine("old finished work")]);

  const payload = statusPayload(repo) as {
    loops: Array<{ role: string; currentWork: string | null }>;
  };
  assert.equal(
    payload.loops.find((l) => l.role === "feature")?.currentWork,
    'implement plan "Linear history on main"',
    "running loop shows its in-flight work item",
  );
  assert.equal(payload.loops.find((l) => l.role === "clean")?.currentWork, null, "idle loop never shows a stale item");
});

// The per-loop today spend on the GUI surface (PLANS.md "Per-loop today spend"): /api/status
// carries todayUsd per loop — the daily budget window, 0 while its stamp is stale or missing,
// same helper and semantics as the TUI's `today` column — and the page renders its cell
// client-side from that field.

test("status payload carries todayUsd per loop from its daily window", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui today spend test");
  // A state file with today's stamp rides the payload...
  const fresh = freshLoopState("clean");
  fresh.dayStamp = todayStamp();
  fresh.dayCostUsd = 12.34;
  saveLoopState(repo, fresh);
  // ...a stale-stamp file with positive spend reads zero (dailyCost's rule)...
  const stale = freshLoopState("dry");
  stale.dayStamp = todayStamp(Date.now() - 86_400_000);
  stale.dayCostUsd = 5.67;
  saveLoopState(repo, stale);

  let payload = statusPayload(repo) as { loops: Array<{ role: string; todayUsd: number }> };
  assert.equal(payload.loops.find((l) => l.role === "clean")?.todayUsd, 12.34, "fresh window rides the payload");
  assert.equal(payload.loops.find((l) => l.role === "dry")?.todayUsd, 0, "stale stamp reads zero");

  // A loop that never ticked (default state file) also carries an explicit zero field.
  saveLoopState(repo, freshLoopState("organize"));
  payload = statusPayload(repo) as typeof payload;
  assert.equal(payload.loops.find((l) => l.role === "organize")?.todayUsd, 0, "missing window reads zero");
});

// Project status: planned features and open bugs from PLANS.md/BUGS.md.

test("status payload carries planned plans and open bugs, fresh per poll", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui backlog test"); // seeds placeholder files with no entries
  let payload = statusPayload(repo) as { plans: string[]; bugs: string[] };
  assert.deepEqual(payload.plans, [], "seeded _None yet._ placeholders are not entries");
  assert.deepEqual(payload.bugs, []);

  // A later edit to the tracked markdown is visible on the next payload (no caching).
  // Entries must land inside their sections — appending would file them under Done/Fixed.
  writeBacklogFile(repo, "PLANS.md", [
    {
      heading: "## Planned",
      body: "### Show open bugs and planned features in the TUI/GUI (planned 2026-08-24)\n\n**Goal:** The dashboard surfaces project status.",
    },
    { heading: "## Done" },
  ]);
  writeBacklogFile(repo, "BUGS.md", [
    {
      heading: "## Open",
      body: "### A routine merge conflict logs a warning (reported 2026-08-25)\n\n**Symptom:** The main log is full of warnings.",
    },
    { heading: "## Fixed" },
  ]);
  payload = statusPayload(repo) as { plans: string[]; bugs: string[] };
  assert.deepEqual(payload.plans, ["Show open bugs and planned features in the TUI/GUI (planned 2026-08-24)"]);
  assert.deepEqual(payload.bugs, ["A routine merge conflict logs a warning (reported 2026-08-25)"]);
});

// Open questions (QUESTIONS.md) drive the dashboard's `questions: N` header badge and its
// open-questions panel section — both derived client-side from the payload's list.

test("status payload carries open questions, fresh per poll", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui questions test"); // seeds a placeholder QUESTIONS.md with no entries
  let payload = statusPayload(repo) as { questions: string[] };
  assert.deepEqual(payload.questions, [], "seeded _None yet._ placeholders are not entries");

  // A question posted under ## Open shows on the next poll; an entry in ## Answered must
  // never leak into the open list — the header badge count is this list's length.
  writeBacklogFile(repo, "QUESTIONS.md", [
    {
      heading: "## Open",
      body: "### Q1: which database?\n\n**Context:** the storage layer is undecided.",
    },
    { heading: "## Answered", body: "### Q0: earlier question (answered 2026-08-27)" },
  ]);
  payload = statusPayload(repo) as { questions: string[] };
  assert.deepEqual(payload.questions, ["Q1: which database?"], "only the Open section counts");

  // Answering it (moving the entry to ## Answered) drops it on the next poll — a stale
  // cache would keep the badge showing `questions: 1` long after the decision was made.
  writeBacklogFile(repo, "QUESTIONS.md", [
    { heading: "## Open" },
    {
      heading: "## Answered",
      body: "### Q1: which database? (answered 2026-08-29)\n\n**Decision:** SQLite.",
    },
  ]);
  payload = statusPayload(repo) as { questions: string[] };
  assert.deepEqual(payload.questions, [], "an answered question is no longer open");
});

// Queued director prompts ride /api/status as truncated previews in execution order; the
// project status panel lists them like its other sections — (none) while the inbox is empty.

test("status payload carries queued prompt previews, fresh per poll", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui inbox test"); // no inbox dir yet
  let payload = statusPayload(repo) as { inbox: number; inboxPrompts: string[] };
  assert.equal(payload.inbox, 0);
  assert.deepEqual(payload.inboxPrompts, []);

  submitPrompt(repo, "fix the login bug");
  submitPrompt(repo, "y".repeat(120)); // overlong → truncated preview in the payload
  payload = statusPayload(repo) as { inbox: number; inboxPrompts: string[] };
  assert.equal(payload.inbox, 2);
  assert.deepEqual(payload.inboxPrompts[0], "fix the login bug");
  const preview = payload.inboxPrompts[1]!;
  assert.ok(preview.length <= 80 && preview.endsWith("…"), `preview truncated: ${JSON.stringify(preview)}`);

  // Fresh per poll: the director consuming one drops it from the next payload.
  dequeuePrompt(repo);
  payload = statusPayload(repo) as { inbox: number; inboxPrompts: string[] };
  assert.equal(payload.inbox, 1);
  assert.deepEqual(payload.inboxPrompts, [preview]);
});

// The build badge on the GUI surface: /api/status carries it pre-formatted through
// badges.ts's buildBadge — the same string the TUI header renders — so the page cannot
// re-derive (and drift from) the multi-branch text client-side.

test("status payload carries the build badge pre-formatted by buildBadge", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui build badge test");
  // No harness running: no stamp, empty badge (the page renders nothing for it).
  let payload = statusPayload(repo) as { build: unknown; buildBadge: string };
  assert.equal(payload.build, null);
  assert.equal(payload.buildBadge, "", "no running harness: empty badge");

  // A live orchestrator (this process) publishing a stale stamp with a blocked restart:
  // the payload's badge is exactly what badges.ts's buildBadge renders for that BuildStatus.
  const { buildBadge } = await import("../src/ui/badges.js");
  const stamp = {
    sha: "a".repeat(40), builtAt: 1, stale: true, aheadCommits: 7,
    checkedHead: "b".repeat(40), restartBlocked: "main cccccccc is red",
  };
  writeOrchestratorMarker(repo, ["clean"], { build: stamp });
  payload = statusPayload(repo) as typeof payload;
  assert.equal(payload.buildBadge, buildBadge(stamp), "one home for the badge text");
  assert.match(payload.buildBadge, /build aaaaaaaa — STALE: main \+7 commit\(s\) since; restart BLOCKED: main cccccccc is red$/);
});

// The operator pause on the GUI surface (PLANS.md, fleet-pause plan): /api/status — and
// therefore `status --json`, same payload — carries `paused` while the marker exists, and a
// paused fleet's idle role loops read `paused` in their phase payload ahead of budget paused.

test("the status payload carries the operator pause flag; its phase outranks budget paused", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui fleet pause test");
  // A live orchestrator (this process) so loopPhase doesn't short-circuit to "stopped"…
  writeOrchestratorMarker(repo, ["clean"]);

  // No marker: not paused.
  let payload = statusPayload(repo) as {
    paused: boolean;
    loops: Array<{ role: string; phase: string }>;
  };
  assert.equal(payload.paused, false);
  assert.notEqual(payload.loops.find((l) => l.role === "clean")?.phase, "paused");

  // Drop the marker (what `tumwater pause` does) with spend at the cap: the flag flips and
  // the idle loop's phase reads `paused`, ahead of budget paused.
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsd = 10;
  saveConfig(repo, cfg);
  const s = freshLoopState("clean");
  s.dayStamp = todayStamp();
  s.dayCostUsd = 12.5; // >= cap → budget paused too
  saveLoopState(repo, s);
  const marker = pausedPath(repo);
  writeMarker(marker, { at: Date.now() });

  payload = statusPayload(repo) as typeof payload;
  assert.equal(payload.paused, true, "the flag rides the payload top level");
  assert.equal(
    payload.loops.find((l) => l.role === "clean")?.phase,
    "paused",
    "user pause outranks budget paused in the phase payload",
  );
  // The director is exempt — its phase keeps its own label.
  assert.equal(payload.loops.find((l) => l.role === "director")?.phase, "waiting for prompts");

  // Removing the marker (what `tumwater resume` does) reverts both: flag false, and with the
  // spend still at the cap the loop falls back to budget paused.
  fs.rmSync(marker);
  payload = statusPayload(repo) as typeof payload;
  assert.equal(payload.paused, false);
  assert.equal(payload.loops.find((l) => l.role === "clean")?.phase, "budget paused");

  fs.rmSync(orchestratorStatePath(repo), { force: true });
});

test("the status payload names the project and carries the recent events as data", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui event items test");
  const { logEvent } = await import("../src/events.js");
  const { formatEvent } = await import("../src/event-format.js");
  logEvent(repo, { loop: "qa", type: "tick_end", tick: 3, result: "error", error: "429 Rate limit exceeded" });
  logEvent(repo, { loop: "bugfix", type: "merged", commit: "a".repeat(40), summary: "Escape backlog bodies" });
  logEvent(repo, { loop: "bugfix", type: "build_check", scope: "landing", script: "test", status: "failed" });
  const payload = statusPayload(repo) as {
    project: string;
    events: string[];
    eventItems: Array<{ ts: number; loop: string; type: string; result?: string; message: string }>;
  };
  assert.equal(payload.project, path.basename(repo), "the project is the directory's name");
  assert.equal(payload.eventItems.length, payload.events.length, "one item per feed line");
  const tail = payload.eventItems.slice(-3);
  assert.deepEqual(tail.map((e) => [e.loop, e.type, e.result]), [["qa", "tick_end", "error"], ["bugfix", "merged", undefined], ["bugfix", "build_check", "failed"]]);
  // Each item's message is its feed line without the time and loop columns.
  for (const [i, item] of payload.eventItems.entries()) {
    assert.ok(payload.events[i]!.endsWith(" " + item.message), `line ${i} ends with its item's message`);
  }
  assert.equal(tail[1]!.message, `merged aaaaaaaa to main — Escape backlog bodies`);
  assert.equal(formatEvent({ ts: tail[1]!.ts, loop: "bugfix", type: "merged", commit: "a".repeat(40), summary: "Escape backlog bodies" }), payload.events.at(-2));
});

test("the status payload carries each loop's last error for the rows that failed", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui last error test");
  const s = freshLoopState("qa");
  s.lastResult = "error";
  s.lastError = "429 Rate limit exceeded";
  saveLoopState(repo, s);
  saveLoopState(repo, freshLoopState("clean"));
  const payload = statusPayload(repo) as { loops: Array<{ role: string; lastError: string | null }> };
  assert.equal(payload.loops.find((l) => l.role === "qa")?.lastError, "429 Rate limit exceeded");
  assert.equal(payload.loops.find((l) => l.role === "clean")?.lastError, null);
});


test("statusPayload exposes each loop's nextRunAt and backoffSeconds", async () => {
  const repo = makeRepo();
  await initProject(repo, "payload schedule test");
  const state = freshLoopState("clean");
  state.nextRunAt = 1_758_800_000_000;
  state.backoffSeconds = 90;
  saveLoopState(repo, state);

  const payload = statusPayload(repo) as { loops: Array<{ role: string; nextRunAt: number; backoffSeconds: number }> };
  const clean = payload.loops.find((l) => l.role === "clean");
  assert.ok(clean, "the loop has a payload row");
  assert.equal(clean.nextRunAt, 1_758_800_000_000, "raw epoch ms, formatted client-side");
  assert.equal(clean.backoffSeconds, 90);
});
