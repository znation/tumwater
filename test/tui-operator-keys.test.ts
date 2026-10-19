/** The TUI per-loop operator controls (extracted from tui.test.ts): Ctrl+P (a duration editor
 * on an unpaused loop, an immediate resume on a paused one) and its team-pause interplay
 * note, Ctrl+A's abort confirmation and liveness gate, Ctrl+W's wake editor, Ctrl+Q's
 * scheduled team stop, and the keys' inertness outside transcript views and in budget mode.
 * Like the other topic-named slices (runner-refusal,
 * orchestrator-budget, review-precheck), this file holds one coherent topic; the shared
 * fake-TTY harness lives in fixtures/tui-fixtures.ts. Each test file gets its own process, so the
 * harness's global stdout/stdin/readline patches never meet another file's environment. */
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { isTeamPaused, scheduledStopAt, pauseTeam, pausedRoles, standingTeamPause } from "../src/team/team-state.js";
import { listWakes, requestWake } from "../src/operator/operator-intent.js";
import { abortRequestPath, pausedRolesPath, resetRequestPath, restartRequestPath, wakeRequestPath } from "../src/paths.js";
import { freshLoopState, loadLoopState, saveLoopState } from "../src/runner/runner-state.js";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { makeTuiRepo, withTui } from "./fixtures/tui-fixtures.js";

// Ctrl+P/Ctrl+A/Ctrl+W act on the loop whose transcript is
// on screen, through the same marker-writing cores the CLI's --role flags call, so the two
// surfaces cannot drift on marker format, idempotence, or wording (rolePauseMessage and
// roleResumeMessage in src/operator/operator-intent.ts are the shared single writer of the
// wording).
test("Ctrl+P toggles the viewed loop's pause marker and flashes the CLI's wording", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → transcript (one enabled role)
    assert.match(tui.lastFrame(), /Ctrl\+N notes · Ctrl\+P pause\/resume · Ctrl\+W wake/); // header hint (Ctrl+A clips at 100 cols)

    tui.key(undefined, "p", { ctrl: true }); // opens the duration editor
    assert.deepEqual(pausedRoles(repo), [], "the editor writes nothing until Enter");
    tui.key(undefined, "return");
    assert.deepEqual(pausedRoles(repo), ["clean"]);
    assert.match(tui.lastFrame(), /role clean paused — it starts no new runs/);
    // The status table's cell for the paused idle role reads `paused` while the marker stands
    // (per-role pause 1/2 wires loopPhase through snap.pausedRoles).
    assert.match(tui.lines().join("\n"), /clean[^\n]*paused/);

    tui.key(undefined, "p", { ctrl: true });
    assert.deepEqual(pausedRoles(repo), []);
    assert.match(tui.lastFrame(), /role clean resumed — it starts new runs again/);
    // No team pause is active, so the interplay note stays out of the flash.
    assert.doesNotMatch(tui.lastFrame(), /team pause is still active/);
  });
});

test("Ctrl+P's resume flash carries the team-pause interplay note while the team is paused", async () => {
  const repo = await makeTuiRepo();
  pauseTeam(repo); // the stronger gate: a resumed role still starts no ticks under it
  await withTui(repo, async (tui) => {
    // The interplay note makes the resume flash longer than the default fake 100 columns, and
    // every rendered line is clipped to the width — widen the fake terminal so the note fits.
    (process.stdout as { columns?: number }).columns = 220;
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "p", { ctrl: true }); // pause the role under the team pause
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /role clean paused/);
    tui.key(undefined, "p", { ctrl: true }); // resume it
    assert.deepEqual(pausedRoles(repo), []);
    assert.match(
      tui.lastFrame(),
      /role clean resumed[^]*\(the team pause is still active — `tumwater resume` lifts it\)/,
    );
  });
});

