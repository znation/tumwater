import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  applyLandingOutcome,
  applyTickOutcome,
  clearBackoff,
  freshLoopState,
  loadLoopState,
  nextBackoffSeconds,
  orchestratorAlive,
  readOrchestratorInfo,
  saveLoopState,
  zeroCounters,
} from "../src/state.js";
import { dailyCost, todayStamp } from "../src/budget.js";
import type { LoopState, TumwaterConfig } from "../src/types.js";
import { orchestratorStatePath, statePath } from "../src/paths.js";
import { defaultConfig } from "../src/config.js";
import { OBSERVER_ROLES } from "../src/roles.js";
import { tmpdir } from "./util.js";

/** Every field a fresh state has must hold its default value (extra junk keys are allowed). */
function assertFreshFields(s: LoopState, role: string): void {
  const fresh = freshLoopState(role);
  for (const key of Object.keys(fresh)) {
    assert.equal(
      s[key as keyof LoopState],
      fresh[key as keyof LoopState],
      `field ${key} should keep its default`,
    );
  }
}

test("loadLoopState returns fresh defaults when no file exists", () => {
  const dir = tmpdir();
  assert.deepEqual(loadLoopState(dir, "clean"), freshLoopState("clean"));
});

test("saveLoopState creates the state dir and round-trips without leaving a temp file", () => {
  const dir = tmpdir();
  const s = freshLoopState("feature");
  s.ticks = 7;
  s.generatedTokens = 123456;
  s.lastResult = "changed";
  saveLoopState(dir, s); // .tumwater/ does not exist yet
  assert.ok(fs.existsSync(statePath(dir, "feature")));
  const stateDir = path.dirname(statePath(dir, "feature"));
  assert.deepEqual(fs.readdirSync(stateDir), ["feature.json"], "no .tmp leftovers");
  assert.deepEqual(loadLoopState(dir, "feature"), s);
});

// Two processes hammering one role's state file concurrently — the real-world shape: the
// orchestrator saves at tick end and around its review gate while `tumwater reset-counters`
// rewrites the same file from the CLI process. With per-pid tmp names each writer owns its
// own tmp, so neither rename can ENOENT and the final file is always one complete state
// (last writer wins), never bytes mixed from both writers.
test("saveLoopState from two concurrent processes never tears the file or loses a rename", async () => {
  const dir = tmpdir();
  // The child imports the BUILT module, like every other spawned-child test in this suite.
  // Resolved against this test's own file:// URL, so the child can import it from any cwd.
  const stateUrl = new URL("../src/state.js", import.meta.url).href;
  // --input-type=module: top-level import in -e code needs explicit module syntax on Node
  // < 22.7 (engines declares >= 20); detection is not a portable default.
  const script = `
    import { saveLoopState } from ${JSON.stringify(stateUrl)};
    const [root, tag, n] = process.argv.slice(1);
    for (let i = 0; i < Number(n); i++) {
      const s = { role: "race", ticks: i, commits: 0, nextRunAt: 0, backoffSeconds: 0, lastMainHead: "", generatedTokens: 0, peakContextTokens: 0, totalCostUsd: 0, dayStamp: "", dayCostUsd: 0 };
      if (tag === "b") s.lastSummary = "writer-b padding ".repeat(16); // longer payload than writer a's
      saveLoopState(root, s);
    }`;
  const runWriter = (tag: string) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, tag, "300"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stderr }));
    });
  const [a, b] = await Promise.all([runWriter("a"), runWriter("b")]);
  assert.equal(a.code, 0, `writer a crashed: ${a.stderr}`);
  assert.equal(b.code, 0, `writer b crashed: ${b.stderr}`);

  const file = statePath(dir, "race");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    assert.fail(`state file is torn after concurrent writes (${String(err)})`);
  }
  // Last writer wins with a COMPLETE state from one process — never bytes mixed from both.
  const summary = parsed.lastSummary;
  assert.ok(
    summary === undefined || (typeof summary === "string" && summary.startsWith("writer-b padding")),
    `mixed writers in final state: ${JSON.stringify(summary)}`,
  );
  // No tmp remnants from either pid.
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp-")), [], "no tmp leftovers");
});

