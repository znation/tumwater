/** The TUI per-loop operator controls (extracted from tui.test.ts): Ctrl+P pause/resume and
 * its fleet-pause interplay note, Ctrl+A's abort confirmation and liveness gate, Ctrl+W's
 * wake marker, and the keys' inertness outside transcript views and in budget mode.
 * Like the other topic-named slices (loop-refusal,
 * orchestrator-budget, review-precheck), this file holds one coherent topic; the shared
 * fake-TTY harness lives in fixtures/tui-fixtures.ts. Each test file gets its own process, so the
 * harness's global stdout/stdin/readline patches never meet another file's environment. */
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { isFleetPaused, pauseFleet, pausedRoles, standingFleetPause } from "../src/fleet/fleet-state.js";
import { abortRequestPath, pausedRolesPath, wakeRequestPath } from "../src/paths.js";
import { freshLoopState, saveLoopState } from "../src/loop/loop-state.js";
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
    assert.match(tui.lastFrame(), /Ctrl\+N notebook · Ctrl\+P pause\/resume · Ctrl\+W wake/); // header hint (Ctrl+A clips at 100 cols)

    tui.key(undefined, "p", { ctrl: true });
    assert.deepEqual(pausedRoles(repo), ["clean"]);
    assert.match(tui.lastFrame(), /role clean paused — it stops starting new ticks/);
    // The status table's cell for the paused idle role reads `paused` while the marker stands
    // (per-role pause 1/2 wires loopPhase through snap.pausedRoles).
    assert.match(tui.lines().join("\n"), /clean[^\n]*paused/);

    tui.key(undefined, "p", { ctrl: true });
    assert.deepEqual(pausedRoles(repo), []);
    assert.match(tui.lastFrame(), /role clean resumed — it starts ticking again/);
    // No fleet pause is active, so the interplay note stays out of the flash.
    assert.doesNotMatch(tui.lastFrame(), /fleet pause is still active/);
  });
});

test("Ctrl+P's resume flash carries the fleet-pause interplay note while the fleet is paused", async () => {
  const repo = await makeTuiRepo();
  pauseFleet(repo); // the stronger gate: a resumed role still starts no ticks under it
  await withTui(repo, async (tui) => {
    // The interplay note makes the resume flash longer than the default fake 100 columns, and
    // every rendered line is clipped to the width — widen the fake terminal so the note fits.
    (process.stdout as { columns?: number }).columns = 220;
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "p", { ctrl: true }); // pause the role under the fleet pause
    assert.match(tui.lastFrame(), /role clean paused/);
    tui.key(undefined, "p", { ctrl: true }); // resume it
    assert.deepEqual(pausedRoles(repo), []);
    assert.match(
      tui.lastFrame(),
      /role clean resumed[^]*\(the fleet pause is still active — `tumwater resume` lifts it\)/,
    );
  });
});

test("Ctrl+A flashes the abort confirmation with a live harness and the liveness error without", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "a", { ctrl: true });
    // No harness: the liveness gate rejects before any marker is written, and the failure
    // flashes with the error prefix (the same contract the GUI's 409 body serves).
    assert.match(tui.lastFrame(), /error: no harness is running/);
    assert.equal(fs.existsSync(abortRequestPath(repo, "clean")), false);

    // A live harness (the test process itself stands in for the orchestrator's pid) lets the
    // same keypress drop the per-role abort marker and flash the confirmation.
    writeOrchestratorMarker(repo, ["clean"]);
    tui.key(undefined, "a", { ctrl: true });
    assert.match(tui.lastFrame(), /abort requested for clean — a running fleet applies it within ~2s/);
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
  // the orchestrator marker keeps the fleet live for the gate. The state column clips the
  // label at this width, so match its prefix.
  saveLoopState(repo, { ...freshLoopState("director"), running: true, lastTickStartedAt: Date.now() - 60_000 });
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

test("Ctrl+W flashes the wake confirmation and drops the wake marker for the viewed role", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "w", { ctrl: true });
    assert.match(tui.lastFrame(), /wake requested for clean/);
    assert.equal(fs.existsSync(wakeRequestPath(repo)), true);
  });
});