test("Ctrl+P, a duration, Enter pauses the viewed loop for that long", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    const before = Date.now();
    tui.key(undefined, "p", { ctrl: true });
    tui.key("2", "2");
    tui.key("h", "h");
    tui.key(undefined, "return");
    assert.deepEqual(pausedRoles(repo), ["clean"]);
    const marker = JSON.parse(fs.readFileSync(pausedRolesPath(repo), "utf8")) as { until?: number };
    assert.ok(marker.until !== undefined && Math.abs(marker.until - (before + 7_200_000)) < 60_000);
    assert.match(tui.lastFrame(), /role clean paused for 2h/);
  });
});

test("Esc cancels the loop pause editor and restores the draft; an invalid entry stays in it", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key("x", "x"); // a draft on the prompt line
    tui.key(undefined, "p", { ctrl: true });
    tui.key("2", "2");
    tui.key("h", "h");
    tui.key(undefined, "escape");
    assert.deepEqual(pausedRoles(repo), []);
    assert.match(tui.lines().at(-1)!, /x$/);

    tui.key(undefined, "p", { ctrl: true });
    for (const c of "later") tui.key(c, c);
    tui.key(undefined, "return");
    assert.deepEqual(pausedRoles(repo), []);
    assert.match(tui.lastFrame(), /a role pause takes only a duration/);
    assert.match(tui.lines().at(-1)!, /^pause clean ›/);
  });
});

test("Ctrl+P in role-prompt mode pauses nothing and flashes the refusal", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "r", { ctrl: true });
    tui.key(undefined, "p", { ctrl: true });
    assert.deepEqual(pausedRoles(repo), []);
    assert.match(tui.lastFrame(), /finish or cancel the role prompt first/);
  });
});

test("Ctrl+A flashes the abort confirmation with a live harness and the liveness error without", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "a", { ctrl: true });
    // No harness: the liveness gate rejects before any marker is written, and the failure
    // flashes with the error prefix (the same contract the GUI's 409 body serves).
    assert.match(tui.lastFrame(), /error: tumwater is not running/);
    assert.equal(fs.existsSync(abortRequestPath(repo, "clean")), false);

    // A live harness (the test process itself stands in for the orchestrator's pid) lets the
    // same keypress drop the per-role abort marker and flash the confirmation.
    writeOrchestratorMarker(repo, ["clean"]);
    tui.key(undefined, "a", { ctrl: true });
    assert.match(tui.lastFrame(), /abort requested for clean — the running team applies it within ~2s/);
    assert.equal(fs.existsSync(abortRequestPath(repo, "clean")), true);
  });
});

// Ctrl+C is the director's interrupt, not a quit: runTui's render feeds the flag from the
// rendered snapshot itself (the director row's in-flight phase), so the wiring — not just the
// handler's branch — decides what a Ctrl+C does. The handler-level test (tui-keys.test.ts)
// passes syncSnapshot's flag by hand; this one drives the real render path.
test("Ctrl+C interrupts a director tick in flight through the rendered snapshot, and refuses without", async () => {
  const repo = await makeTuiRepo();
  const cfg = loadConfig(repo);
  cfg.roles.director!.enabled = true;
  saveConfig(repo, cfg);
  // A director mid-tick: running with a started-at stamp renders its own `director working`
  // phase (outside the permit-holder inFlight set, which the gate no longer keys off alone);
  // the orchestrator marker keeps the team live for the gate. The state column clips the
  // label at this width, so match its prefix.
  saveLoopState(repo, { ...freshLoopState("director"), running: true, lastRunStartedAt: Date.now() - 60_000 });
  writeOrchestratorMarker(repo, ["clean", "director"]);
  await withTui(repo, async (tui) => {
    assert.match(tui.lines().join("\n"), /director[^\n]*director wo/); // the row the gate reads
    tui.key(undefined, "c", { ctrl: true });
    assert.match(tui.lastFrame(), /abort requested for director/);
    assert.equal(fs.existsSync(abortRequestPath(repo, "director")), true);
  });
});