test("loadLoopState fills fields missing from an older or partial file", () => {
  const dir = tmpdir();
  const file = statePath(dir, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A state file written before generatedTokens/lastMainHead existed.
  fs.writeFileSync(file, JSON.stringify({ role: "clean", ticks: 3, commits: 1 }));
  const s = loadLoopState(dir, "clean");
  assert.equal(s.ticks, 3);
  assert.equal(s.commits, 1);
  // loop.ts adds to these every tick; undefined would turn them into NaN.
  assert.equal(s.generatedTokens, 0);
  assert.equal(s.peakContextTokens, 0);
  assert.equal(s.backoffSeconds, 0);
  assert.equal(s.lastMainHead, "");
  assert.ok(Number.isFinite(s.nextRunAt));
  // A file written before the daily budget window existed reads $0 through dailyCost —
  // spend recorded before dayStamp/dayCostUsd were fields is unknown, not infinite.
  assert.equal(dailyCost(s), 0);
});

test("loadLoopState recovers from torn or non-object JSON", () => {
  const dir = tmpdir();
  const file = statePath(dir, "dry");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const junk of ['{"ticks": 2', '"just a string"', "[1, 2]", "null"]) {
    fs.writeFileSync(file, junk);
    assertFreshFields(loadLoopState(dir, "dry"), "dry"); // must not throw or lose defaults
  }
});

test("zeroCounters zeroes the accumulated counters and preserves everything else", () => {
  const s = freshLoopState("feature");
  s.ticks = 12;
  s.commits = 5;
  s.generatedTokens = 987654;
  s.totalCostUsd = 3.14;
  s.peakContextTokens = 131072; // last tick's peak — must be cleared too
  s.nextRunAt = 1_700_000_000_000;
  s.backoffSeconds = 30;
  s.lastMainHead = "abc123";
  s.lastResult = "changed";
  s.lastSummary = "did a thing";
  s.lastTickStartedAt = 1;
  s.lastTickEndedAt = 2;
  s.dayStamp = todayStamp(); // daily budget window — must survive a reset
  s.dayCostUsd = 12.5;

  const z = zeroCounters(s);
  assert.equal(z.ticks, 0);
  assert.equal(z.commits, 0);
  assert.equal(z.generatedTokens, 0);
  assert.equal(z.totalCostUsd, 0);
  // Per-tick semantics: peak ctx holds the last completed tick's peak, so a fresh
  // observation window clears it — sleeping loops would otherwise keep showing their old
  // value until they next tick.
  assert.equal(z.peakContextTokens, 0);
  // Scheduling, wake tracking, and last-result fields are untouched.
  assert.equal(z.nextRunAt, s.nextRunAt);
  assert.equal(z.backoffSeconds, 30);
  assert.equal(z.lastMainHead, "abc123");
  assert.equal(z.lastResult, "changed");
  assert.equal(z.lastSummary, "did a thing");
  // The daily cost budget window is deliberately preserved: it is a safety valve, not an
  // observation window — zeroing today's spend would let the cap be bypassed by running
  // reset-counters.
  assert.equal(z.dayStamp, s.dayStamp);
  assert.equal(z.dayCostUsd, 12.5);
  // Pure: the input is unchanged and the result is a new object.
  assert.equal(s.ticks, 12);
  assert.notEqual(z, s);
});

