import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RunnerPi } from "../src/runner/runner-pi.js";
import { piLogPath, roleNotesPath, sessionDir } from "../src/paths.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { defaultConfig } from "../src/config/config.js";
import { resolverConfig } from "../src/config/config-views.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi, withPi } from "./fakes/fake-pi.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { makeHost, recordingFakePi, runArgs } from "./fixtures/runner-pi-fixtures.js";
import { makeRoleRunner } from "./fixtures/runner-fixtures.js";

// RunnerPi (src/runner/runner-pi.ts) is the pi-invocation plumbing of one role's runner: the shared
// per-runner wiring (role config, session dir, raw log, per-run abort signal) as it reaches
// the role and merge runs, the role notebook an authoring run carries, and the merge
// agent run's shutdown-only signal. Tested through a fake pi on PATH, so real spawning and parsing
// are in the runner. (The shared transient retry is in runner-pi-retry.test.ts; the SUMMARY and
// stage-fix follow-ups in runner-pi-followups.test.ts; the claude backend in
// runner-pi-claude.test.ts.)
test("runRolePi runs a fresh named session and folds one usage into the run", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args);
  try {
    const { runnerPi, usage } = makeHost(root);
    const result = await runnerPi.runRolePi(root, "work the backlog", "tumwater-feature-1-author");
    assert.equal(result.ok, true);
    const line = runArgs(args)[0]!;
    assert.match(line, /-n tumwater-feature-1-author/, "fresh session is named, not resumed");
    assert.ok(!line.includes("--continue"), "a fresh session must not pass --continue");
    assert.ok(line.endsWith("work the backlog"), "the prompt reaches pi (stdin, appended last by the fake)");
    assert.equal(usage.length, 1, "one agent run, one foldUsage");
    assert.equal(usage[0], result, "the foldUsage'd agent run IS the returned agent run");
  } finally {
    restore();
  }
});

test("runRolePi demuxes as author and runMergePi as gate (marker kind, not cwd)", async () => {
  const root = tmpdir();
  await withPi(`printf '%s\n' '${assistantLine("done", { tokens: 1 })}'`, async () => {
    const { runnerPi } = makeHost(root);
    // The refusal-note merge's resolver runs in the ROLE worktree via runRolePi; the shared
    // merger's resolver runs via runMergePi. Their markers must name author and gate
    // respectively, since after worktree-pool parts 2/5 and 4/5 the cwd can no longer tell.
    await runnerPi.runRolePi(root, "resolve the conflict", "tumwater-feature-1-conflict");
    const roleLines = fs.readFileSync(piLogPath(root, "feature"), "utf8").replace(/,"ts":\d+/g, "").split("\n");
    assert.equal(roleLines[0], JSON.stringify({ type: "tumwater_run", kind: "author", agent: "pi" }));
    await runnerPi.runMergePi(root, "resolve the conflict", "tumwater-feature-1-conflict");
    const all = fs.readFileSync(piLogPath(root, "feature"), "utf8").replace(/,"ts":\d+/g, "").split("\n");
    assert.ok(
      all.includes(JSON.stringify({ type: "tumwater_run", kind: "gate", agent: "pi" })),
      "runMergePi's agent run writes a gate marker",
    );
  });
});

test("runRolePi with resume passes --continue so a shutdown-interrupted run resumes its session", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args);
  try {
    const { runnerPi } = makeHost(root);
    const result = await runnerPi.runRolePi(root, "keep working", "tumwater-feature-2-author", true);
    assert.equal(result.ok, true);
    const line = runArgs(args)[0]!;
    assert.ok(line.includes("--continue"), "resume continues the role's session");
    assert.ok(!line.includes('-n '), "no -n when resuming");
  } finally {
    restore();
  }
});

// The role notebook (PLANS.md "Role notebook"): runAuthoringPi is the ONE path that exports
// TUMWATER_NOTES_PATH to the child. Every other agent run must leave it unset — a review, merge, or
// conflict-resolution run is not the role's recurring search and must not rewrite the note —
// and the director has no notebook at all.
function envRecordingFakePi(envFile: string): () => void {
  return fakePi(`printf '%s\\n' "$TUMWATER_NOTES_PATH" >> "${envFile}"`);
}

function lastEnvLine(envFile: string): string {
  return fs.readFileSync(envFile, "utf8").trimEnd().split("\n").pop()!;
}

test("runAuthoringPi exports the role's notebook path to the child", async () => {
  const root = tmpdir();
  const env = path.join(root, "env");
  const restore = envRecordingFakePi(env);
  try {
    const { runnerPi } = makeHost(root);
    const result = await runnerPi.runAuthoringPi(root, "work", "tumwater-feature-1-author");
    assert.equal(result.ok, true);
    assert.equal(lastEnvLine(env), roleNotesPath(root, "feature"));
  } finally {
    restore();
  }
});

test("the director's authoring run carries no notebook", async () => {
  const root = tmpdir();
  const env = path.join(root, "env");
  const restore = envRecordingFakePi(env);
  try {
    const { runnerPi } = makeHost(root, defaultConfig(), DIRECTOR_ROLE);
    await runnerPi.runAuthoringPi(root, "route the prompt", "tumwater-director-1");
    assert.equal(lastEnvLine(env), "", "no TUMWATER_NOTES_PATH for the director");
  } finally {
    restore();
  }
});