test("Ctrl+C with no director tick in flight flashes the notice and writes no marker", async () => {
  const repo = await makeTuiRepo();
  const cfg = loadConfig(repo);
  cfg.roles.director!.enabled = true;
  saveConfig(repo, cfg);
  writeOrchestratorMarker(repo, ["clean", "director"]); // live harness, idle director
  await withTui(repo, async (tui) => {
    tui.key(undefined, "c", { ctrl: true });
    assert.match(tui.lastFrame(), /no director task in flight/);
    assert.equal(fs.existsSync(abortRequestPath(repo, "director")), false);
  });
});

const typeText = (tui: { key(str: string | undefined, name: string): void }, text: string): void => {
  for (const ch of text) tui.key(ch, ch);
};

test("Ctrl+W opens the wake editor; Enter on an empty line wakes the viewed role now", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "w", { ctrl: true });
    assert.equal(fs.existsSync(wakeRequestPath(repo)), false, "the editor writes nothing until Enter");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /wake requested for clean/);
    assert.equal(fs.existsSync(wakeRequestPath(repo)), true);
  });
});

test("Ctrl+W then a duration schedules the viewed role's wake", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "w", { ctrl: true });
    typeText(tui, "2h");
    tui.key(undefined, "return");
    const wakes = listWakes(repo, "clean", Date.now());
    assert.equal(wakes.length, 1);
    assert.ok(Math.abs(wakes[0]!.atMs - (Date.now() + 7_200_000)) < 60_000);
    assert.match(tui.lastFrame(), /wake scheduled for clean/);
  });
});

test("Ctrl+W then 'cancel' drops the viewed role's scheduled wakes", async () => {
  const repo = await makeTuiRepo();
  requestWake(repo, ["clean"], 3_600_000);
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "w", { ctrl: true });
    typeText(tui, "cancel");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /cancelled 1 scheduled wake for clean/);
    assert.deepEqual(listWakes(repo, "clean", Date.now()), []);
  });
});

test("Ctrl+W with an invalid entry flashes and stays in the editor; Esc restores the draft", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    typeText(tui, "draft");
    tui.key(undefined, "w", { ctrl: true });
    typeText(tui, "soon");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /a role wake takes a duration/);
    assert.match(tui.lastFrame(), /wake clean ›/);
    tui.key(undefined, "escape");
    assert.match(tui.lastFrame(), /draft/);
    assert.doesNotMatch(tui.lastFrame(), /wake clean ›/);
  });
});

test("a second Ctrl+W closes the wake editor without writing", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "w", { ctrl: true });
    tui.key(undefined, "w", { ctrl: true });
    assert.doesNotMatch(tui.lastFrame(), /wake clean ›/);
    assert.equal(fs.existsSync(wakeRequestPath(repo)), false);
  });
});

test("Ctrl+F toggles the team pause marker through pauseTeam/resumeTeam and flashes the shared wording", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    assert.equal(isTeamPaused(repo), false);
    tui.key(undefined, "f", { ctrl: true }); // opens the pause editor
    assert.equal(isTeamPaused(repo), false, "the editor writes nothing until Enter");
    tui.key(undefined, "return"); // empty line: pause until resumed
    assert.equal(isTeamPaused(repo), true);
    assert.match(tui.lastFrame(), /team paused — roles start no new runs/);
    // The next frame's team alert reads the marker, so the resume action is visible too.
    assert.match(tui.lastFrame(), /The team is paused/);

    tui.key(undefined, "f", { ctrl: true });
    assert.equal(isTeamPaused(repo), false);
    assert.match(tui.lastFrame(), /team resumed — roles run again/);
    assert.doesNotMatch(tui.lastFrame(), /The team is paused/);
  });
});