test("clearBackoff zeroes the backoff and pulls nextRunAt to now, preserving everything else", () => {
  const s = freshLoopState("clean");
  s.ticks = 12;
  s.commits = 5;
  s.generatedTokens = 987654;
  s.totalCostUsd = 3.14;
  s.nextRunAt = 1_700_000_000_000; // two hours out — deep backoff
  s.backoffSeconds = 7680;
  s.lastMainHead = "abc123";
  s.lastResult = "no_change";
  s.lastSummary = "found nothing";
  s.dayStamp = todayStamp(); // daily budget window — must survive a wake
  s.dayCostUsd = 12.5;

  const now = 1_700_000_001_000;
  const w = clearBackoff(s, now);
  assert.equal(w.backoffSeconds, 0);
  assert.equal(w.nextRunAt, now);
  // Waking is a scheduling operation, not an observation-window reset: counters, wake
  // tracking, last-result fields, and the daily budget window are untouched.
  assert.equal(w.ticks, 12);
  assert.equal(w.commits, 5);
  assert.equal(w.generatedTokens, 987654);
  assert.equal(w.totalCostUsd, 3.14);
  assert.equal(w.lastMainHead, "abc123");
  assert.equal(w.lastResult, "no_change");
  assert.equal(w.lastSummary, "found nothing");
  assert.equal(w.dayStamp, s.dayStamp);
  assert.equal(w.dayCostUsd, 12.5);
  // Pure: the input is unchanged and the result is a new object.
  assert.equal(s.backoffSeconds, 7680);
  assert.notEqual(w, s);
});

test("nextBackoffSeconds caps an initial above max and treats non-positive current as first", () => {
  const ladder = { initialSeconds: 100, factor: 2, maxSeconds: 30 };
  assert.equal(nextBackoffSeconds(0, ladder), 30); // min(initial, max)
  assert.equal(nextBackoffSeconds(-5, ladder), 30); // current <= 0 → initial (capped)
  assert.equal(nextBackoffSeconds(29, ladder), 30); // growth still capped at max
});

// --- Post-tick outcome recording + next-run scheduling (extracted from LoopRunner.tick) ---

/** A config with a small idle backoff so the assertions below stay readable. */
function testConfig(): TumwaterConfig {
  const cfg = defaultConfig(); // minTickIntervalSeconds: 20
  cfg.idleBackoff = { initialSeconds: 30, factor: 2, maxSeconds: 3600 };
  return cfg;
}

test("applyTickOutcome records the outcome and schedules a changed tick at the role's minimum interval", () => {
  const s = freshLoopState("feature");
  s.running = true;
  s.phase = "review"; // set around the gate's run — must not linger after the tick
  s.commits = 4;
  const cfg = testConfig();
  const before = Date.now();
  applyTickOutcome(s, cfg, "feature", { result: "changed", summary: "did it" });
  assert.equal(s.running, false);
  assert.equal(s.phase, undefined);
  assert.equal(s.lastResult, "changed");
  assert.equal(s.lastSummary, "did it");
  const endedAt = s.lastTickEndedAt;
  assert.ok(endedAt !== undefined && endedAt >= before && endedAt <= Date.now(), "lastTickEndedAt stamped");
  assert.equal(s.commits, 5);
  assert.equal(s.backoffSeconds, 0);
  assert.ok(
    s.nextRunAt >= before + 20_000 && s.nextRunAt <= Date.now() + 20_000,
    "waits at least the minimum interval",
  );
});

test("applyTickOutcome: rejected and skipped ticks wait the minimum interval without counting a commit", () => {
  for (const result of ["rejected", "skipped"] as const) {
    const s = freshLoopState(result === "rejected" ? "feature" : "director");
    s.commits = 2;
    applyTickOutcome(s, testConfig(), s.role, { result });
    assert.equal(s.lastResult, result);
    assert.equal(s.commits, 2, `${result} lands nothing on main`);
    assert.equal(s.backoffSeconds, 0);
    assert.ok(
      s.nextRunAt >= Date.now() - 1_000 && s.nextRunAt <= Date.now() + 21_000,
      `next run is due after the minimum interval (${result})`,
    );
  }
});

