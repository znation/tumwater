// The status payload is the data contract behind /api/status, `status --json`, and every
// client-side render on the dashboard; these tests pin what it carries directly, without a
// server in the loop — the routes and page behavior live in test/gui.test.ts.

import test from "node:test";
import { scheduleStop } from "../src/team/team-state.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { groupBlockedSeries, partsLabel } from "../src/backlog/backlog-index-data.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { refreshOrphanAlert, orphanAlertFromScan } from "../src/ui/alert-feeds.js";
import { PROMPT_END, PROMPT_START, BRIEF_TEXT_MAX_CHARS } from "../src/brief/brief.js";
import { checkOrphans, findOrphans } from "../src/doctor/doctor-orphans.js";
import { enqueueMerge } from "../src/merge/merge-queue.js";
import { initProject } from "../src/init/init.js";
import { dequeuePrompt } from "../src/inbox/inbox.js";
import { submitPrompt } from "../src/inbox/inbox-submit.js";
import { requestWake } from "../src/operator/operator-intent.js";
import { renderStatus } from "../src/ui/status-render.js";
import { snapshot } from "../src/status/status-data.js";
import { orchestratorStatePath, pausedPath, piLogPath, postReviewPath, roleNotesPath } from "../src/paths.js";
import { writeJsonFile } from "../src/files/json-files.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { writeSlotsState } from "../src/git/slots-state.js";
import { slotWorktreePath } from "../src/paths.js";
import { todayStamp } from "../src/budget/budget.js";
import { PRINCIPLES_MAX_CHARS } from "../src/prompt/principles.js";
import { writeEvents, writeLogLines, writeOrchestratorMarker, writeMarker } from "./fixtures/log-fixtures.js";
import { makeRepo, tmpdir, writeBacklogFile, writeConfig } from "./fixtures/repo-fixtures.js";
import { writeModelsFile } from "./fixtures/models-fixtures.js";
import { fakeProbe } from "./fixtures/doctor-fixtures.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { ROLE_NOTES_MAX_BYTES } from "../src/agent/role-notes-write.js";

const SESSION = JSON.stringify({ type: "session", version: 3, id: "x" });

test("status payload carries the pooled worktree slot a role holds or is pinned to", async () => {
  const repo = makeRepo();
  await initProject(repo, "pool slot test");
  // A live run lease: the row names the slot, unpinned.
  writeSlotsState(repo, {
    slots: [
      {
        dir: slotWorktreePath(repo, 1),
        lease: { role: "feature", purpose: "run", since: Date.now(), pid: process.pid },
        pinnedFor: null,
        lastRole: null,
        lastReleasedAt: null,
      },
    ],
  });
  let payload = statusPayload(repo) as { roles: Array<{ role: string; slot?: string; slotPinned?: boolean }> };
  const held = payload.roles.find((l) => l.role === "feature");
  assert.equal(held?.slot, "_slot-1");
  assert.equal(held?.slotPinned, false);

  // A pin with no lease: the same slot, marked pinned. A role with no slot carries neither field.
  writeSlotsState(repo, {
    slots: [
      {
        dir: slotWorktreePath(repo, 2),
        lease: null,
        pinnedFor: "feature",
        pinnedAt: Date.now(),
        lastRole: null,
        lastReleasedAt: null,
      },
    ],
  });
  payload = statusPayload(repo) as typeof payload;
  const pinned = payload.roles.find((l) => l.role === "feature");
  assert.equal(pinned?.slot, "_slot-2");
  assert.equal(pinned?.slotPinned, true);
  assert.equal(payload.roles.find((l) => l.role === "bugfix")?.slot, undefined);
});

test("status payload carries an instance's claim title and base role", async () => {
  const repo = makeRepo();
  await initProject(repo, "payload claims test");
  const cfg = loadConfig(repo);
  const feature = cfg.roles.feature;
  assert.ok(feature, "the default config carries the feature role");
  feature.instances = 2;
  saveConfig(repo, cfg);
  saveRunnerState(repo, {
    ...freshRunnerState("feature-2"),
    claim: { file: "PLANS.md", key: "plan a", title: "Plan A", at: Date.now(), source: "assigned" },
  });
  const payload = statusPayload(repo) as {
    roles: Array<{ role: string; claim?: string; instanceOf?: string }>;
  };
  const inst = payload.roles.find((l) => l.role === "feature-2");
  assert.equal(inst?.claim, "Plan A", "the instance row carries the claimed title");
  assert.equal(inst?.instanceOf, "feature", "the instance row names its base role");
  // The bare role keeps neither field (the common payload shape is unchanged).
  const bare = payload.roles.find((l) => l.role === "feature");
  assert.equal(bare?.claim, undefined);
  assert.equal(bare?.instanceOf, undefined);
  // Runners above `instances` (the surplus pool) show only while they hold something.
  const ids = payload.roles.map((l) => l.role);
  assert.equal(ids.includes("feature-3"), false, "an idle surplus runner has no row");
  assert.equal(ids.includes("feature-4"), false);
  saveRunnerState(repo, {
    ...freshRunnerState("feature-3"),
    claim: { file: "PLANS.md", key: "plan b", title: "Plan B", at: Date.now(), source: "assigned" },
  });
  const later = statusPayload(repo) as typeof payload;
  assert.equal(later.roles.some((l) => l.role === "feature-3"), true, "a surplus runner with a claim shows");
  assert.equal(later.roles.some((l) => l.role === "feature-4"), false);
});

test("status payload marks user-defined roles with the custom flag", async () => {
  const repo = makeRepo();
  await initProject(repo, "payload custom test");
  const cfg = loadConfig(repo);
  cfg.customRoles.push({ name: "nightly", task: "do the nightly thing" });
  saveConfig(repo, cfg);
  // The payload's structural fixture type tolerates the extra field — assert on it directly.
  const payload = statusPayload(repo) as { roles: Array<{ role: string; custom?: boolean }> };
  assert.ok(payload.roles.some((l) => l.role === "nightly" && l.custom === true), "listed custom is marked");
  assert.equal(
    payload.roles.filter((l) => l.custom).length,
    1,
    "only the custom carries the flag",
  );
});

