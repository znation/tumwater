import test from "node:test";
import { readJson } from "./helpers/json-read.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { freshRunnerState, saveRunnerState, zeroCounters } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { isTeamPaused, pauseTeam, resumeTeam } from "../src/team/team-state.js";
import { orchestratorAlive, readOrchestratorInfo } from "../src/team/team-orchestrator-info.js";
import { dailyCost, todayStamp } from "../src/budget/budget.js";
import type { RunnerState } from "../src/runner/runner-state.js";
import { orchestratorStatePath, pausedPath, statePath } from "../src/paths.js";
import { tmpdir, initializedRepo, writeMalformedJson } from "./fixtures/repo-fixtures.js";
import { makeRoleRunner } from "./fixtures/runner-fixtures.js";
import { withIdlePi } from "./fakes/fake-pi.js";
import { patchFsMethod, errnoError } from "./helpers/fs-faults.js";
import { writeOrchestratorMarker, warningMessages } from "./fixtures/log-fixtures.js";
import { ensureParentDir } from "../src/files/files.js";

/** The persisted-state file's own tests (src/runner/runner-state.ts): fresh defaults, the tolerant
 * load,
 * the atomic save, the counter reset — and the orchestrator info file, whose readers live in
 * team/team-orchestrator-info.ts but whose shape is pinned beside the state convention it mirrors.
 * The run-apply.ts scheduling policy's tests live in run-apply.test.ts. */

/** Every field a fresh state has must hold its default value (extra junk keys are allowed). */
function assertFreshFields(s: RunnerState, role: string): void {
  const fresh = freshRunnerState(role);
  for (const key of Object.keys(fresh)) {
    assert.equal(
      s[key as keyof RunnerState],
      fresh[key as keyof RunnerState],
      `field ${key} should keep its default`,
    );
  }
}

test("loadRunnerState returns fresh defaults when no file exists", () => {
  const dir = tmpdir();
  assert.deepEqual(loadRunnerState(dir, "clean"), freshRunnerState("clean"));
});

test("pauseTeam and resumeTeam write the pause marker and report whether state changed", () => {
  const dir = tmpdir(); // fresh repo: no .tumwater/ yet — writeJsonAtomic must create it
  assert.equal(isTeamPaused(dir), false);

  assert.equal(pauseTeam(dir), true, "the first pause changes state");
  assert.equal(isTeamPaused(dir), true);
  const marker = readJson(pausedPath(dir)) as { at: number };
  assert.deepEqual(Object.keys(marker), ["at"], "the marker keeps the CLI's { at } shape");
  assert.equal(typeof marker.at, "number");

  assert.equal(pauseTeam(dir), false, "a repeat pause is a no-op");
  assert.equal(isTeamPaused(dir), true);

  assert.equal(resumeTeam(dir), true, "resume lifts the marker");
  assert.equal(isTeamPaused(dir), false);
  assert.equal(fs.existsSync(pausedPath(dir)), false);

  assert.equal(resumeTeam(dir), false, "resume without a marker is a no-op");
});

test("a state file carrying a stale legacy role id loads under the requested id and saves there", () => {
  // migrateLegacyRoleIds renamed state/dry.json to state/dedupe.json without rewriting the
  // `role` field, so the file holds `"role": "dry"`. loadRunnerState must treat the file
  // name as the identity — otherwise the saved role wins, saveRunnerState writes back under
  // the retired id, and every start reloads the frozen copy.
  const dir = tmpdir();
  const file = statePath(dir, "dedupe");
  ensureParentDir(file);
  fs.writeFileSync(file, JSON.stringify({ role: "dry", runs: 3, commits: 1 })); // retired-name-ok: legacy role id
  const s = loadRunnerState(dir, "dedupe");
  assert.equal(s.role, "dedupe");
  assert.equal(s.runs, 3, "the stale-role file's data still loads");
  // The next save must land under the requested id, not the stale id.
  fs.writeFileSync(statePath(dir, "dry"), JSON.stringify({ role: "dry", runs: 0 }));
  saveRunnerState(dir, s);
  assert.equal(JSON.parse(fs.readFileSync(statePath(dir, "dedupe"), "utf8")).role, "dedupe");
});

