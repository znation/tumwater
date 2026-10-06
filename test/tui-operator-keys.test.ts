/** The TUI per-loop operator controls (extracted from tui.test.ts): Ctrl+P pause/resume and
 * its fleet-pause interplay note, Ctrl+A's abort confirmation and liveness gate, Ctrl+W's
 * wake marker, and the keys' inertness outside transcript views and in budget mode
 * (PLANS.md "TUI per-loop controls"). Like the other topic-named slices (loop-refusal,
 * orchestrator-budget, review-precheck), this file holds one coherent topic; the shared
 * fake-TTY harness lives in tui-fixtures.ts. Each test file gets its own process, so the
 * harness's global stdout/stdin/readline patches never meet another file's environment. */
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { pauseFleet, pausedRoles } from "../src/fleet/fleet-state.js";
import { abortRequestPath, pausedRolesPath, wakeRequestPath } from "../src/paths.js";
import { freshLoopState, saveLoopState } from "../src/loop-state.js";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { writeOrchestratorMarker } from "./log-fixtures.js";
import { makeTuiRepo, withTui } from "./tui-fixtures.js";

// PLANS.md "TUI per-loop controls": Ctrl+P/Ctrl+A/Ctrl+W act on the loop whose transcript is
// on screen, through the same marker-writing cores the CLI's --role flags call, so the two
// surfaces cannot drift on marker format, idempotence, or wording (rolePauseMessage and
// roleResumeMessage in src/operator-intent.ts are the shared single writer of the wording).
test("Ctrl+P toggles the viewed loop's pause marker and flashes the CLI's wording", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → transcript (one enabled role)
    assert.match(tui.lastFrame(), /Ctrl\+P pause\/resume · Ctrl\+W wake · Ctrl\+A abort/); // header hint

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
  // A director mid-tick: running with a started-at stamp renders the "working" phase, which
  // isActivePhase reads as in flight; the orchestrator marker keeps the fleet live for the gate.
  saveLoopState(repo, { ...freshLoopState("director"), running: true, lastTickStartedAt: Date.now() - 60_000 });
  writeOrchestratorMarker(repo, ["clean", "director"]);
  await withTui(repo, async (tui) => {
    assert.match(tui.lines().join("\n"), /director[^\n]*working/); // the row the flag is read from
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