test("applyTickOutcome: a queued tick schedules like a change without counting a commit", () => {
  // Merge queue 3/5: the tick committed and enqueued — productive work, so the minimum-interval
  // schedule applies — but `commits` keeps meaning "landed on main": applyLandingOutcome
  // increments it when the landing slot actually merges.
  const s = freshLoopState("feature");
  s.commits = 4;
  s.phase = "review"; // any marker from around the pin — must not linger after the tick
  applyTickOutcome(s, testConfig(), "feature", { result: "queued", summary: "did it" });
  assert.equal(s.lastResult, "queued");
  assert.equal(s.lastSummary, "did it");
  assert.equal(s.commits, 4, "the commit is not counted until it lands");
  assert.equal(s.backoffSeconds, 0);
  assert.ok(
    s.nextRunAt >= Date.now() - 1_000 && s.nextRunAt <= Date.now() + 21_000,
    "next run is due after the minimum interval",
  );
});

test("applyLandingOutcome folds the landing's result into the authoring state", () => {
  // A landed change counts the commit the tick queued and clears the gate's phase marker.
  const s = freshLoopState("feature");
  s.phase = "review";
  applyLandingOutcome(s, "changed");
  assert.equal(s.lastResult, "changed");
  assert.equal(s.commits, 1);
  assert.equal(s.phase, undefined);

  // Non-terminal outcomes record the failure, count no commit, and clear the marker — the
  // retry rides next-tick leftover recovery, so the state just has to show the failure.
  for (const result of ["rejected", "review_error", "merge_conflict", "merge_blocked", "error"] as const) {
    const n = freshLoopState("feature");
    applyLandingOutcome(n, result);
    assert.equal(n.lastResult, result);
    assert.equal(n.commits, 0, `${result} lands nothing on main`);
    assert.equal(n.phase, undefined);
  }

  // An aborted landing keeps the marker: a shutdown mid-review must re-review the pinned work
  // fresh on the next launch, and the dashboard shows the landing as interrupted, not done.
  const a = freshLoopState("feature");
  a.phase = "review";
  applyLandingOutcome(a, "aborted");
  assert.equal(a.lastResult, "aborted");
  assert.equal(a.commits, 0);
  assert.equal(a.phase, "review");
});

test("applyTickOutcome: an aborted tick resumes promptly — role via resumePending, director via re-queue", () => {
  const s = freshLoopState("feature");
  s.phase = "review"; // interruption hit mid-review: the next launch must recover + re-review
  applyTickOutcome(s, testConfig(), "feature", { result: "aborted" });
  assert.equal(s.resumePending, true);
  assert.equal(s.phase, "review", "kept so recovery re-reviews instead of resuming the author session");
  assert.ok(Math.abs(s.nextRunAt - Date.now()) < 5_000, "due immediately on restart");

  const d = freshLoopState("director");
  applyTickOutcome(d, testConfig(), "director", { result: "aborted" });
  assert.equal(d.resumePending, undefined, "the director reruns its re-queued prompt fresh");
});

test("applyTickOutcome: a user-aborted tick backs off like an unproductive one and sets no resume", () => {
  // A deliberate stop is not an interruption: the worktree was already reset to main, so there
  // is nothing to recover or re-review — idle backoff applies instead of prompt resume.
  const s = freshLoopState("feature");
  s.phase = "review"; // set around the gate's run — must not linger after a user-abort either
  applyTickOutcome(s, testConfig(), "feature", { result: "user_aborted" });
  assert.equal(s.lastResult, "user_aborted");
  assert.equal(s.resumePending, undefined, "a deliberate stop leaves nothing to resume");
  assert.equal(s.phase, undefined);
  assert.equal(s.backoffSeconds, 30, "initial idle backoff, like an unproductive tick");
  assert.ok(
    s.nextRunAt >= Date.now() - 1_000 && s.nextRunAt <= Date.now() + 31_000,
    "due after the backoff, not immediately",
  );

  // A second user-abort grows the backoff like any other unproductive tick.
  const s2 = freshLoopState("feature");
  s2.backoffSeconds = 30;
  applyTickOutcome(s2, testConfig(), "feature", { result: "user_aborted" });
  assert.equal(s2.backoffSeconds, 60); // 30 × factor 2
});