test("status payload combines persisted + live token metrics for running roles only", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui metrics test");
  // Persisted totals from completed runs…
  const s = freshRunnerState("feature");
  s.generatedTokens = 1_000;
  s.peakContextTokens = 6_000;
  s.running = true; // a run is in flight
  saveRunnerState(repo, s);
  // …and the in-flight run's log tail (800 output so far, peak context 12k).
  const file = piLogPath(repo, "feature");
  writeLogLines(file, [SESSION, assistantLine("turn one", { tokens: 8_000, output: 300 }), assistantLine("turn two", { tokens: 12_000, output: 500 })]);
  const payload = statusPayload(repo) as {
    roles: Array<{ role: string; generated: number; peakCtx: number }>;
  };
  const feature = payload.roles.find((l) => l.role === "feature");
  assert.ok(feature, "feature role present in payload");
  assert.equal(feature.generated, 1_800, "running role gen = persisted + live output (1000+300+500)");
  assert.equal(feature.peakCtx, 12_000, "running role peak ctx = max(persisted, live)");
});

// Part 3c/… — a role whose resolved seam declares a window carries a preformatted peak-ctx
// share (`peakCtxLabel`), so the GUI and `status --json` print the same `NN%` the TUI table
// shows; a role without a declared window carries no label at all, leaving the shape unchanged.
test("a role with a declared window carries peakCtxLabel", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui peakCtxLabel test");
  writeConfig(repo, { provider: "local", model: "big" });
  const modelsFile = writeModelsFile(
    tmpdir("status-payload-window-"),
    JSON.stringify({ providers: { local: { models: [{ id: "big", contextWindow: 262144 }] } } }),
  );
  const s = freshRunnerState("feature");
  s.peakContextTokens = 110_000;
  s.generatedTokens = 1_000;
  saveRunnerState(repo, s);
  const payload = statusPayload(repo, Date.now(), null, modelsFile) as {
    roles: Array<{ role: string; peakCtx: number; peakCtxLabel?: string }>;
  };
  const feature = payload.roles.find((l) => l.role === "feature");
  assert.ok(feature, "feature role present in payload");
  assert.match(feature.peakCtxLabel ?? "", /\(\d+%\)$/, "declared window ships the label");

  // A role whose seam resolves no window carries no label, leaving the payload shape unchanged.
  const repo2 = makeRepo();
  await initProject(repo2, "gui peakCtxLabel bare test");
  const barePayload = statusPayload(repo2, Date.now(), null, modelsFile) as {
    roles: Array<{ role: string; peakCtx: number; peakCtxLabel?: string }>;
  };
  const bareFeature = barePayload.roles.find((l) => l.role === "feature");
  assert.ok(bareFeature, "bare feature role present");
  assert.equal(bareFeature.peakCtxLabel, undefined, "no declared window carries no label");
});

test("status payload carries the current work item for running roles only", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui work item test");
  // A running role whose in-flight run has spoken its work item…
  const s = freshRunnerState("feature");
  s.running = true;
  saveRunnerState(repo, s);
  const file = piLogPath(repo, "feature");
  writeLogLines(file, [SESSION, assistantLine('implement plan "Linear history on main"')]);
  // …and an idle role whose log tail is a finished run (must not leak its item).
  saveRunnerState(repo, freshRunnerState("clean"));
  const file2 = piLogPath(repo, "clean");
  writeLogLines(file2, [SESSION, assistantLine("old finished work")]);

  const payload = statusPayload(repo) as {
    roles: Array<{ role: string; currentWork: string | null }>;
  };
  assert.equal(
    payload.roles.find((l) => l.role === "feature")?.currentWork,
    'implement plan "Linear history on main"',
    "running role shows its in-flight work item",
  );
  assert.equal(payload.roles.find((l) => l.role === "clean")?.currentWork, null, "idle role never shows a stale item");
});

// The per-role today spend on the GUI surface: /api/status
// carries todayUsd per role — the daily budget window, 0 while its stamp is stale or missing,
// same helper and semantics as the TUI's `today` column — and the page renders its cell
// client-side from that field.

test("status payload carries todayUsd per role from its daily window", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui today spend test");
  // A state file with today's stamp rides the payload…
  const fresh = freshRunnerState("clean");
  fresh.dayStamp = todayStamp();
  fresh.dayCostUsd = 12.34;
  saveRunnerState(repo, fresh);
  // …a stale-stamp file with positive spend reads zero (dailyCost's rule)…
  const stale = freshRunnerState("dedupe");
  stale.dayStamp = todayStamp(Date.now() - 86_400_000);
  stale.dayCostUsd = 5.67;
  saveRunnerState(repo, stale);

  let payload = statusPayload(repo) as { roles: Array<{ role: string; todayUsd: number }> };
  assert.equal(payload.roles.find((l) => l.role === "clean")?.todayUsd, 12.34, "fresh window rides the payload");
  assert.equal(payload.roles.find((l) => l.role === "dedupe")?.todayUsd, 0, "stale stamp reads zero");

  // A role that never ran (default state file) also carries an explicit zero field.
  saveRunnerState(repo, freshRunnerState("organize"));
  payload = statusPayload(repo) as typeof payload;
  assert.equal(payload.roles.find((l) => l.role === "organize")?.todayUsd, 0, "missing window reads zero");
});