test("Ctrl+F toggles the fleet pause marker through pauseFleet/resumeFleet and flashes the shared wording", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    assert.equal(isFleetPaused(repo), false);
    tui.key(undefined, "f", { ctrl: true }); // opens the pause editor
    assert.equal(isFleetPaused(repo), false, "the editor writes nothing until Enter");
    tui.key(undefined, "return"); // empty line: pause until resumed
    assert.equal(isFleetPaused(repo), true);
    assert.match(tui.lastFrame(), /fleet paused — role loops stop starting new ticks/);
    // The next frame's fleet alert reads the marker, so the resume action is visible too.
    assert.match(tui.lastFrame(), /The fleet is paused/);

    tui.key(undefined, "f", { ctrl: true });
    assert.equal(isFleetPaused(repo), false);
    assert.match(tui.lastFrame(), /fleet resumed — role loops tick again/);
    assert.doesNotMatch(tui.lastFrame(), /The fleet is paused/);
  });
});

test("Ctrl+F then '1h maintenance' pauses with a deadline and reason shown in the fleet alert", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    const before = Date.now();
    tui.key(undefined, "f", { ctrl: true });
    for (const ch of "1h maintenance") tui.key(ch, ch);
    tui.key(undefined, "return");
    const marker = standingFleetPause(repo);
    assert.ok(marker?.until !== undefined && Math.abs(marker.until - (before + 3_600_000)) < 60_000, "until is about one hour ahead");
    assert.equal(marker?.reason, "maintenance");
    assert.match(tui.lastFrame(), /maintenance/);
  });
});

test("Esc in the pause editor leaves the fleet unpaused and restores the draft", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    for (const ch of "draft text") tui.key(ch, ch);
    tui.key(undefined, "f", { ctrl: true });
    assert.match(tui.lines().at(-1) ?? "", /^pause ›/);
    for (const ch of "2h") tui.key(ch, ch);
    tui.key(undefined, "escape");
    assert.equal(isFleetPaused(repo), false);
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
    assert.equal(isFleetPaused(repo), false);
    assert.doesNotMatch(tui.lines().at(-1) ?? "", /^pause ›/);
  });
});

test("a 91d pause entry flashes the cap error and keeps the editor open; Ctrl+B and Ctrl+L refuse", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "f", { ctrl: true });
    for (const ch of "91d") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.equal(isFleetPaused(repo), false);
    assert.match(tui.lastFrame(), /pause is capped at 90d/);
    assert.match(tui.lines().at(-1) ?? "", /^pause › 91d/);
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the pause first/);
    tui.key(undefined, "l", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the pause first/);
    assert.match(tui.lines().at(-1) ?? "", /^pause ›/);
  });
});

test("Ctrl+F is inert while the budget editor or the role-prompt editor holds the prompt line", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // → transcript
    tui.key(undefined, "b", { ctrl: true }); // enter budget mode
    assert.match(tui.lastFrame(), /edit daily cost budget/);
    tui.key(undefined, "f", { ctrl: true });
    assert.equal(isFleetPaused(repo), false);
    assert.equal(tui.lines().at(-1), "daily cap $ 50", "still editing the cap, Ctrl+F inert");

    tui.key(undefined, "escape"); // leave budget mode
    tui.key(undefined, "r", { ctrl: true }); // enter role-prompt mode for the viewed loop
    assert.match(tui.lastFrame(), /prompt for clean/);
    tui.key(undefined, "f", { ctrl: true });
    assert.equal(isFleetPaused(repo), false);
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
    assert.match(tui.lastFrame(), /edit daily cost budget/);
    tui.key(undefined, "p", { ctrl: true });
    tui.key(undefined, "a", { ctrl: true });
    tui.key(undefined, "w", { ctrl: true });
    assert.deepEqual(pausedRoles(repo), []);
    assert.equal(fs.existsSync(wakeRequestPath(repo)), false);
    assert.equal(tui.lines().at(-1), "daily cap $ 50", "still editing the cap, keys inert");

    // A failed marker write flashes the reason instead of killing the TUI: the paused-roles
    // path is a directory, so writeJsonAtomic's rename throws and the catch flashes it.
    tui.key(undefined, "escape"); // leave budget mode
    fs.mkdirSync(pausedRolesPath(repo), { recursive: true });
    tui.key(undefined, "p", { ctrl: true });
    assert.match(tui.lastFrame(), /error: /);
  });
});
