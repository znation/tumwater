// The model check end to end (src/model-check/): a live in-process team with the real probe
// (runModelCheck) against a fake pi that answers the probe with word salad until the test
// "fixes the server". The role waits — no run starts on the broken pair, its row says why, the
// warning quotes the reply — and resumes by itself once a re-check answers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MODEL_CHECK_MARKER, runModelCheck } from "../src/model-check/model-check-probe.js";
import { readModelCheckPairs } from "../src/model-check/model-check.js";
import { readJsonFile } from "../src/files/json-files.js";
import { modelChecksPath } from "../src/paths.js";
import { readOrchestratorInfo } from "../src/team/team-orchestrator-info.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { readEvents } from "../src/events/event-read.js";
import { FAST_POLL_MS, makeFastRepo, runRepoOrchestrator } from "./fixtures/orchestrator-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { eventsOfType, warningEvents } from "./fixtures/log-fixtures.js";
import { fakePiNoCheck } from "./fakes/fake-pi.js";
import { waitFor, waitForFile } from "./helpers/wait.js";

/** How many probes the fake has answered (one line each in `log`). */
function probes(log: string): number {
  try {
    return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

test("a team holds a role whose pair fails the model check and resumes it once the pair answers", async () => {
  const repo = await makeFastRepo("model check e2e", ["clean"], "local/flint");
  const dir = tmpdir("model-check-e2e-");
  const fixed = path.join(dir, "fixed");
  const ran = path.join(dir, "ran");
  const probeLog = path.join(dir, "probes.log");
  const salad = "the of the and river of the mills of the";
  const restore = fakePiNoCheck(
    [
      `case "$__pi_prompt" in *"${MODEL_CHECK_MARKER}"*)`,
      `  echo probe >> '${probeLog}'`,
      `  if [ -f '${fixed}' ]; then printf '%s\\n' '${assistantLine("Isselmar")}'; else printf '%s\\n' '${assistantLine(salad)}'; fi`,
      `  exit 0;;`,
      `esac`,
      `touch '${ran}'`,
      `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  const controller = new AbortController();
  const done = runRepoOrchestrator(repo, {
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
    modelCheck: (seam, signal) => runModelCheck(repo, seam, signal),
    modelCheckPolicy: { retryMs: 200, maxRetryMs: 200, suspectMinMs: 0 },
  });
  try {
    await waitFor(
      () => warningEvents(readEvents(repo)).some((e) => String(e.message).startsWith("model check failed: local/flint")),
      "the failed check's warning",
    );
    const warning = String(warningEvents(readEvents(repo)).find((e) => String(e.message).startsWith("model check failed"))?.message);
    assert.match(warning, new RegExp(`replied "${salad}" instead of the probe's one-word answer — runs on it wait \\(clean`));
    // Several re-checks later the pair still fails: the role never ran on it, and says why.
    await waitFor(() => probes(probeLog) >= 3, "re-checks of the failed pair");
    assert.ok(!fs.existsSync(ran), "no role run started on a pair that failed its check");
    assert.equal(eventsOfType(repo, "run_start").length, 0);
    assert.equal(loadRunnerState(repo, "clean").skipReason, "model-check");
    const check = readOrchestratorInfo(repo)?.modelChecks?.find((c) => c.pair === "local/flint");
    assert.deepEqual([check?.status, check?.reason, check?.reply], ["failed", "wrong answer", salad]);
    assert.equal(warningEvents(readEvents(repo)).filter((e) => String(e.message).startsWith("model check failed")).length, 1, "one warning per failure episode");

    // The server is fixed: the next re-check answers and the role runs, with no operator step.
    fs.writeFileSync(fixed, "");
    await waitFor(() => eventsOfType(repo, "model_check_passed").length > 0, "the recovery event");
    await waitForFile(ran);
    assert.equal(readOrchestratorInfo(repo)?.modelChecks?.find((c) => c.pair === "local/flint")?.status, "verified");
  } finally {
    controller.abort();
    await done.catch(() => {});
    restore();
  }
});

test("a restarted team keeps the verdict store's failed pair and its back-off, and re-probes nothing", async () => {
  // The persisted verdicts (model-check.ts readModelCheckStore / writeModelCheckPairs): the
  // first team fails the pair on a long back-off and stops; the second team over the same repo
  // must hold that role without probing at all, because the recorded back-off is still running,
  // and must publish the stored verdict rather than a fresh `checking` one.
  const repo = await makeFastRepo("model check restart e2e", ["clean"], "local/flint");
  const dir = tmpdir("model-check-restart-e2e-");
  const probeLog = path.join(dir, "probes.log");
  const salad = "the of the and river of the mills of the";
  const restore = fakePiNoCheck(
    [
      `case "$__pi_prompt" in *"${MODEL_CHECK_MARKER}"*)`,
      `  echo probe >> '${probeLog}'`,
      `  printf '%s\\n' '${assistantLine(salad)}'`,
      `  exit 0;;`,
      `esac`,
      `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  // A back-off longer than the round, so the recorded probeAt is still in the future when the
  // second team starts, and a suspicion interval long enough that the store counts as fresh.
  const policy = { retryMs: 60_000, maxRetryMs: 60_000, suspectMinMs: 60_000 };
  const first = new AbortController();
  const firstRound = runRepoOrchestrator(repo, {
    signal: first.signal,
    pollMs: FAST_POLL_MS,
    modelCheck: (seam, signal) => runModelCheck(repo, seam, signal),
    modelCheckPolicy: policy,
  });
  const second = new AbortController();
  let secondRound: Promise<unknown> | null = null;
  try {
    await waitFor(
      () => warningEvents(readEvents(repo)).some((e) => String(e.message).startsWith("model check failed: local/flint")),
      "the first team's failed check",
    );
    await waitFor(
      () => readModelCheckPairs(repo)["local/flint"] !== undefined,
      "the failed verdict on disk",
    );
    const stored = readModelCheckPairs(repo)["local/flint"];
    assert.deepEqual([stored?.status, stored?.failures, stored?.retryMs], ["failed", 1, 60_000], "the failed verdict and its back-off are on disk");
    assert.ok((stored?.probeAt ?? 0) > Date.now(), "the recorded next probe is still ahead");
    const savedAt = readJsonFile<{ savedAt?: unknown }>(modelChecksPath(repo))?.savedAt;
    assert.equal(typeof savedAt, "number");
    const probesAtStop = probes(probeLog);
    assert.equal(probesAtStop, 1, "one probe, then the back-off holds it");

    first.abort();
    await firstRound.catch(() => {});

    // The second team over the same repo, with the same salad-answering fake.
    secondRound = runRepoOrchestrator(repo, {
      signal: second.signal,
      pollMs: FAST_POLL_MS,
      modelCheck: (seam, signal) => runModelCheck(repo, seam, signal),
      modelCheckPolicy: policy,
    });
    // Its first poll republishes the info block with the verdict it read from disk — the
    // positive sign that it polled and seeded from the store (a poll whose map is unchanged
    // writes no store file at all, so the file's stamp is not the signal here).
    await waitFor(
      () => readOrchestratorInfo(repo)?.modelChecks?.some((c) => c.pair === "local/flint" && c.status === "failed") === true,
      "the second team's first poll",
    );
    assert.equal(probes(probeLog), probesAtStop, "no probe while the stored back-off still runs");
    const row = readOrchestratorInfo(repo)?.modelChecks?.find((c) => c.pair === "local/flint");
    assert.deepEqual([row?.status, row?.failures, row?.probeAt], ["failed", 1, stored?.probeAt], "the restarted team publishes the stored verdict");
    assert.equal(typeof row?.savedAt, "number", "the row carries the store's stamp");
    assert.equal(loadRunnerState(repo, "clean").skipReason, "model-check", "the role is held on the stored failure");
    assert.equal(eventsOfType(repo, "run_start").length, 0, "no role ran on the pair while it was held");
  } finally {
    first.abort();
    second.abort();
    await Promise.all([firstRound.catch(() => {}), secondRound?.catch(() => {})]);
    restore();
  }
});