test("status payload carries the consecutive no-change streak per role", async () => {
  const repo = makeRepo();
  await initProject(repo, "payload no-change test");
  // A streak on the state file rides the payload for the TUI/GUI to read.
  const streaked = freshRunnerState("clean");
  streaked.noChangeStreak = 4;
  streaked.cutOffStreak = 3;
  saveRunnerState(repo, streaked);
  // A role that never ran (absent field) reads as an explicit zero.
  saveRunnerState(repo, freshRunnerState("organize"));

  let payload = statusPayload(repo) as { roles: Array<{ role: string; noChangeStreak: number; cutOffStreak: number }> };
  assert.equal(payload.roles.find((l) => l.role === "clean")?.noChangeStreak, 4, "a persisted streak rides the payload");
  assert.equal(payload.roles.find((l) => l.role === "clean")?.cutOffStreak, 3, "a persisted cut-off streak rides the payload");
  assert.equal(payload.roles.find((l) => l.role === "organize")?.noChangeStreak, 0, "an absent field reads zero");
  assert.equal(payload.roles.find((l) => l.role === "organize")?.cutOffStreak, 0, "an absent cut-off field reads zero");
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

// The eligibility holds beside those titles (PLANS.md "Show backlog entry eligibility holds in
// the GUI and TUI backlog lists"): planHolds/bugHolds are index-for-index parallel, with an
// eligible entry rendered as the empty string so a client appends a present-or-empty mark.

test("status payload carries planHolds and bugHolds parallel to plans and bugs", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui backlog holds test");
  writeBacklogFile(repo, "PLANS.md", [
    {
      heading: "## Planned",
      body: [
        "### Worktree pool, part 2/5: first step (planned 2026-10-01)",
        "",
        "Body.",
        "",
        "### Worktree pool, part 3/5: second step (planned 2026-10-01; requires part 2/5 landed)",
        "",
        "Body.",
        "",
        "### Ship it (planned 2026-10-01)",
        "",
        "**Refused 2026-10-02 by feature: not worth it**",
        "",
        "### A ready one (planned 2026-10-01)",
        "",
        "Body.",
      ].join("\n"),
    },
    { heading: "## Done" },
  ]);
  writeBacklogFile(repo, "BUGS.md", [
    {
      heading: "## Open",
      body: "### Live bug (reported 2026-10-01)\n\nRepro.\n\n### Dead bug (reported 2026-10-01)\n\n**Refused 2026-10-02 by bugfix: not reproducible**",
    },
    { heading: "## Fixed" },
  ]);
  const payload = statusPayload(repo) as { plans: string[]; bugs: string[]; planHolds: string[]; bugHolds: string[]; planBlocked: boolean[]; bugBlocked: boolean[] };
  assert.deepEqual(payload.plans, [
    "Worktree pool, part 2/5: first step (planned 2026-10-01)",
    "Worktree pool, part 3/5: second step (planned 2026-10-01; requires part 2/5 landed)",
    "Ship it (planned 2026-10-01)",
    "A ready one (planned 2026-10-01)",
  ]);
  assert.equal(payload.planHolds.length, payload.plans.length, "one hold per plan");
  assert.deepEqual(payload.planHolds, [
    "",
    " [blocked: requires Worktree pool 2/5]",
    " [blocked: refused]",
    "",
  ]);
  assert.deepEqual(payload.bugs, ["Live bug (reported 2026-10-01)", "Dead bug (reported 2026-10-01)"]);
  assert.equal(payload.bugHolds.length, payload.bugs.length, "one hold per bug");
  assert.deepEqual(payload.bugHolds, ["", " [blocked: refused]"]);
  assert.deepEqual(payload.planBlocked, [false, true, true, false]);
  assert.deepEqual(payload.bugBlocked, [false, true]);
  const alerts = (statusPayload(repo) as { alerts: Array<{ key: string; title: string }> }).alerts;
  assert.equal(alerts.find((a) => a.key === "refused")?.title, "2 refused entries wait on your decision");
});

test("status payload's planHolds carries the working-on-it mark for a claimed plan", () => {
  const repo = makeRepo();
  writeBacklogFile(repo, "PLANS.md", [
    { heading: "## Planned", body: "### Volume slider (planned 2026-10-01)\n\nBody." },
    { heading: "## Done" },
  ]);
  saveRunnerState(repo, {
    ...loadRunnerState(repo, "feature-2"),
    claim: { file: "PLANS.md", key: "volume slider", title: "Volume slider", at: 1, source: "assigned" },
  });
  const payload = statusPayload(repo) as { planHolds: string[]; planBlocked: boolean[] };
  assert.deepEqual(payload.planHolds, [" [working on it: feature #2]"]);
  assert.deepEqual(payload.planBlocked, [false]);
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
  assert.match(payload.buildBadge, /build aaaaaaaa — update available \(7 commits behind\); restart blocked: main cccccccc is red$/);
});

// The operator pause on the GUI surface: /api/status — and
// therefore `status --json`, same payload — carries `paused` while the marker exists, and a
// paused team's idle roles read `paused` in their phase payload ahead of waiting: budget spent.

test("the status payload carries the operator pause flag; its phase outranks waiting: budget spent", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui team pause test");
  // A live orchestrator (this process) so rolePhase doesn't short-circuit to "stopped"…
  writeOrchestratorMarker(repo, ["clean"]);

  // No marker: not paused.
  let payload = statusPayload(repo) as {
    paused: boolean;
    roles: Array<{ role: string; phase: string }>;
  };
  assert.equal(payload.paused, false);
  assert.notEqual(payload.roles.find((l) => l.role === "clean")?.phase, "paused");

  // Drop the marker (what `tumwater pause` does) with spend at the cap: the flag flips and
  // the idle role's phase reads `paused`, ahead of waiting: budget spent.
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsd = 10;
  saveConfig(repo, cfg);
  const s = freshRunnerState("clean");
  s.dayStamp = todayStamp();
  s.dayCostUsd = 12.5; // >= cap → waiting: budget spent too
  saveRunnerState(repo, s);
  const marker = pausedPath(repo);
  writeMarker(marker, { at: Date.now() });

  payload = statusPayload(repo) as typeof payload;
  assert.equal(payload.paused, true, "the flag rides the payload top level");
  assert.equal(
    payload.roles.find((l) => l.role === "clean")?.phase,
    "paused",
    "user pause outranks waiting: budget spent in the phase payload",
  );
  // The director is exempt — its phase keeps its own label.
  assert.equal(payload.roles.find((l) => l.role === "director")?.phase, "ready for messages");

  // Removing the marker (what `tumwater resume` does) reverts both: flag false, and with the
  // spend still at the cap the role falls back to waiting: budget spent.
  fs.rmSync(marker);
  payload = statusPayload(repo) as typeof payload;
  assert.equal(payload.paused, false);
  assert.equal(payload.roles.find((l) => l.role === "clean")?.phase, "waiting: budget spent");

  fs.rmSync(orchestratorStatePath(repo), { force: true });
});