test("saveRunnerState creates the state dir and round-trips without leaving a temp file", () => {
  const dir = tmpdir();
  const s = freshRunnerState("feature");
  s.runs = 7;
  s.generatedTokens = 123456;
  s.lastResult = "changed";
  saveRunnerState(dir, s); // .tumwater/ does not exist yet
  assert.ok(fs.existsSync(statePath(dir, "feature")));
  const stateDir = path.dirname(statePath(dir, "feature"));
  assert.deepEqual(fs.readdirSync(stateDir), ["feature.json"], "no .tmp leftovers");
  assert.deepEqual(loadRunnerState(dir, "feature"), s);
});

// A state file whose JSON carries a different `role` than its name — the stale-role split
// BUGS.md 2026-10-23 describes. The legacy role-id migration renames the file (LEGACY_ROLE_IDS
// maps `telemetry` → `selfcheck`, `dry` → `dedupe`) but cannot rewrite the `role` a saved state
// already carries, so the file sits under its new name with the old role inside. The file name
// is the identity: the load keeps the requested id so the state saves back under that name
// instead of recreating the frozen old-id split on every start.
test("loadRunnerState treats the file name as the id, even when the JSON's role differs", () => {
  const dir = tmpdir();
  const file = statePath(dir, "selfcheck");
  ensureParentDir(file);
  fs.writeFileSync(file, JSON.stringify({ role: "telemetry", runs: 9, lastResult: "changed" }));
  const s = loadRunnerState(dir, "selfcheck");
  assert.equal(s.role, "selfcheck", "the requested id wins over the persisted role");
  assert.equal(s.runs, 9, "the rest of the persisted state is still loaded");
  saveRunnerState(dir, s);
  assert.ok(fs.existsSync(statePath(dir, "selfcheck")), "saves under the requested new-name path");
  assert.equal(
    fs.existsSync(statePath(dir, "telemetry")),
    false,
    "no old-id file is recreated by the save",
  );
  assert.equal(loadRunnerState(dir, "selfcheck").role, "selfcheck");
});

