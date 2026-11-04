import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  recordDismissedFiling,
  recordDismissedFlow,
  recordDismissedRemote,
} from "../src/run/run-dismiss.js";
import { readQaCoverage } from "../src/observer/qa-coverage.js";
import { readFeedbackFilings } from "../src/observer/feedback-filings.js";
import { readRemoteCi } from "../src/observer/remote-ci.js";
import { eventsLogPath, feedbackFilingsPath, qaCoveragePath, remoteCiPath } from "../src/paths.js";
import { failRenameSyncOn } from "./helpers/fs-faults.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** Unit coverage for src/run/run-dismiss.ts — the dismissal-path recorder shared by the two
 * paths that end a run (the changed run's run-stage.ts and the no-change run's run-verdict.ts),
 * so the qa-flow coverage and feedback filing are recorded identically. Its contract:
 * each recorder is bookkeeping that never fails the run — a failed ledger write warns with the
 * same wording on both paths and the caller's outcome stands — and the filing additionally logs
 * an `issue_filed` event. The heavier run-stage/run-verdict suites exercise these through their
 * full contexts; this file pins the two shared recorders on their own. */

function warnSink(): { warns: string[]; ctx: { role: string; warn: (m: string) => void } } {
  const warns: string[] = [];
  return {
    warns,
    ctx: { role: "feedback", warn: (m) => warns.push(m) },
  };
}

test("recordDismissedFlow records a passed flow with no summary and a bug with one", () => {
  const root = tmpdir();
  const sink = warnSink();
  const before = Date.now();
  recordDismissedFlow(sink.ctx, root, "status", "passed", undefined);
  recordDismissedFlow(sink.ctx, root, "run (real)", "bug", "status --json omits the badge");
  assert.deepEqual(sink.warns, []);
  const coverage = readQaCoverage(root);
  const status = coverage.status;
  const runReal = coverage["run (real)"];
  assert.ok(status, "status flow recorded");
  assert.ok(runReal, "run (real) flow recorded");
  assert.deepEqual(coverage, {
    status: { lastRunAt: status.lastRunAt, result: "passed" },
    "run (real)": {
      lastRunAt: runReal.lastRunAt,
      result: "bug",
      summary: "status --json omits the badge",
    },
  });
  assert.ok(status.lastRunAt >= before, "the passed run records a fresh timestamp");
  assert.ok(!("summary" in status), "a passed flow records no summary");
});

test("a failed qa ledger write warns with the shared wording and records nothing", () => {
  const root = tmpdir();
  const sink = warnSink();
  const undo = failRenameSyncOn(qaCoveragePath(root), "EACCES fake");
  try {
    recordDismissedFlow(sink.ctx, root, "status", "passed", undefined);
  } finally {
    undo();
  }
  assert.deepEqual(readQaCoverage(root), {});
  assert.equal(sink.warns.length, 1);
  assert.match(sink.warns[0]!, /qa flow "status" not recorded: EACCES fake/);
});

test("recordDismissedFiling writes the ledger, logs an issue_filed event, and warns nothing", () => {
  const root = tmpdir();
  const sink = warnSink();
  recordDismissedFiling(sink.ctx, root, { issue: 12, title: "a bug" });
  const filings = readFeedbackFilings(root);
  assert.deepEqual(filings, [{ issue: 12, title: "a bug", filedAt: filings[0]!.filedAt }]);
  assert.deepEqual(sink.warns, []);
  // The event reaches the operator's activity feed as an issue_filed line.
  const log = fs.readFileSync(eventsLogPath(root), "utf8");
  const event = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((e) => e.type === "issue_filed");
  assert.ok(event, "recordDismissedFiling logs an issue_filed event");
  assert.deepEqual(
    { source: event.source, issue: event.issue, title: event.title },
    { source: "feedback", issue: 12, title: "a bug" },
  );
});

test("a failed filing ledger write warns with the shared wording and records nothing", () => {
  const root = tmpdir();
  const sink = warnSink();
  const undo = failRenameSyncOn(feedbackFilingsPath(root), "EACCES fake");
  try {
    recordDismissedFiling(sink.ctx, root, { issue: 12, title: "a bug" });
  } finally {
    undo();
  }
  assert.deepEqual(readFeedbackFilings(root), []);
  assert.equal(sink.warns.length, 1);
  assert.match(sink.warns[0]!, /feedback filing #12 not recorded: EACCES fake/);
});

test("recordDismissedRemote writes the ledger with the repo, sha and result", () => {
  const root = tmpdir();
  const sink = warnSink();
  recordDismissedRemote(sink.ctx, root, {
    repo: "znation/tumwater",
    sha: "3e450b0c4",
    result: "failed",
  });
  assert.deepEqual(sink.warns, []);
  const entry = readRemoteCi(root);
  assert.ok(entry);
  assert.equal(entry!.repo, "znation/tumwater");
  assert.equal(entry!.sha, "3e450b0c4");
  assert.equal(entry!.result, "failed");
  assert.ok(entry!.checkedAt > 0, "a fresh checkedAt is recorded");
});

test("recordDismissedRemote rides an unavailable reason and no repo records nothing", () => {
  const root = tmpdir();
  const sink = warnSink();
  recordDismissedRemote(sink.ctx, root, { result: "unavailable", reason: "gh is not logged in" });
  // No repo: the record cannot be attributed, so nothing is written (type honesty, not a live branch).
  assert.equal(readRemoteCi(root), null, "a block-less record writes nothing");
  recordDismissedRemote(sink.ctx, root, {
    repo: "znation/tumwater",
    result: "unavailable",
    reason: "gh is not logged in",
  });
  const entry = readRemoteCi(root);
  assert.ok(entry);
  assert.equal(entry!.result, "unavailable");
  assert.equal(entry!.reason, "gh is not logged in");
  assert.equal(entry!.sha, undefined);
});

test("a failed remote-CI ledger write warns with the shared wording and records nothing", () => {
  const root = tmpdir();
  const sink = warnSink();
  const undo = failRenameSyncOn(remoteCiPath(root), "EACCES fake");
  try {
    recordDismissedRemote(sink.ctx, root, {
      repo: "znation/tumwater",
      sha: "3e450b0c4",
      result: "passed",
    });
  } finally {
    undo();
  }
  assert.equal(readRemoteCi(root), null);
  assert.equal(sink.warns.length, 1);
  assert.match(sink.warns[0]!, /remote CI result not recorded: EACCES fake/);
});