test("Ctrl+F then '1h maintenance' pauses with a deadline and reason shown in the team alert", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    const before = Date.now();
    tui.key(undefined, "f", { ctrl: true });
    for (const ch of "1h maintenance") tui.key(ch, ch);
    tui.key(undefined, "return");
    const marker = standingTeamPause(repo);
    assert.ok(marker?.until !== undefined && Math.abs(marker.until - (before + 3_600_000)) < 60_000, "until is about one hour ahead");
    assert.equal(marker?.reason, "maintenance");
    assert.match(tui.lastFrame(), /maintenance/);
  });
});

test("Esc in the pause editor leaves the team unpaused and restores the draft", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    for (const ch of "draft text") tui.key(ch, ch);
    tui.key(undefined, "f", { ctrl: true });
    assert.match(tui.lines().at(-1) ?? "", /^pause ›/);
    for (const ch of "2h") tui.key(ch, ch);
    tui.key(undefined, "escape");
    assert.equal(isTeamPaused(repo), false);
    assert.match(tui.lines().at(-1) ?? "", /director › draft text/);
  });
});

test("Ctrl+F during a / search is inert: no pause editor opens over the search", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key("/", "/");
    for (const ch of "foo") tui.key(ch, ch);
    tui.key(undefined, "f", { ctrl: true });
    tui.key(undefined, "return");
    assert.equal(isTeamPaused(repo), false);
    assert.doesNotMatch(tui.lines().at(-1) ?? "", /^pause ›/);
  });
});

test("a 91d pause entry flashes the cap error and keeps the editor open; Ctrl+B refuses", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "f", { ctrl: true });
    for (const ch of "91d") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.equal(isTeamPaused(repo), false);
    assert.match(tui.lastFrame(), /pause is capped at 90d/);
    assert.match(tui.lines().at(-1) ?? "", /^pause › 91d/);
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the pause first/);
    assert.match(tui.lines().at(-1) ?? "", /^pause ›/);
  });
});

test("Ctrl+F is inert while the budget editor or the role-prompt editor holds the prompt line", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // → transcript
    tui.key(undefined, "b", { ctrl: true }); // enter budget mode
    assert.match(tui.lastFrame(), /edit clean's daily cost cap/);
    tui.key(undefined, "f", { ctrl: true });
    assert.equal(isTeamPaused(repo), false);
    assert.equal(tui.lines().at(-1), "daily cap $", "still editing the cap, Ctrl+F inert");

    tui.key(undefined, "escape"); // leave budget mode
    tui.key(undefined, "r", { ctrl: true }); // enter role-prompt mode for the viewed loop
    assert.match(tui.lastFrame(), /prompt for clean/);
    tui.key(undefined, "f", { ctrl: true });
    assert.equal(isTeamPaused(repo), false);
  });
});

test("the per-loop keys are inert outside transcript views, in budget mode, and on failure flash an error", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    // Events view (no transcript on screen): all three keys write nothing and flash nothing.
    tui.key(undefined, "p", { ctrl: true });
    tui.key(undefined, "a", { ctrl: true });
    tui.key(undefined, "w", { ctrl: true });
    assert.deepEqual(pausedRoles(repo), []);
    assert.equal(fs.existsSync(wakeRequestPath(repo)), false);
    assert.doesNotMatch(tui.lastFrame(), /wake requested|paused|abort requested/);

    // Budget-edit mode swallows them too — the prompt line keeps editing the cap.
    tui.key(undefined, "t", { ctrl: true }); // → transcript
    tui.key(undefined, "b", { ctrl: true }); // enter budget mode
    assert.match(tui.lastFrame(), /edit clean's daily cost cap/);
    tui.key(undefined, "p", { ctrl: true });
    tui.key(undefined, "a", { ctrl: true });
    tui.key(undefined, "w", { ctrl: true });
    assert.deepEqual(pausedRoles(repo), []);
    assert.equal(fs.existsSync(wakeRequestPath(repo)), false);
    assert.equal(tui.lines().at(-1), "daily cap $", "still editing the cap, keys inert");

    // A failed marker write flashes the reason instead of killing the TUI: the paused-roles
    // path is a directory, so writeJsonAtomic's rename throws and the catch flashes it.
    tui.key(undefined, "escape"); // leave budget mode
    fs.mkdirSync(pausedRolesPath(repo), { recursive: true });
    tui.key(undefined, "p", { ctrl: true });
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /error: /);
  });
});