test("the status payload names the project and carries the recent events as data", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui event items test");
  const { logEvent } = await import("../src/events/events.js");
  const { formatEvent } = await import("../src/events/event-format.js");
  logEvent(repo, { source: "qa", type: "run_end", run: 3, result: "error", error: "429 Rate limit exceeded" });
  logEvent(repo, { source: "bugfix", type: "merged", commit: "a".repeat(40), summary: "Escape backlog bodies" });
  logEvent(repo, { source: "bugfix", type: "build_check", scope: "merge", script: "test", status: "failed" });
  const payload = statusPayload(repo) as {
    project: string;
    events: string[];
    eventItems: Array<{ ts: number; source: string; type: string; result?: string; message: string }>;
  };
  assert.equal(payload.project, path.basename(repo), "the project is the directory's name");
  assert.equal(payload.eventItems.length, payload.events.length, "one item per feed line");
  const tail = payload.eventItems.slice(-3);
  assert.deepEqual(tail.map((e) => [e.source, e.type, e.result]), [["qa", "run_end", "error"], ["bugfix", "merged", undefined], ["bugfix", "build_check", "failed"]]);
  // Each item's message is its feed line without the time and role columns.
  for (const [i, item] of payload.eventItems.entries()) {
    assert.ok(payload.events[i]!.endsWith(" " + item.message), `line ${i} ends with its item's message`);
  }
  assert.equal(tail[1]!.message, `merged aaaaaaaa to main — Escape backlog bodies`);
  assert.equal(formatEvent({ ts: tail[1]!.ts, source: "bugfix", type: "merged", commit: "a".repeat(40), summary: "Escape backlog bodies" }), payload.events.at(-2));
});

test("the status payload renders a corrupt event's role as ? like the reports", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui corrupt role test");
  // A torn or hand-edited line parses (readEvents pushes any parsed object), so an event with
  // no role reaches eventItem; String(undefined) shipped the literal "undefined" as the feed's
  // role chip. eventRole's "?" is the rule the usage report and failure digest apply.
  writeEvents(repo, [{ ts: 123, type: "wake", reason: "main moved" }]);
  const payload = statusPayload(repo) as { eventItems: Array<{ source: string }> };
  assert.equal(payload.eventItems.at(-1)?.source, "?");
});

test("the status payload carries each role's last error for the rows that failed", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui last error test");
  const s = freshRunnerState("qa");
  s.lastResult = "error";
  s.lastError = "429 Rate limit exceeded";
  saveRunnerState(repo, s);
  saveRunnerState(repo, freshRunnerState("clean"));
  const payload = statusPayload(repo) as { roles: Array<{ role: string; lastError: string | null }> };
  assert.equal(payload.roles.find((l) => l.role === "qa")?.lastError, "429 Rate limit exceeded");
  assert.equal(payload.roles.find((l) => l.role === "clean")?.lastError, null);
});

test("the status payload carries each role's last-merged epoch ms, null until it merges", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui last merged test");
  const s = freshRunnerState("qa");
  s.lastMergedAt = 123_456_789;
  saveRunnerState(repo, s);
  saveRunnerState(repo, freshRunnerState("clean"));
  const payload = statusPayload(repo) as { roles: Array<{ role: string; lastMergedAt: number | null }> };
  assert.equal(payload.roles.find((l) => l.role === "qa")?.lastMergedAt, 123_456_789);
  assert.equal(payload.roles.find((l) => l.role === "clean")?.lastMergedAt, null);
});

test("statusPayload exposes each role's nextRunAt and backoffSeconds", async () => {
  const repo = makeRepo();
  await initProject(repo, "payload schedule test");
  const state = freshRunnerState("clean");
  state.nextRunAt = 1_758_800_000_000;
  state.backoffSeconds = 90;
  saveRunnerState(repo, state);

  const payload = statusPayload(repo) as { roles: Array<{ role: string; nextRunAt: number; backoffSeconds: number }> };
  const clean = payload.roles.find((l) => l.role === "clean");
  assert.ok(clean, "the role has a payload row");
  assert.equal(clean.nextRunAt, 1_758_800_000_000, "raw epoch ms, formatted client-side");
  assert.equal(clean.backoffSeconds, 90);
});

// The per-role cap on the payload surface: `status --json`
// carries the held roles beside pausedRoles, and a held idle role's phase reads
// `waiting: daily cap spent` — the rolePhase ladder naming the specific spend state.
test("the status payload carries capPaused; a held idle role's phase reads waiting: daily cap spent", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui waiting: daily cap spent test");
  // A live orchestrator (this process) so rolePhase doesn't short-circuit to "stopped"…
  writeOrchestratorMarker(repo, ["clean"]);

  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsdPerRole = { clean: 1 };
  saveConfig(repo, cfg);
  const s = freshRunnerState("clean");
  s.dayStamp = todayStamp();
  s.dayCostUsd = 1.25; // >= cap → held
  saveRunnerState(repo, s);

  let payload = statusPayload(repo) as {
    capPaused: string[];
    pausedRoles: string[];
    roles: Array<{ role: string; phase: string }>;
  };
  assert.deepEqual(payload.capPaused, ["clean"], "the held role rides the payload beside pausedRoles");
  assert.deepEqual(payload.pausedRoles, []);
  assert.equal(
    payload.roles.find((l) => l.role === "clean")?.phase,
    "waiting: daily cap spent",
    "the held idle role's phase names its own cap",
  );
  // The director is exempt — its phase keeps its own label even when a cap entry names it.
  assert.equal(payload.roles.find((l) => l.role === "director")?.phase, "ready for messages");

  // No caps configured: the field is present and empty, and the phase reverts to idle.
  cfg.maxDailyCostUsdPerRole = {};
  saveConfig(repo, cfg);
  payload = statusPayload(repo) as typeof payload;
  assert.deepEqual(payload.capPaused, []);
  assert.notEqual(payload.roles.find((l) => l.role === "clean")?.phase, "waiting: daily cap spent");

  fs.rmSync(orchestratorStatePath(repo), { force: true });
});

