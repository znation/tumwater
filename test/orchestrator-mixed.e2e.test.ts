/** The mixed pi + claude team e2e (plans/provider-concurrency.md §9, part 1/4): one
 * orchestrator run whose seams span both backends — a feature author on an omlx pi selector
 * and a claude reviewer on `review.model`. It proves the basic mixed path works end to end: a
 * pi author makes a change, the claude CLI reviews and approves it, and the change merges on
 * main — each backend spawning its own CLI, its own native-log path, and naming its own
 * selector in the run-start events. The harness every later part of the series extends. Like
 * the rest of the tier it waits on real timers and runs via `npm run test:e2e`, not `npm
 * test`. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../src/config/config.js";
import { initProject } from "../src/init/init.js";
import { readEvents } from "../src/events/event-read.js";
import { nativeLogPath } from "../src/paths.js";
import { fastConfig, startLiveOrchestrator, stopOrchestrator } from "./fixtures/orchestrator-fixtures.js";
import { makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { firstRunThenIdle, fakePi, logPromptsTo, readRunBlocks } from "./fakes/fake-pi.js";
import { withClaudeReplay } from "./fakes/fake-claude.js";
import { claudeAssistant, claudeInit, claudeResult, claudeText } from "./fixtures/claude-events.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { waitFor } from "./helpers/wait.js";

test("a pi author and a claude reviewer run in one team and the change merges on main", async () => {
  const repo = makeRepo();
  await initProject(repo, "mixed pi + claude team");
  const cfg = fastConfig(["feature"]);
  cfg.model = "omlx/qwen-mlx"; // the authoring tier runs on pi's omlx provider
  cfg.review = { ...(cfg.review ?? {}), enabled: true, backend: "claude", model: "claude-sonnet-5-5" };
  cfg.maxConcurrent = 2;
  saveConfig(repo, cfg);

  const runDir = tmpdir("mixed-args-");
  const piArgs = path.join(runDir, "pi.runs");
  const marker = path.join(runDir, "authored");
  // The pi author: record its argv (the acceptance's "author run's argv"), make a change once,
  // then idle. Every pi run is the feature author — the reviewer runs on claude (review.model),
  // so the fake pi never sees a VERDICT. The reviewer is therefore the fake-claude replay's job.
  const restorePi = fakePi(
    [
      logPromptsTo(piArgs),
      ...firstRunThenIdle(marker, [
        `echo change >> mixed.txt`,
        `printf '%s\\n' '${assistantLine("mixed author\nSUMMARY: add mixed change")}'`,
      ]),
    ].join("\n"),
  );

  await withClaudeReplay(
    [
      // The claude reviewer: one assistant text turn carrying the approve verdict, then the
      // result. The review gate reads the verdict from the run's final text.
      claudeInit({ sessionId: "c1" }),
      claudeAssistant({ blocks: [claudeText("VERDICT: approve\n1. solid")] }),
      claudeResult({ totalCostUsd: 0 }),
    ],
    async (fake) => {
      const orch = startLiveOrchestrator(repo, 100);
      try {
        await waitFor(
          () =>
            readEvents(repo).some((e) => e.type === "merge_done" && e.source === "feature") &&
            readEvents(repo).some(
              (e) => e.type === "review_verdict" && (e as { afterMerge?: boolean }).afterMerge === true,
            ),
          "the claude-approved change merged on main and its post-landing review approved it",
        );
        // The author's run is in fake pi's argv log, the reviewer's in fake claude's.
        const piRuns = readRunBlocks(piArgs);
        assert.ok(piRuns.some((r) => r.includes("qwen-mlx")), `author argv: ${piRuns.join(" | ")}`);
        const claudeRuns = readRunBlocks(fake.argvFile);
        assert.ok(claudeRuns.length >= 1, `reviewer argv: ${claudeRuns.join("|")}`);
        // Each native log sits at its own role.agent path: pi for the author, claude for the
        // post-landing review of the merged commit.
        assert.ok(fs.existsSync(nativeLogPath(repo, "feature", "pi")), "the author's pi native log");
        assert.ok(fs.existsSync(nativeLogPath(repo, "feature", "claude")), "the reviewer's claude native log");
        // The author's run-start event names its own selector; the reviewer's surviving run is the
        // post-landing review, which judges the already-on-main commit (afterMerge: true). No
        // assertion counts a pre-merge reviewer run — part 3h/3 removes it.
        const run = readEvents(repo).find((e) => e.type === "run_start");
        const postReview = readEvents(repo).find(
          (e) => e.type === "review_start" && (e as { afterMerge?: boolean }).afterMerge === true,
        );
        assert.match(String((run as { model?: string } | undefined)?.model ?? ""), /omlx\/qwen-mlx/);
        assert.ok(postReview, "the post-landing review of the merged change starts");
        // The change is on main.
        const summary = sh(repo, "git", "log", "-1", "--format=%s").trim();
        assert.match(summary, /add mixed change/, `main head: ${summary}`);
      } finally {
        await stopOrchestrator(orch, restorePi);
      }
    },
  );
});