test("conflict, merge, and review runs carry no notebook", async () => {
  const root = tmpdir();
  const env = path.join(root, "env");
  const restore = envRecordingFakePi(env);
  try {
    const { runnerPi } = makeHost(root);
    // The merge pipeline's conflict resolver reaches pi through runRolePi
    // (merge-to-main.ts's MergeContext); merge and gate runs have their own entry points.
    await runnerPi.runRolePi(root, "resolve the conflict", "tumwater-feature-1-conflict");
    await runnerPi.runMergePi(root, "resolve the conflict", "tumwater-feature-1-conflict");
    await runnerPi.runGatePi({
      cwd: root,
      kind: "gate",
      prompt: "review the change",
      config: defaultConfig(),
      sessionDir: sessionDir(root, "feature"),
      sessionName: "tumwater-review-feature-1",
      rawLogFile: path.join(root, "log.jsonl"),
      nativeLogFile: path.join(root, "native.jsonl"),
      label: "review",
    });
    // One empty env line per agent run: the variable exists in neither child's environment.
    assert.equal(fs.readFileSync(env, "utf8"), "\n\n\n", "none of the three agent runs exports a notebook path");
  } finally {
    restore();
  }
});

// The conflict resolver rides the strong tier (plans/model-tiers.md part 4/8): runRolePi's
// explicit config replaces the role's own for that one agent run, and the argv shows it. With only
// `default` declared the resolver's argv is unchanged from the un-tiered wiring.
test("runRolePi's explicit config replaces the role's config in that agent run's argv", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args);
  try {
    const { runnerPi } = makeHost(root, {
      ...defaultConfig(),
      model: { default: "prov/default", strong: "prov/strong" },
    });
    await runnerPi.runRolePi(root, "author the change", "tumwater-feature-3-author");
    await runnerPi.runRolePi(
      root,
      "resolve the conflict",
      "tumwater-feature-3-conflict",
      false,
      resolverConfig({ ...defaultConfig(), model: { default: "prov/default", strong: "prov/strong" } }),
    );
    const lines = runArgs(args);
    assert.match(lines[0]!, /--provider prov --model default/, "the authoring run carries default's model");
    assert.match(lines[1]!, /--provider prov --model strong/, "the resolver run carries the strong model's argv");
  } finally {
    restore();
  }
});

test("with only default declared, the resolver's config argv is unchanged from the role's own", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args);
  try {
    const { runnerPi } = makeHost(root, { ...defaultConfig(), model: "prov/only" });
    await runnerPi.runRolePi(root, "author the change", "tumwater-feature-4-author");
    await runnerPi.runRolePi(
      root,
      "resolve the conflict",
      "tumwater-feature-4-conflict",
      false,
      resolverConfig({ ...defaultConfig(), model: "prov/only" }),
    );
    const lines = runArgs(args);
    const selector = (line: string) => (/--provider \S+ --model \S+/.exec(line))?.[0];
    assert.equal(
      selector(lines[1]!),
      selector(lines[0]!),
      "same provider and model argv — only default's model is declared",
    );
  } finally {
    restore();
  }
});

// The merge path's resolver wiring: runMergePi takes the same optional config and must
// forward it to the agent run's argv — the merger lambdas pass the strong tier's config through
// (plans/model-tiers.md part 4/8), and a dropped argument would silently demote the resolver
// to the role's own model.
test("runMergePi's explicit config replaces the role's config in that agent run's argv", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args);
  try {
    const { runnerPi } = makeHost(root, {
      ...defaultConfig(),
      model: { default: "prov/default", strong: "prov/strong" },
    });
    await runnerPi.runMergePi(root, "resolve the conflict", "tumwater-feature-3-conflict");
    await runnerPi.runMergePi(
      root,
      "resolve the conflict",
      "tumwater-feature-3-conflict",
      resolverConfig({ ...defaultConfig(), model: { default: "prov/default", strong: "prov/strong" } }),
    );
    const lines = runArgs(args);
    assert.match(lines[0]!, /--provider prov --model default/, "the unconfigured merge run carries default's model");
    assert.match(lines[1]!, /--provider prov --model strong/, "the resolver run carries the strong model's argv");
  } finally {
    restore();
  }
});

test("runMergePi ignores the run's own runSignal — an aborted run must not abort a queued merge", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args);
  try {
    const { runnerPi, usage, mergeUsage, abortRunSignal } = makeHost(root);
    abortRunSignal(); // the stale per-run controller of a finished (or aborted) run
    const result = await runnerPi.runMergePi(root, "resolve the conflict", "tumwater-feature-review");
    assert.equal(result.ok, true, "the merge runs to completion");
    assert.equal(usage.length, 0, "a merge agent run never folds through the run's authoring fold");
    assert.equal(mergeUsage.length, 1, "it folds through foldMergeUsage instead");
    assert.match(runArgs(args)[0]!, /resolve the conflict/);
  } finally {
    restore();
  }
});

test("runMergePi still honors the harness shutdown signal", async () => {
  const root = tmpdir();
  await withPi(`sleep 30`, async () => {
    // Point the host's shutdown signal at a real controller and fire it mid-run.
    const shutdown = new AbortController();
    const runnerPi = new RunnerPi({
      root,
      role: "feature",
      config: () => defaultConfig(),
      signal: shutdown.signal,
      runSignal: () => new AbortController().signal,
      warn: () => {},
      foldUsage: () => {},
      foldMergeUsage: () => {},
      runNumber: () => 1,
    } as unknown as ConstructorParameters<typeof RunnerPi>[0]);
    const pending = runnerPi.runMergePi(root, "land", "t");
    shutdown.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.aborted, true);
    assert.match(result.errorMessage ?? "", /stopped by tumwater shutdown/);
  });
});

test("makeRoleRunner assembles a full runner that shares its role and state", () => {
  const root = tmpdir();
  const runner = makeRoleRunner(root, "feature");
  assert.equal(runner.role, "feature");
});