// The disk floor's published block (plans/disk-floor.md, part 4/4): the payload ships the raw
// facts for `status --json` and the preformatted badge the dashboard renders — the same string
// the TUI/status header builds — so both surfaces say the same thing.
test("status payload ships the disk block and its preformatted badge", async () => {
  const repo = makeRepo();
  await initProject(repo, "payload disk test");
  const at = Date.now() - 300_000;
  writeJsonFile(orchestratorStatePath(repo), {
    pid: process.pid,
    startedAt: at,
    roles: [],
    disk: { freeGB: 8.2, holdGB: 10, reclaimGB: 40, held: true, lastReclaim: { at, mode: "pressure", freedGB: 3.24 } },
  });
  const payload = statusPayload(repo, at + 300_000) as { disk?: object; diskBadge: string };
  assert.deepEqual(payload.disk, {
    freeGB: 8.2, holdGB: 10, reclaimGB: 40, held: true,
    lastReclaim: { at, mode: "pressure", freedGB: 3.24 },
  });
  assert.equal(payload.diskBadge, " · disk 8.2 GB free — holding new work");
});

// The pinned clock reaches the alerts too: teamAlerts' pause countdown must read the
// payload's `now`, or a test pinning the clock cannot assert the countdown and the passed
// instant and the displayed one disagree.
test("status payload and header show a pending scheduled wake only while one stands", async () => {
  const repo = makeRepo();
  await initProject(repo, "scheduled wake test");
  let payload = statusPayload(repo) as { scheduledWake?: { roles: string[]; atMs: number }; scheduledWakes?: { roles: string[] }[] };
  assert.equal(payload.scheduledWake, undefined, "no marker, no scheduledWake");
  assert.equal(payload.scheduledWakes, undefined, "no marker, no scheduledWakes");
  assert.doesNotMatch(renderStatus(repo, snapshot(repo)), /wake scheduled in/);
  requestWake(repo, ["feature"], 3_600_000);
  payload = statusPayload(repo) as typeof payload;
  assert.deepEqual(payload.scheduledWake?.roles, ["feature"]);
  requestWake(repo, ["plan"], 7_200_000);
  payload = statusPayload(repo) as typeof payload;
  assert.deepEqual(payload.scheduledWakes?.map((w) => w.roles), [["feature"], ["plan"]]);
  assert.deepEqual(payload.scheduledWake?.roles, ["feature"]);
  assert.match(renderStatus(repo, snapshot(repo)), /wake scheduled in/);
});

test("status payload carries the run --for deadline and its badge only when windowed", async () => {
  const repo = makeRepo();
  await initProject(repo, "payload window test");
  const now = Date.now();
  const write = (extra: object) =>
    writeJsonFile(orchestratorStatePath(repo), { pid: process.pid, startedAt: now, roles: [], ...extra });
  write({ stopsAt: now + 2 * 3600_000 });
  let payload = statusPayload(repo, now) as { runStopsAt?: number; runWindowBadge: string };
  assert.equal(payload.runStopsAt, now + 2 * 3600_000);
  assert.equal(payload.runWindowBadge, " · stops in 2h");
  write({});
  payload = statusPayload(repo, now) as typeof payload;
  assert.equal(payload.runStopsAt, undefined);
  assert.equal(payload.runWindowBadge, "");
});

test("status payload carries scheduledStopAt only while running with a stop marker", async () => {
  const repo = makeRepo();
  await initProject(repo, "payload scheduled stop test");
  const now = Date.now();
  scheduleStop(repo, now + 3600_000);
  let payload = statusPayload(repo, now) as { scheduledStopAt?: number };
  assert.equal(payload.scheduledStopAt, undefined, "a stopped team omits it");
  writeJsonFile(orchestratorStatePath(repo), { pid: process.pid, startedAt: now, roles: [] });
  payload = statusPayload(repo, now) as typeof payload;
  assert.equal(payload.scheduledStopAt, now + 3600_000);
});

test("status payload's planSeries folds a series' blocked parts into one slot", () => {
  const repo = makeRepo();
  writeBacklogFile(repo, "PLANS.md", [
    {
      heading: "## Planned",
      body: [
        "### Ready one (planned 2026-10-01)\n\nBody.",
        "### Series S, part 1/3: first (planned 2026-10-01)\n\nBody.",
        "### Series S, part 2/3: second (planned 2026-10-01; requires part 1/3 landed)\n\nBody.",
        "### Series S, part 3/3: third (planned 2026-10-01; requires part 2/3 landed)\n\nBody.",
        "### Lone, part 2/2: only (planned 2026-10-01; requires part 1/2 landed)\n\nBody.",
      ].join("\n\n"),
    },
    { heading: "## Done" },
  ]);
  const payload = statusPayload(repo) as { plans: string[]; planSeries: ({ name: string; label: string } | null)[] };
  const rows = payload.plans.map((title) => ({ title, hold: { blockedBy: [] } as never, claimer: undefined }));
  const series = groupBlockedSeries(rows.slice(2, 4)).find((g) => g.kind === "series");
  assert.equal(series?.kind, "series");
  if (series?.kind !== "series") return;
  const slot = { name: series.series, label: `${series.series}, 2 blocked parts (${partsLabel(series.rows)})` };
  assert.deepEqual(payload.planSeries, [null, null, slot, slot, null]);
  assert.match(slot.label, /2 blocked parts \(2\/3–3\/3\)$/);
});

test("status payload lists the five newest answered questions beside the open ones", async () => {
  const repo = makeRepo();
  await initProject(repo, "payload answered test");
  let text = "# Questions\n\n## Open\n\n### Still open\n\nbody\n\n## Answered\n\n";
  for (let k = 1; k <= 6; k++) text += `### Q${k}\n\n**Answered 2026-10-0${k} by operator:** d${k}\n\n`;
  fs.writeFileSync(path.join(repo, "QUESTIONS.md"), text);
  const payload = statusPayload(repo) as { questions: string[]; answeredQuestions: { title: string; decision: string }[] };
  assert.equal(payload.questions.length, 1);
  assert.deepEqual(payload.answeredQuestions.map((a) => a.title), ["Q6", "Q5", "Q4", "Q3", "Q2"]);
  assert.match(payload.answeredQuestions[0]?.decision ?? "", /d6$/);
});