test("applyTickOutcome: cut-off ticks resume the compacted session until the streak limit, then back off", () => {
  const cfg = testConfig();
  // Under the limit (3): each consecutive cut-off resumes promptly and grows the streak.
  for (let streak = 0; streak < 3; streak++) {
    const s = freshLoopState("feature");
    s.cutOffStreak = streak;
    applyTickOutcome(s, cfg, "feature", { result: "no_change", cutOff: true });
    assert.equal(s.resumePending, true, `cut-off ${streak + 1} resumes`);
    assert.equal(s.cutOffStreak, streak + 1);
    assert.equal(s.backoffSeconds, 0, "a cut-off is not idleness");
    assert.ok(s.nextRunAt <= Date.now() + 21_000);
  }
  // Past the limit: give up on the task — normal backoff, no resume. The streak keeps counting
  // (only a non-cut-off tick clears it): the next fresh tick's prompt names how many attempts
  // the window has eaten (buildCutOffNote), and the next cut-off also backs off.
  const s = freshLoopState("feature");
  s.cutOffStreak = 3;
  applyTickOutcome(s, cfg, "feature", { result: "no_change", cutOff: true });
  assert.equal(s.resumePending, undefined);
  assert.equal(s.backoffSeconds, 30); // initial backoff
  assert.equal(s.cutOffStreak, 4);
});

test("applyTickOutcome: quiet kills resume the starved session until the streak limit, then back off", () => {
  const cfg = testConfig();
  // Under the limit (3): each consecutive kill resumes promptly and grows the streak.
  for (let streak = 0; streak < 3; streak++) {
    const s = freshLoopState("feature");
    s.quietKillStreak = streak;
    applyTickOutcome(s, cfg, "feature", { result: "quiet_killed" });
    assert.equal(s.resumePending, true, `quiet kill ${streak + 1} resumes`);
    assert.equal(s.resumeCause, "hung-tool");
    assert.equal(s.quietKillStreak, streak + 1);
    assert.equal(s.backoffSeconds, 0, "a quiet kill is not idleness");
    assert.ok(s.nextRunAt <= Date.now() + 1_000, "resumes promptly");
  }
  // Past the limit: abandon the starved session and take a fresh tick on the idle ladder
  // (BUGS.md 2026-09-18). Before the fix the branch resumed forever with no backoff.
  const s = freshLoopState("feature");
  s.quietKillStreak = 3;
  applyTickOutcome(s, cfg, "feature", { result: "quiet_killed" });
  assert.equal(s.resumePending, false, "no resume — the next tick starts fresh");
  assert.equal(s.resumeCause, undefined);
  assert.equal(s.backoffSeconds, 30); // idle initial
  assert.equal(s.quietKillStreak, 4, "the streak keeps counting for the warning note");
});

test("applyTickOutcome: any non-quiet-kill outcome resets the quiet-kill streak", () => {
  const cfg = testConfig();
  const s = freshLoopState("feature");
  s.quietKillStreak = 2;
  applyTickOutcome(s, cfg, "feature", { result: "no_change" });
  assert.equal(s.quietKillStreak, 0);
  // The error streak and the quiet-kill streak stay independent: an error resets one
  // without arming the other.
  applyTickOutcome(s, cfg, "feature", { result: "error" });
  assert.equal(s.quietKillStreak, 0);
  assert.equal(s.consecutiveErrors, 1);
});