test("Ctrl+Q opens the stop editor, schedules a stop on Enter, and cancels a pending one at once", async () => {
  const repo = await makeTuiRepo();
  writeOrchestratorMarker(repo, ["clean"]);
  await withTui(repo, async (tui) => {
    tui.key(undefined, "q", { ctrl: true });
    assert.match(tui.lines().at(-1) ?? "", /^stop in ›/);
    assert.equal(scheduledStopAt(repo), undefined);
    for (const ch of "2h") tui.key(ch, ch);
    tui.key(undefined, "return");
    const at = scheduledStopAt(repo);
    assert.ok(at !== undefined && Math.abs(at - (Date.now() + 7_200_000)) < 60_000);
    assert.match(tui.lastFrame(), /stop scheduled in 2h/);

    tui.key(undefined, "q", { ctrl: true });
    assert.equal(scheduledStopAt(repo), undefined);
    assert.match(tui.lastFrame(), /scheduled stop cancelled/);
    assert.doesNotMatch(tui.lines().at(-1) ?? "", /^stop in ›/);
  });
});

test("Ctrl+Q, '2h', Enter without a harness flashes the refusal and writes no marker", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "q", { ctrl: true });
    for (const ch of "2h") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /error: tumwater is not running/);
    assert.equal(scheduledStopAt(repo), undefined);
  });
});

test("an empty or 91d stop entry flashes the parser error and keeps the editor; Esc restores the draft; a second Ctrl+Q closes it", async () => {
  const repo = await makeTuiRepo();
  writeOrchestratorMarker(repo, ["clean"]);
  await withTui(repo, async (tui) => {
    for (const ch of "draft") tui.key(ch, ch);
    tui.key(undefined, "q", { ctrl: true });
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /a scheduled stop takes a duration/);
    for (const ch of "91d") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /stop is capped at 90d/);
    assert.match(tui.lines().at(-1) ?? "", /^stop in ›/);
    assert.equal(scheduledStopAt(repo), undefined);
    tui.key(undefined, "escape");
    assert.match(tui.lines().at(-1) ?? "", /^director › draft/);
    tui.key(undefined, "q", { ctrl: true });
    tui.key(undefined, "q", { ctrl: true });
    assert.doesNotMatch(tui.lines().at(-1) ?? "", /^stop in ›/);
    assert.equal(scheduledStopAt(repo), undefined);
  });
});

test("Ctrl+Q is inert during a / search and while the budget editor is open", async () => {
  const repo = await makeTuiRepo();
  writeOrchestratorMarker(repo, ["clean"]);
  await withTui(repo, async (tui) => {
    tui.key("/", "/");
    tui.key(undefined, "q", { ctrl: true });
    assert.doesNotMatch(tui.lines().at(-1) ?? "", /^stop in ›/);
    tui.key(undefined, "escape");
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "b", { ctrl: true });
    tui.key(undefined, "q", { ctrl: true });
    tui.key(undefined, "return");
    assert.doesNotMatch(tui.lines().at(-1) ?? "", /^stop in ›/);
    assert.equal(scheduledStopAt(repo), undefined);
  });
});