test("status payload lists the newest done plans and fixed bugs beside the open ones", async () => {
  const repo = makeRepo();
  await initProject(repo, "payload finished test");
  let plans = "# Plans\n\n## Planned\n\n### Open plan\n\nbody\n\n## Done\n\n";
  for (let k = 6; k >= 1; k--) plans += `### D${k} (planned 2026-09-30 by plan) — done 2026-10-0${k}\n\nbody\n\n`;
  fs.writeFileSync(path.join(repo, "PLANS.md"), plans);
  fs.writeFileSync(path.join(repo, "BUGS.md"), "# Bugs\n\n## Open\n\n## Fixed\n\n### B2 (found by bugfix 2026-10-01; fixed 2026-10-03 by bugfix loop)\n\nx\n\n### B1 with no stamp\n\nx\n");
  const payload = statusPayload(repo) as { plans: string[]; donePlans: { title: string; completedOn: string | null }[]; fixedBugs: unknown[] };
  assert.equal(payload.plans.length, 1);
  assert.deepEqual(payload.donePlans.map((d) => d.title), ["D6", "D5", "D4", "D3", "D2"]);
  assert.equal(payload.donePlans[0]?.completedOn, "2026-10-06");
  assert.deepEqual(payload.fixedBugs, [{ title: "B2", completedOn: "2026-10-03" }, { title: "B1 with no stamp", completedOn: null }]);
});

test("the status payload carries no retired script key anywhere in its tree", async () => {
  const repo = makeRepo();
  await initProject(repo, "retired keys test");
  saveRunnerState(repo, freshRunnerState("qa"));
  enqueueMerge(repo, { role: "qa", sha: "abc1234", run: 3, summary: "queued", enqueuedAt: Date.now() });
  enqueueMerge(repo, { role: "feature", sha: "def5678", run: 9, summary: "churny", enqueuedAt: Date.now(), highFriction: true });
  writeEvents(repo, [{ ts: 123, loop: "qa", type: "wake", reason: "main moved" }]); // retired-name-ok: legacy event field in a fixture
  const payload = statusPayload(repo) as {
    roles: Array<Record<string, unknown>>;
    mergeQueue: { entries: Array<Record<string, unknown>> };
    budget: Record<string, unknown>;
    eventItems: Array<Record<string, unknown>>;
  };
  const retired = new Set(["loops", "ticks", "lastTickEndedAt", "lastLandedAt", "landQueue", "landingBadge", "landQueueLabels"]);
  const found: string[] = [];
  const walk = (v: unknown, at: string): void => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (retired.has(k)) found.push(`${at}.${k}`);
        walk(x, `${at}.${k}`);
      }
    }
  };
  walk(payload, "payload");
  assert.deepEqual(found, []);
  assert.ok(payload.mergeQueue.entries.length > 0 && payload.eventItems.length > 0 && payload.roles.length > 0);
  assert.ok(!("agent" in payload.budget));
  assert.ok(payload.eventItems.every((it) => !("loop" in it) && "source" in it));
  assert.ok(payload.mergeQueue.entries.every((e) => !("tick" in e) && "run" in e));
  const bySha = Object.fromEntries(payload.mergeQueue.entries.map((e) => [e.sha, e]));
  assert.equal(bySha["def5678"]?.highFriction, true, "the high-friction entry's projection carries the flag");
  assert.equal(bySha["abc1234"]?.highFriction, undefined, "the ordinary entry's projection omits it");
});

test("status payload scoped to a role lists only that role and keeps the team budget", async () => {
  const repo = makeRepo();
  await initProject(repo, "payload role scope");
  for (const role of ["clean", "dedupe"]) saveRunnerState(repo, freshRunnerState(role));
  const now = Date.now();
  const all = statusPayload(repo, now) as { roles: { role: string }[]; budget: unknown };
  const scoped = statusPayload(repo, now, ["clean"]) as typeof all;
  assert.ok(all.roles.some((r) => r.role === "dedupe"));
  assert.deepEqual(scoped.roles.map((r) => r.role), ["clean"]);
  assert.deepEqual(scoped.budget, all.budget);
});

test("statusPayload carries the post-merge review queue", () => {
  const entry = { commit: "a".repeat(40), role: "feature", summary: "add x", failures: 2 };
  const repo = makeRepo();
  writeJsonFile(postReviewPath(repo), { pending: [entry] });
  assert.deepEqual((statusPayload(repo) as { postReviews: unknown[] }).postReviews, [entry]);
  const empty = makeRepo();
  assert.deepEqual((statusPayload(empty) as { postReviews: unknown[] }).postReviews, []);
  // A torn entry is dropped exactly as readPostReviews drops it today.
  writeJsonFile(postReviewPath(empty), { pending: [{ commit: "n" }] });
  assert.deepEqual((statusPayload(empty) as { postReviews: unknown[] }).postReviews, []);
});

test("the payload's noDeclaredCheck follows detectBuildCheck", () => {
  const now = Date.now();
  // A fresh makeRepo's fixture declares no build check (no check.command and no qualifying
  // package.json + node_modules on the walked-up root) — the same state the doctor `check`
  // row warns on.
  const root = makeRepo();
  assert.equal(snapshot(root, undefined, now).noDeclaredCheck, true, "no declared check is surfaced on the snapshot");
  const payload = statusPayload(root, now) as { noDeclaredCheck?: boolean; alerts: Array<{ key: string; tone: string }> };
  assert.equal(payload.noDeclaredCheck, true, "the machine-readable payload field is present");

  // Declaring check.command for the same repo turns the field off.
  const cfg = loadConfig(root);
  cfg.check = { command: "npm test" };
  saveConfig(root, cfg);
  assert.equal(snapshot(root, undefined, now).noDeclaredCheck, undefined);
  const payload2 = statusPayload(root, now) as { noDeclaredCheck?: boolean; alerts: Array<{ key: string }> };
  assert.equal(payload2.noDeclaredCheck, undefined, "no noDeclaredCheck key with a declared check");
  assert.equal(payload2.alerts.find((a) => a.key === "no-check"), undefined);
});