test("applyTickOutcome: other unproductive outcomes grow the idle backoff and clear the cut-off streak", () => {
  const cfg = testConfig();
  const s = freshLoopState("feature");
  s.backoffSeconds = 30;
  s.cutOffStreak = 2; // a prior cut-off — this tick finished normally, so it resets
  applyTickOutcome(s, cfg, "feature", { result: "merge_conflict" });
  assert.equal(s.lastResult, "merge_conflict");
  assert.equal(s.backoffSeconds, 60); // 30 × factor 2
  assert.ok(
    s.nextRunAt >= Date.now() - 1_000 && s.nextRunAt <= Date.now() + 61_000,
    "due after the grown backoff",
  );
  assert.equal(s.cutOffStreak, 0);

  // A summary-less outcome keeps the previous lastSummary (stale beats wiped).
  const s2 = freshLoopState("feature");
  s2.lastSummary = "previous";
  applyTickOutcome(s2, cfg, "feature", { result: "no_change" });
  assert.equal(s2.lastSummary, "previous");
});

test("applyTickOutcome: an observer's no_change schedules at its interval without climbing the idle ladder", () => {
  // plans/observer-roles.md 1/2: qa's no_change means "checked, all well", so it must not be
  // punished with a doubling sleep. The interval is the only cadence knob left for it.
  const cfg = testConfig(); // minTickIntervalSeconds: 20
  for (const role of OBSERVER_ROLES) {
    const s = freshLoopState(role);
    s.backoffSeconds = 300; // a grown backoff from an earlier episode — must reset, not build on it
    const before = Date.now();
    applyTickOutcome(s, cfg, role, { result: "no_change" });
    assert.equal(s.backoffSeconds, 0, `${role}: a passing check leaves no backoff`);
    assert.ok(
      s.nextRunAt >= before + 20_000 && s.nextRunAt <= Date.now() + 20_000,
      `${role}: scheduled at minTickIntervalSeconds, not the idle ladder`,
    );
  }
  // A non-observer's no_change still climbs the idle ladder, byte-identical to before.
  const s = freshLoopState("organize");
  s.backoffSeconds = 30;
  applyTickOutcome(s, cfg, "organize", { result: "no_change" });
  assert.equal(s.backoffSeconds, 60);
});

test("applyTickOutcome: an observer still climbs the error ladder and idles on a user-abort", () => {
  // The idle branch is the only one the observer predicate reaches: a broken toolchain and a
  // deliberate operator stop keep the ordinary backoff (invariant 1 of plans/observer-roles.md).
  const cfg = testConfig();
  for (const role of OBSERVER_ROLES) {
    const err = freshLoopState(role);
    applyTickOutcome(err, cfg, role, { result: "error", summary: "git is broken" });
    assert.equal(err.backoffSeconds, 30, `${role}: a broken toolchain still parks it`);
    assert.ok(err.nextRunAt <= Date.now() + 31_000, `${role}: retries on the short error ladder`);

    const aborted = freshLoopState(role);
    applyTickOutcome(aborted, cfg, role, { result: "user_aborted" });
    assert.equal(aborted.backoffSeconds, 30, `${role}: a deliberate stop still backs off`);
  }
});

// --- Error ladder: a failed tick retries in minutes, never the idle ladder's cap
// (BUGS.md 2026-09-15: one broken `git` parked the whole fleet for hours) ---

test("applyTickOutcome: consecutive error ticks climb a short ladder capped in minutes", () => {
  const cfg = testConfig();
  const s = freshLoopState("bugfix");
  const seen: number[] = [];
  for (let i = 0; i < 10; i++) {
    applyTickOutcome(s, cfg, "bugfix", { result: "error", summary: "git is broken" });
    seen.push(s.backoffSeconds);
  }
  // 30 → 60 → 120 → 240 → 480, then pinned at the error cap — free failures must never
  // reach the idle ladder's 10-hour sleep.
  assert.deepEqual(seen, [30, 60, 120, 240, 480, 600, 600, 600, 600, 600]);
  assert.ok(s.backoffSeconds <= 600, "a minute-order cap, not the idle ladder's 10 h");
  assert.ok(
    s.nextRunAt >= Date.now() - 1_000 && s.nextRunAt <= Date.now() + 601_000,
    "the next retry is due within the error cap",
  );
  assert.equal(s.lastResult, "error");
  assert.equal(s.lastSummary, "git is broken", "the failure is observable in state");
});