// Two processes hammering one role's state file concurrently — the real-world shape: the
// orchestrator saves at run end and around its review gate while `tumwater reset-counters`
// rewrites the same file from the CLI process. With per-pid tmp names each writer owns its
// own tmp, so neither rename can ENOENT and the final file is always one complete state
// (last writer wins), never bytes mixed from both writers.
test("saveRunnerState from two concurrent processes never tears the file or loses a rename", async () => {
  const dir = tmpdir();
  // The child imports the BUILT module, like every other spawned-child test in this suite.
  // Resolved against this test's own file:// URL, so the child can import it from any cwd.
  const stateUrl = new URL("../src/runner/runner-state.js", import.meta.url).href;
  // --input-type=module: top-level import in -e code needs explicit module syntax on Node
  // < 22.7 (engines declares >= 20); detection is not a portable default.
  const script = `
    import { saveRunnerState } from ${JSON.stringify(stateUrl)};
    const [root, tag, n] = process.argv.slice(1);
    for (let i = 0; i < Number(n); i++) {
      const s = { role: "race", runs: i, commits: 0, nextRunAt: 0, backoffSeconds: 0, lastMainHead: "", generatedTokens: 0, peakContextTokens: 0, totalCostUsd: 0, dayStamp: "", dayCostUsd: 0 };
      if (tag === "b") s.lastSummary = "writer-b padding ".repeat(16); // longer payload than writer a's
      saveRunnerState(root, s);
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
    parsed = readJson(file);
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

test("loadRunnerState drops an unknown skipReason and keeps a known one", () => {
  const dir = tmpdir();
  const file = statePath(dir, "clean");
  ensureParentDir(file);
  fs.writeFileSync(file, JSON.stringify({ role: "clean", skipReason: "from-the-future" }));
  assert.equal(loadRunnerState(dir, "clean").skipReason, undefined);
  fs.writeFileSync(file, JSON.stringify({ role: "clean", skipReason: "claim-hold" }));
  assert.equal(loadRunnerState(dir, "clean").skipReason, "claim-hold");
});

test("loadRunnerState fills fields missing from an older or partial file", () => {
  const dir = tmpdir();
  const file = statePath(dir, "clean");
  ensureParentDir(file);
  // A state file written before generatedTokens/lastMainHead existed.
  fs.writeFileSync(file, JSON.stringify({ role: "clean", ticks: 3, commits: 1 })); // retired-name-ok: legacy name
  const s = loadRunnerState(dir, "clean");
  assert.equal(s.runs, 3);
  assert.equal(s.commits, 1);
  // run-usage.ts folds generatedTokens/peakContextTokens; scheduling/backoff.ts advances
  // backoffSeconds; run-finalize.ts records lastMainHead. Undefined would turn numbers to NaN.
  assert.equal(s.generatedTokens, 0);
  assert.equal(s.peakContextTokens, 0);
  assert.equal(s.backoffSeconds, 0);
  assert.equal(s.lastMainHead, "");
  assert.ok(Number.isFinite(s.nextRunAt));
  // A file written before the daily budget window existed reads $0 through dailyCost —
  // spend recorded before dayStamp/dayCostUsd were fields is unknown, not infinite.
  assert.equal(dailyCost(s), 0);
  // Optional fields absent from the file stay absent rather than being injected as 0.
  assert.equal("lastRunStartedAt" in s, false);
});

test("loadRunnerState heals a corrupt persisted numeric field", () => {
  const dir = tmpdir();
  const file = statePath(dir, "dirty");
  ensureParentDir(file);
  // A hand-edited or foreign-typed state file. Each top-level numeric field is a count,
  // duration, epoch-ms stamp, or amount, and all of them feed scheduling arithmetic or a
  // dashboard cell, so an unusable value heals to 0 rather than rendering NaN or a total
  // that runs backwards.
  fs.writeFileSync(
    file,
    JSON.stringify({
      role: "dirty",
      runs: "12",
      commits: null,
      nextRunAt: -1,
      backoffSeconds: "30",
      generatedTokens: { count: 3 },
      peakContextTokens: -5,
      totalCostUsd: "1.23",
      dayCostUsd: 4, // a real number is kept, not healed away
      lastRunStartedAt: "yesterday",
      lastRunEndedAt: null,
      wokenAt: -9,
      cutOffStreak: "2",
      quietKillStreak: [1],
      consecutiveErrors: -1,
      noChangeStreak: "lots",
      unreviewFailures: "lots",
      parkedSince: "soon",
      streakAcked: -3, // the breaker's excused-streak ack heals like the error streak it excuses
    }),
  );
  const s = loadRunnerState(dir, "dirty");
  for (const key of [
    "runs",
    "commits",
    "nextRunAt",
    "backoffSeconds",
    "generatedTokens",
    "peakContextTokens",
    "totalCostUsd",
    "lastRunStartedAt",
    "lastRunEndedAt",
    "wokenAt",
    "cutOffStreak",
    "quietKillStreak",
    "consecutiveErrors",
    "noChangeStreak",
    "unreviewFailures",
    "parkedSince",
    "streakAcked",
  ] as const) {
    assert.equal(s[key], 0, `field ${key} should heal to 0`);
  }
  assert.equal(s.dayCostUsd, 4);
});

test("loadRunnerState heals corrupt numeric fields inside nested records", () => {
  const dir = tmpdir();
  const file = statePath(dir, "nested");
  ensureParentDir(file);
  // The nested scheduling records carry epoch-ms stamps and recovery counts; a hand-edited
  // or foreign-typed value there feeds comparisons and arithmetic, so it heals to 0 exactly
  // as the top-level fields do.
  fs.writeFileSync(
    file,
    JSON.stringify({
      role: "nested",
      lastReview: { verdict: "reject", reasons: [], at: "yesterday" },
      claim: { file: "PLANS.md", key: "k", title: "t", at: -1, source: "assigned" },
      revision: { sha: "abc", round: "2", at: null },
      mergeConflicts: { sha: "abc", count: "many" },
      conflictDiscard: { sha: "abc", summary: "s", attempts: -3, at: {} },
      conflictHandback: { sha: "abc", at: "later", round: -4, reason: "landing", applied: false }, // vocabulary-ok: legacy state value read from old files
      mergeCheckFailures: { patchId: "p", count: [1] },
    }),
  );
  const s = loadRunnerState(dir, "nested");
  assert.equal(s.lastReview?.at, 0);
  assert.equal(s.claim?.at, 0);
  assert.equal(s.revision?.round, 0);
  assert.equal(s.revision?.at, 0);
  assert.equal(s.mergeConflicts?.count, 0);
  assert.equal(s.conflictDiscard?.attempts, 0);
  assert.equal(s.conflictDiscard?.at, 0);
  assert.equal(s.conflictHandback?.at, 0);
  assert.equal(s.conflictHandback?.round, 0);
  assert.equal(s.conflictHandback?.reason, "merge", "an old build's merge reason loads as merge");
  assert.equal(s.mergeCheckFailures?.count, 0);
});

test("loadRunnerState heals a foreign-typed lastReview.reasons to an empty list", () => {
  const dir = tmpdir();
  const file = statePath(dir, "reasons");
  ensureParentDir(file);
  // reasons is the one nested non-numeric slot whose foreign type throws rather than merely
  // reading odd: the rejected-review notes build a numbered list from it (numberedList's
  // `.map`), so a hand-edited "because" or a dropped field would crash the next run's prompt
  // builder. Heal it to its string entries, or [] when it is not an array at all.
  const cases: Array<[unknown, string[]]> = [
    ["because", []],
    [[1, "kept"], ["kept"]],
    [null, []],
  ];
  for (const [bad, expected] of cases) {
    fs.writeFileSync(
      file,
      JSON.stringify({
        role: "reasons",
        lastReview: { verdict: "reject", reasons: bad, at: 1 },
      }),
    );
    const s = loadRunnerState(dir, "reasons");
    assert.deepEqual(s.lastReview?.reasons, expected);
    assert.equal(s.lastReview?.verdict, "reject");
    assert.equal(s.lastReview?.at, 1);
  }
});

test("loadRunnerState drops a nested record that is not a plain object, keeping real ones", () => {
  const dir = tmpdir();
  const file = statePath(dir, "torn");
  ensureParentDir(file);
  // A scalar/array in a nested slot would throw on the first property write (merge-core
  // sets lastReview.exhausted; run-apply adds to mergeConflicts.count), so it reads as absent
  // — the same no-data policy readJsonFile applies to the file as a whole.
  fs.writeFileSync(
    file,
    JSON.stringify({
      role: "torn",
      lastReview: "not an object",
      revision: [1, 2],
      mergeConflicts: null,
      conflictDiscard: true,
      conflictHandback: 0,
      mergeCheckFailures: "none",
      mergeFlakeExcused: 7,
      claim: { file: "BUGS.md", key: "k", title: "t", at: 42, source: "staged" }, // real record kept
    }),
  );
  const s = loadRunnerState(dir, "torn");
  assert.equal(s.lastReview, undefined);
  assert.equal(s.revision, undefined);
  assert.equal(s.mergeConflicts, undefined);
  assert.equal(s.conflictDiscard, undefined);
  assert.equal(s.conflictHandback, undefined);
  assert.equal(s.mergeCheckFailures, undefined);
  assert.equal("mergeFlakeExcused" in s, false);
  assert.equal(s.claim?.at, 42, "a valid record keeps its real values");
  assert.equal(s.claim?.key, "k");
});

test("loadRunnerState drops a mainRedRetry with a foreign-typed waitingSince", () => {
  const dir = tmpdir();
  const file = statePath(dir, "parked");
  ensureParentDir(file);
  const retry = { head: "h", entry: { role: "parked", summary: "s" } };
  fs.writeFileSync(file, JSON.stringify({ role: "parked", mainRedRetry: { ...retry, waitingSince: "9" } }));
  assert.equal(loadRunnerState(dir, "parked").mainRedRetry, undefined);

  fs.writeFileSync(file, JSON.stringify({ role: "parked", mainRedRetry: { ...retry, waitingSince: 9 } }));
  assert.equal(loadRunnerState(dir, "parked").mainRedRetry?.waitingSince, 9);
});

test("loadRunnerState recovers from torn or non-object JSON", () => {
  const dir = tmpdir();
  const file = statePath(dir, "dedupe");
  ensureParentDir(file);
  for (const junk of ['{"ticks": 2', '"just a string"', "[1, 2]", "null"]) { // retired-name-ok: legacy name
    fs.writeFileSync(file, junk);
    assertFreshFields(loadRunnerState(dir, "dedupe"), "dedupe"); // must not throw or lose defaults
  }
});

test("zeroCounters zeroes the accumulated counters and preserves everything else", () => {
  const s = freshRunnerState("feature");
  s.runs = 12;
  s.commits = 5;
  s.generatedTokens = 987654;
  s.totalCostUsd = 3.14;
  s.peakContextTokens = 131072; // last run's peak — must be cleared too
  s.nextRunAt = 1_700_000_000_000;
  s.backoffSeconds = 30;
  s.lastMainHead = "abc123";
  s.lastResult = "changed";
  s.lastSummary = "did a thing";
  s.lastRunStartedAt = 1;
  s.lastRunEndedAt = 2;
  s.dayStamp = todayStamp(); // daily budget window — must survive a reset
  s.dayCostUsd = 12.5;

  const z = zeroCounters(s);
  assert.equal(z.runs, 0);
  assert.equal(z.commits, 0);
  assert.equal(z.generatedTokens, 0);
  assert.equal(z.totalCostUsd, 0);
  // Per-run semantics: peak ctx holds the last completed run's peak, so a fresh
  // observation window clears it — sleeping runners would otherwise keep showing their old
  // value until they next run.
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
  assert.equal(s.runs, 12);
  assert.notEqual(z, s);
});

// --- Orchestrator info file: the readers live here so observers don't depend on the scheduler ---

test("readOrchestratorInfo and orchestratorAlive handle missing, valid, dead-pid, and corrupt state", () => {
  const dir = tmpdir();
  assert.equal(readOrchestratorInfo(dir), null);
  assert.equal(orchestratorAlive(dir), false);

  const file = orchestratorStatePath(dir);
  ensureParentDir(file);
  // Our own pid is alive; a huge one is not.
  for (const [pid, alive] of [
    [process.pid, true],
    [999_999_999, false],
  ] as const) {
    writeOrchestratorMarker(dir, ["clean"], { pid });
    assert.equal(readOrchestratorInfo(dir)?.pid, pid);
    assert.equal(orchestratorAlive(dir), alive);
  }

  // A torn write must not crash observers (TUI/GUI poll this every second).
  writeMalformedJson(file);
  assert.equal(readOrchestratorInfo(dir), null);
  assert.equal(orchestratorAlive(dir), false);
});

test("loadRunnerState heals dayCostByPair: bad entries drop, a non-object becomes {}, __proto__ stays an own key", () => {
  const dir = tmpdir("runner-state-pair-");
  const write = (role: string, raw: string) => {
    const file = statePath(dir, role);
    ensureParentDir(file);
    fs.writeFileSync(file, raw);
  };
  write("a", JSON.stringify({ role: "a", dayCostByPair: { "hf/m": 2, bad: "x", neg: -1 } }));
  assert.deepEqual(loadRunnerState(dir, "a").dayCostByPair, { "hf/m": 2 });
  write("b", JSON.stringify({ role: "b", dayCostByPair: "oops" }));
  assert.deepEqual(loadRunnerState(dir, "b").dayCostByPair, {});
  write("c", '{"role":"c","dayCostByPair":{"__proto__":3}}');
  const c = loadRunnerState(dir, "c").dayCostByPair!;
  assert.ok(Object.hasOwn(c, "__proto__"));
  assert.equal(Object.getPrototypeOf(c), Object.prototype);
  assert.equal(loadRunnerState(dir, "fresh").dayCostByPair, undefined, "an absent map stays absent");
});

test("loadRunnerState maps a legacy `ticks` key to `runs`, and the next save writes only `runs`", () => {
  const dir = tmpdir();
  const file = statePath(dir, "qa");
  ensureParentDir(file);
  fs.writeFileSync(file, JSON.stringify({ role: "qa", ticks: 7 })); // retired-name-ok: legacy name
  const s = loadRunnerState(dir, "qa");
  assert.equal(s.runs, 7);
  saveRunnerState(dir, s);
  const onDisk = readJson<Record<string, unknown>>(file);
  assert.equal(onDisk.runs, 7);
  assert.equal("ticks" in onDisk, false); // retired-name-ok: legacy name
});

test("loadRunnerState keeps `runs` and drops `ticks` when a file holds both", () => {
  const dir = tmpdir();
  const file = statePath(dir, "qa");
  ensureParentDir(file);
  fs.writeFileSync(file, JSON.stringify({ role: "qa", ticks: 3, runs: 9 })); // retired-name-ok: legacy name
  const s = loadRunnerState(dir, "qa");
  assert.equal(s.runs, 9);
  assert.equal("ticks" in s, false); // retired-name-ok: legacy name
});

test("loadRunnerState maps the five legacy tick and merge keys, healing each as before", () => {
  const dir = tmpdir();
  const file = statePath(dir, "qa");
  ensureParentDir(file);
  fs.writeFileSync(
    file,
    JSON.stringify({
      role: "qa",
      lastTickStartedAt: 100, // retired-name-ok: legacy name
      lastTickEndedAt: 200, // retired-name-ok: legacy name
      // retired-name-ok:start old state keys
      lastLandedAt: -5, // vocabulary-ok: legacy state key read from old files
      landingReviewError: { sha: "abc", selector: "bad/model", message: "boom" }, // vocabulary-ok: legacy state key read from old files
      landingCheckFailures: 3, // vocabulary-ok: legacy state key read from old files
      // retired-name-ok:end
    }),
  );
  const s = loadRunnerState(dir, "qa");
  assert.equal(s.lastRunStartedAt, 100);
  assert.equal(s.lastRunEndedAt, 200);
  assert.equal(s.lastMergedAt, 0);
  // The pre-merge reviewer-config hold is gone (part 3j/3): the legacy landingReviewError still
  // loads without throwing, and the load drops both it and any recent-name key, so the save
  // below writes neither and no field or reader consumes the value.
  assert.equal(s.mergeCheckFailures, undefined);
  saveRunnerState(dir, s);
  const onDisk = readJson<Record<string, unknown>>(file);
  for (const old of ["lastTickStartedAt", "lastTickEndedAt", "lastLandedAt", "landingReviewError", "landingCheckFailures"]) // retired-name-ok: legacy name
    assert.equal(old in onDisk, false);
  assert.equal(onDisk.lastRunEndedAt, 200);
});

// INV-CN1 (docs/invariants.md "Runner run path: a failed state save never fails the run"): the
// start-of-run state save is best-effort. Relocated here when the model-fallback episode went —
// a failing state write must warn "could not save the role's state" and keep run()'s
// never-throws contract (the run resolves with its own agent result, never an error), and a
// later save still lands.
for (const skip of [0, 1]) {
  test(`an unwritable state file cannot reject a run or turn it into an error (skip ${skip})`, async () => {
    const repo = await initializedRepo();
    const runner = makeRoleRunner(repo, "clean");
    // writeJsonAtomic saves under a per-pid tmp name beside the state file; make that tmp write
    // throw from the `skip`-th attempt on, so either the start-of-run (skip 0) or the end-of-run
    // (skip 1) save is the one that fails.
    const stateTmp = `${statePath(repo, "clean")}.tmp-`;
    let writes = 0;
    await withIdlePi(async () => {
      const undo = patchFsMethod("writeFileSync", (orig) => (...args) => {
        const file = args[0];
        if (typeof file === "string" && file.startsWith(stateTmp) && writes++ >= skip) {
          throw errnoError("ENOSPC");
        }
        return orig(...args);
      });
      try {
        assert.equal((await runner.run()).result, "no_change");
      } finally {
        undo();
      }
    });
    assert.ok(
      warningMessages(repo).some((m) => m.startsWith("could not save the role's state")),
      "a failed save warns",
    );
  });
}