test("the payload's noBrief follows briefBlockMissing and clears when the brief resolves", () => {
  const now = Date.now();
  const root = makeRepo();
  assert.equal(snapshot(root, undefined, now).noBrief, undefined, "no candidate stays absent (pre-init state)");
  let payload = statusPayload(root, now) as { noBrief?: boolean; alerts: Array<{ key: string; tone: string; title: string }> };
  assert.equal(payload.noBrief, undefined, "no noBrief key with no brief candidate");
  assert.equal(payload.alerts.find((a) => a.key === "no-brief"), undefined, "no no-brief alert with no brief candidate");

  // A marker-less README.md (a hand edit that strips the block) is the silent state doctor
  // warns on; the snapshot, payload and alert should all surface it.
  fs.writeFileSync(path.join(root, "README.md"), "# p\n\nNo prompt block here.\n");
  assert.equal(snapshot(root, undefined, now).noBrief, true, "marker-less brief is surfaced on the snapshot");
  payload = statusPayload(root, now) as { noBrief?: boolean; alerts: Array<{ key: string; tone: string; title: string }> };
  assert.equal(payload.noBrief, true, "the machine-readable payload field is present");

  // A marked block with no text between its markers is the same silent state: a hand edit
  // that leaves the two markers with nothing between them also means no project prompt.
  fs.writeFileSync(path.join(root, "README.md"), `# p\n\n${PROMPT_START}${PROMPT_END}\n`);
  assert.equal(snapshot(root, undefined, now).noBrief, true, "an empty marked block is surfaced on the snapshot");
  payload = statusPayload(root, now) as { noBrief?: boolean; alerts: Array<{ key: string; tone: string; title: string }> };
  assert.equal(payload.noBrief, true, "the machine-readable payload field is present for an empty block");

  // Restoring the block turns the field and the alert back off.
  fs.writeFileSync(path.join(root, "README.md"), `# p\n\n${PROMPT_START}\nBuild a thing.\n${PROMPT_END}\n`);
  assert.equal(snapshot(root, undefined, now).noBrief, undefined, "resolved brief clears the snapshot field");
  payload = statusPayload(root, now) as { noBrief?: boolean; alerts: Array<{ key: string; tone: string; title: string }> };
  assert.equal(payload.noBrief, undefined, "no noBrief key with a resolved brief");
  assert.equal(payload.alerts.find((a) => a.key === "no-brief"), undefined, "no no-brief alert with a resolved brief");
});

test("the payload's briefTruncated follows briefBlockOverCap and clears under the cap", () => {
  const now = Date.now();
  const root = makeRepo();
  assert.equal(snapshot(root, undefined, now).briefTruncated, undefined, "no candidate stays absent");
  let payload = statusPayload(root, now) as { briefTruncated?: boolean; alerts: Array<{ key: string; tone: string; title: string }> };
  assert.equal(payload.briefTruncated, undefined, "no briefTruncated key with no brief candidate");
  assert.equal(payload.alerts.find((a) => a.key === "brief-truncated"), undefined, "no brief-truncated alert with no brief candidate");

  // A block past the read cap is the silent degraded state doctor warns on; the snapshot,
  // payload and alert should all surface it as the over-cap twin of `no-brief`.
  fs.writeFileSync(path.join(root, "README.md"), `# p\n\n${PROMPT_START}\n${("x").repeat(BRIEF_TEXT_MAX_CHARS + 1)}\n${PROMPT_END}\n`);
  assert.equal(snapshot(root, undefined, now).briefTruncated, true, "over-cap brief is surfaced on the snapshot");
  payload = statusPayload(root, now) as { briefTruncated?: boolean; alerts: Array<{ key: string; tone: string; title: string }> };
  assert.equal(payload.briefTruncated, true, "the machine-readable payload field is present");

  // Trimming the block to exactly the cap turns the field and the alert back off.
  fs.writeFileSync(path.join(root, "README.md"), `# p\n\n${PROMPT_START}\n${("x").repeat(BRIEF_TEXT_MAX_CHARS)}\n${PROMPT_END}\n`);
  assert.equal(snapshot(root, undefined, now).briefTruncated, undefined, "at-cap brief clears the snapshot field");
  payload = statusPayload(root, now) as { briefTruncated?: boolean; alerts: Array<{ key: string; tone: string; title: string }> };
  assert.equal(payload.briefTruncated, undefined, "no briefTruncated key at the cap");
  assert.equal(payload.alerts.find((a) => a.key === "brief-truncated"), undefined, "no brief-truncated alert at the cap");
});

