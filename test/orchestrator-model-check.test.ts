// The model check end to end (src/model-check/): a live in-process team with the real probe
// (runModelCheck) against a fake pi that answers the probe with word salad until the test
// "fixes the server". The role waits — no run starts on the broken pair, its row says why, the
// warning quotes the reply — and resumes by itself once a re-check answers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MODEL_CHECK_MARKER, runModelCheck } from "../src/model-check/model-check-probe.js";
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