// Ctrl+V zeroes the viewed loop's counters on the transcript pane (the terminal twin of
// `tumwater reset-counters --role <id>`): one press writes the reset marker through the same
// requestResetCounters core the CLI and dashboard call and, with no live team, zeroes the
// state file directly. One press, not an armed second, matches the dashboard button's single
// click; the action zeroes counters only and leaves scheduling untouched.
test("Ctrl+V resets the viewed role's counters through requestResetCounters", async () => {
  const repo = await makeTuiRepo();
  saveLoopState(repo, { ...freshLoopState("clean"), runs: 4, commits: 3 });
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → transcript (one enabled role)
    tui.key(undefined, "v", { ctrl: true });
    assert.match(tui.lastFrame(), /counters reset for clean/);
    const marker = JSON.parse(fs.readFileSync(resetRequestPath(repo), "utf8")) as { roles: string[] };
    assert.deepEqual(marker.roles, ["clean"]);
    // No orchestrator marker, so requestResetCounters zeroes the state file directly: the
    // next run starts fresh.
    const state = loadLoopState(repo, "clean");
    assert.equal(state.runs, 0);
    assert.equal(state.commits, 0);
  });
});

test("Ctrl+V is inert outside the transcript and while the budget editor is open", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    // Events view (no transcript on screen): the key writes no reset marker.
    tui.key(undefined, "v", { ctrl: true });
    assert.equal(fs.existsSync(resetRequestPath(repo)), false);

    // Budget-edit mode swallows it too — the prompt line keeps editing the cap.
    tui.key(undefined, "t", { ctrl: true }); // → transcript
    tui.key(undefined, "b", { ctrl: true }); // enter budget mode
    assert.match(tui.lastFrame(), /edit clean's daily cost cap/);
    tui.key(undefined, "v", { ctrl: true });
    assert.equal(fs.existsSync(resetRequestPath(repo)), false);
    assert.equal(tui.lines().at(-1), "daily cap $", "still editing the cap, Ctrl+V inert");
  });
});

// Ctrl+R on the Activity view (view 0) applies the pending self-redeploy: the terminal twin of
// `tumwater restart` and the dashboard update alert's restart button, all three through the
// same requestRestart marker writer (src/operator/operator-intent.ts). A stale published build
// waives the cooldown and drops the restart marker a live team consumes within one poll; a
// fresh build refuses with the CLI's "current with main" wording and writes nothing.
test("Ctrl+R on the Activity view requests the pending self-redeploy when the build is stale", async () => {
  const repo = await makeTuiRepo();
  writeOrchestratorMarker(repo, ["clean"], { build: { sha: "a".repeat(40), builtAt: 1, stale: true, aheadCommits: 2 } });
  await withTui(repo, async (tui) => {
    tui.key(undefined, "r", { ctrl: true });
    assert.match(tui.lastFrame(), /restart requested/);
    assert.match(tui.lastFrame(), /cooldown is waived/);
    assert.equal(fs.existsSync(restartRequestPath(repo)), true, "the marker a live team consumes is on disk");
  });
});

test("Ctrl+R on a fresh build refuses and writes no restart marker", async () => {
  const repo = await makeTuiRepo();
  writeOrchestratorMarker(repo, ["clean"], { build: { sha: "a".repeat(40), builtAt: 1, stale: false } });
  await withTui(repo, async (tui) => {
    tui.key(undefined, "r", { ctrl: true });
    assert.match(tui.lastFrame(), /no update is waiting/);
    assert.equal(fs.existsSync(restartRequestPath(repo)), false, "a fresh build's press writes nothing");
  });
});

test("Ctrl+R is inert while the budget editor holds the prompt line", async () => {
  const repo = await makeTuiRepo();
  writeOrchestratorMarker(repo, ["clean"], { build: { sha: "a".repeat(40), builtAt: 1, stale: true, aheadCommits: 2 } });
  await withTui(repo, async (tui) => {
    tui.key(undefined, "b", { ctrl: true }); // enter budget mode
    assert.match(tui.lastFrame(), /edit daily cost budget/);
    tui.key(undefined, "r", { ctrl: true });
    assert.equal(fs.existsSync(restartRequestPath(repo)), false, "still editing the cap, Ctrl+R inert");
    assert.equal(tui.lines().at(-1), "daily cap $ 50", "still editing the cap, Ctrl+R inert");
  });
});