test("applyTickOutcome: the error streak counts consecutive failures and resets on any other result", () => {
  const cfg = testConfig();
  const s = freshLoopState("clean");
  applyTickOutcome(s, cfg, "clean", { result: "no_change" });
  assert.equal(s.consecutiveErrors, 0, "a healthy tick leaves the streak at zero");
  applyTickOutcome(s, cfg, "clean", { result: "error", summary: "git is broken" });
  applyTickOutcome(s, cfg, "clean", { result: "error", summary: "git is broken" });
  assert.equal(s.consecutiveErrors, 2, "two consecutive failures");
  applyTickOutcome(s, cfg, "clean", { result: "no_change" });
  assert.equal(s.consecutiveErrors, 0, "one healthy tick breaks the episode");
  applyTickOutcome(s, cfg, "clean", { result: "error" });
  assert.equal(s.consecutiveErrors, 1, "the next episode re-arms from scratch");
});

test("applyTickOutcome: no_change laddering is unchanged by the error ladder", () => {
  const cfg = testConfig();
  const s = freshLoopState("feature");
  applyTickOutcome(s, cfg, "feature", { result: "no_change" });
  assert.equal(s.backoffSeconds, 30, "the first no-change tick takes the idle initial");
  applyTickOutcome(s, cfg, "feature", { result: "no_change" });
  assert.equal(s.backoffSeconds, 60, "the second doubles it, as before the fix");
  // The idle cap is still reachable for the case it was written for: an idle loop can
  // reach its full 3600 s ceiling, an error loop cannot.
  for (let i = 0; i < 20; i++) applyTickOutcome(s, cfg, "feature", { result: "no_change" });
  assert.equal(s.backoffSeconds, 3600);
});

test("applyTickOutcome: an error after idle backoff caps at the error ceiling, and productive ticks zero it", () => {
  const cfg = testConfig();
  // A loop deep in idle backoff that then fails its tick retries within the error cap,
  // not the idle cap — the ladders share backoffSeconds and each caps the step it takes.
  const s = freshLoopState("feature");
  s.backoffSeconds = 3600;
  applyTickOutcome(s, cfg, "feature", { result: "error" });
  assert.equal(s.backoffSeconds, 600); // min(3600 × 2, error cap 600)
  // A no-change tick after the error streak resumes the idle ladder from the current
  // value: backoff never shrinks below what the streak earned.
  applyTickOutcome(s, cfg, "feature", { result: "no_change" });
  assert.equal(s.backoffSeconds, 1200); // min(600 × 2, idle cap 3600)

  // A productive tick zeroes the backoff regardless of which ladder fed it.
  for (const result of ["changed", "rejected"] as const) {
    const z = freshLoopState("feature");
    z.backoffSeconds = 600;
    applyTickOutcome(z, cfg, "feature", { result });
    assert.equal(z.backoffSeconds, 0, `${result} zeroes the backoff`);
  }
});

// --- Orchestrator info file: the readers live here so observers don't depend on the scheduler ---

test("readOrchestratorInfo and orchestratorAlive handle missing, valid, dead-pid, and corrupt state", () => {
  const dir = tmpdir();
  assert.equal(readOrchestratorInfo(dir), null);
  assert.equal(orchestratorAlive(dir), false);

  const file = orchestratorStatePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Our own pid is alive; a huge one is not.
  for (const [pid, alive] of [
    [process.pid, true],
    [999_999_999, false],
  ] as const) {
    fs.writeFileSync(file, JSON.stringify({ pid, startedAt: Date.now(), roles: ["clean"] }));
    assert.equal(readOrchestratorInfo(dir)?.pid, pid);
    assert.equal(orchestratorAlive(dir), alive);
  }

  // A torn write must not crash observers (TUI/GUI poll this every second).
  fs.writeFileSync(file, "{ not json");
  assert.equal(readOrchestratorInfo(dir), null);
  assert.equal(orchestratorAlive(dir), false);
});