test("the payload's roleNotesOverCap follows the notes read bound and clears under it", () => {
  const now = Date.now();
  const root = makeRepo();
  interface Payload { roleNotesOverCap?: Array<{ role: string; chars: number }>; alerts: Array<{ key: string; tone: string; title: string; detail: string }> };
  const payload = () => statusPayload(root, now) as Payload;
  // No notes dir (nothing recorded yet) is the doctor's pass: no field, no key, no alert.
  assert.equal(snapshot(root, undefined, now).roleNotesOverCap, undefined, "no notes dir leaves the field absent");
  assert.equal(payload().roleNotesOverCap, undefined, "no roleNotesOverCap key with no notes dir");
  assert.equal(payload().alerts.find((a) => a.key === "role-notes-truncated"), undefined, "no role-notes-truncated alert with no notes dir");

  const notesDir = path.dirname(roleNotesPath(root, "clean"));
  fs.mkdirSync(notesDir, { recursive: true });
  // A note at exactly the read bound is not over it: still absent everywhere.
  fs.writeFileSync(roleNotesPath(root, "clean"), "x".repeat(ROLE_NOTES_MAX_BYTES));
  assert.equal(snapshot(root, undefined, now).roleNotesOverCap, undefined, "a note at exactly the cap stays absent");
  assert.equal(payload().roleNotesOverCap, undefined, "no key at the cap");
  assert.equal(payload().alerts.find((a) => a.key === "role-notes-truncated"), undefined, "no alert at the cap");

  // A note over the byte bound but not the character bound proves the predicate is characters
  // (text.length, truncateWithNote's unit) — matching checkRoleNotes: each emoji is 2 UTF-16
  // code units, so 2048 emojis are 4096 characters but 8192 bytes — over the byte bound, yet
  // exactly the character bound, so it is NOT flagged.
  const multibyte = "\u{1F600}".repeat(ROLE_NOTES_MAX_BYTES / 2); // 4096 chars, 8192 bytes
  fs.writeFileSync(roleNotesPath(root, "feature"), multibyte);
  assert.equal(snapshot(root, undefined, now).roleNotesOverCap, undefined, "a bytes-over/char-at-bound multibyte note stays absent");
  assert.equal(payload().roleNotesOverCap, undefined, "no key for the bytes-over/char-at-bound multibyte note");
  assert.equal(payload().alerts.find((a) => a.key === "role-notes-truncated"), undefined, "no alert for the bytes-over/char-at-bound multibyte note");

  // Two over-cap notes surface the sorted array, the key, and the alert naming both roles.
  fs.writeFileSync(roleNotesPath(root, "clean"), "x".repeat(ROLE_NOTES_MAX_BYTES + 1));
  fs.writeFileSync(roleNotesPath(root, "feature"), "y".repeat(ROLE_NOTES_MAX_BYTES + 500));
  const expected = [
    { role: "feature", chars: ROLE_NOTES_MAX_BYTES + 500 },
    { role: "clean", chars: ROLE_NOTES_MAX_BYTES + 1 },
  ];
  assert.deepEqual(snapshot(root, undefined, now).roleNotesOverCap, expected, "two over-cap notes sort newest-char-count first");
  assert.deepEqual(payload().roleNotesOverCap, expected, "the payload carries the same array");

  // A non-.md file with an over-bound length is ignored (matching checkRoleNotes).
  fs.writeFileSync(path.join(notesDir, "stray.txt"), "z".repeat(ROLE_NOTES_MAX_BYTES + 100));
  assert.deepEqual(snapshot(root, undefined, now).roleNotesOverCap, expected, "a non-.md file is ignored");

  // Rewriting both notes to exactly the cap clears the array, the key and the alert.
  fs.writeFileSync(roleNotesPath(root, "clean"), "x".repeat(ROLE_NOTES_MAX_BYTES));
  fs.writeFileSync(roleNotesPath(root, "feature"), "y".repeat(ROLE_NOTES_MAX_BYTES));
  assert.equal(snapshot(root, undefined, now).roleNotesOverCap, undefined, "rewriting both to the cap clears the snapshot field");
  assert.equal(payload().roleNotesOverCap, undefined, "no key once both notes are at the cap");
  assert.equal(payload().alerts.find((a) => a.key === "role-notes-truncated"), undefined, "no alert once both notes are at the cap");
});



test("the payload's principlesTruncated follows principlesBlockOverCap and clears under the cap", () => {
  const now = Date.now();
  const root = makeRepo();
  assert.equal(snapshot(root, undefined, now).principlesTruncated, undefined, "no PRINCIPLES.md stays absent");
  let payload = statusPayload(root, now) as { principlesTruncated?: boolean; alerts: Array<{ key: string; tone: string; title: string }> };
  assert.equal(payload.principlesTruncated, undefined, "no principlesTruncated key with no PRINCIPLES.md");
  assert.equal(payload.alerts.find((a) => a.key === "principles-truncated"), undefined, "no principles-truncated alert with no PRINCIPLES.md");

  // An over-cap PRINCIPLES.md is the silent state doctor warns on; the snapshot, payload and
  // alert should all surface it.
  fs.writeFileSync(path.join(root, "PRINCIPLES.md"), "x".repeat(PRINCIPLES_MAX_CHARS + 1));
  assert.equal(snapshot(root, undefined, now).principlesTruncated, true, "over-cap PRINCIPLES.md is surfaced on the snapshot");
  payload = statusPayload(root, now) as { principlesTruncated?: boolean; alerts: Array<{ key: string; tone: string; title: string }> };
  assert.equal(payload.principlesTruncated, true, "the machine-readable payload field is present");

  // Rewriting the file to exactly the cap clears the field and the alert.
  fs.writeFileSync(path.join(root, "PRINCIPLES.md"), "x".repeat(PRINCIPLES_MAX_CHARS));
  assert.equal(snapshot(root, undefined, now).principlesTruncated, undefined, "at-cap clears the snapshot field");
  payload = statusPayload(root, now) as { principlesTruncated?: boolean; alerts: Array<{ key: string; tone: string; title: string }> };
  assert.equal(payload.principlesTruncated, undefined, "no principlesTruncated key under the cap");
  assert.equal(payload.alerts.find((a) => a.key === "principles-truncated"), undefined, "no principles-truncated alert under the cap");
});

test("refreshOrphanAlert mirrors the doctor's orphans row on a staged orphan scan", async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, ".tumwater", "worktrees", "qa"), { recursive: true });
  // A leaked build-check runner whose cwd lies inside a worktree — the leak shape of the 2026-10-28
  // incident — staged through the fake process table, never a real host process.
  const { probe } = fakeProbe(
    [
      { pid: 88052, etime: "2-21:44:01", time: "0:03.12", command: "node dist/test/test-runner.js" },
      { pid: 95649, ppid: 88052, etime: "01:00", time: "4:44.00", command: "node a.test.js" },
    ],
    { 88052: path.join(root, ".tumwater", "worktrees", "qa") },
  );
  const doctor = await checkOrphans(root, probe);
  const alert = await refreshOrphanAlert(root, probe);
  // The standing alert carries the exact doctor-row sentence and count, so the alert and the
  // `orphans` row cannot drift on the count, the per-orphan cpu or the remediation.
  assert.equal(alert?.count, 1);
  assert.equal(alert?.detail, doctor.detail);
  // The pure feed agrees with the probe-driven refresh — the same staged scan, the same message.
  const staged = orphanAlertFromScan(await findOrphans(root, probe), root);
  assert.deepEqual(staged, alert);
});

test("refreshOrphanAlert raises none on a clean host", async () => {
  const root = makeRepo();
  const { probe } = fakeProbe([]);
  assert.equal(await refreshOrphanAlert(root, probe), null);
  assert.equal(orphanAlertFromScan({ rows: [], orphans: [], marks: new Map<number, string[]>(), cwdProblem: null }), null);
});
