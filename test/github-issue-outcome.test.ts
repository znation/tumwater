import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readEvents } from "../src/events/event-read.js";
import { recordIssueOutcome, releaseIssueRetryHold } from "../src/github/issue-outcome.js";
import { nextIssuePrompt } from "../src/github/issue-queue.js";
import { ISSUE_RETRY_HOLD_MS, readGithubIssues, writeGithubIssues, type GithubIssuesLedger } from "../src/github/github-issues-state.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

const UPDATED_AT = "2026-11-01T00:00:00Z";

/** A temp git repo on `main` with one commit, and a ledger whose only open issue is #12. */
function repoWithLedger(): { dir: string; git: (...args: string[]) => string; cleanup: () => void } {
  const dir = tmpdir("issue-outcome-");
  const git = (...args: string[]): string => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const ledger: GithubIssuesLedger = {
    repo: "o/r",
    branch: "main",
    checkedAt: 1,
    gh: "ok",
    open: [
      {
        number: 12,
        title: "a bug",
        url: "https://github.com/o/r/issues/12",
        author: "someone",
        trusted: true,
        mirrored: false,
        labels: [],
        updatedAt: UPDATED_AT,
      },
    ],
  };
  writeGithubIssues(dir, ledger);
  return { dir, git, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a decline records the issue's updatedAt and reason, and logs github_issue_declined", async () => {
  const repo = repoWithLedger();
  try {
    await recordIssueOutcome(repo.dir, { issue: 12, declined: "duplicate of #9" }, "main", "director", 1000);
    const ledger = readGithubIssues(repo.dir);
    assert.deepEqual(ledger?.declined, { "12": { at: 1000, updatedAt: UPDATED_AT, reason: "duplicate of #9" } });
    const declined = readEvents(repo.dir).filter((e) => e.type === "github_issue_declined");
    assert.equal(declined.length, 1);
    assert.equal(declined[0]?.issue, 12);
    assert.equal(declined[0]?.reason, "duplicate of #9");
  } finally {
    repo.cleanup();
  }
});

test("a fix named by a commit on the base branch is recorded in fixedIn", async () => {
  const repo = repoWithLedger();
  try {
    const sha = repo.git("rev-parse", "HEAD");
    await recordIssueOutcome(repo.dir, { issue: 12, fixedIn: sha.slice(0, 7) }, "main", "director", 2000);
    assert.deepEqual(readGithubIssues(repo.dir)?.fixedIn, { "12": { sha: sha.slice(0, 7), at: 2000 } });
  } finally {
    repo.cleanup();
  }
});

test("an unsettled director run releases the 24 h hold to one retry interval, and the queue re-offers", () => {
  const repo = repoWithLedger();
  try {
    const now = 10_000;
    // The ledger as the queue left it: issue 12's prompt was queued 3 h ago, and its run has
    // since ended without recording any verdict (BUGS.md 2026-11-22).
    const queued = readGithubIssues(repo.dir)!;
    queued.queued = { "12": { at: now - 3 * 60 * 60 * 1000, updatedAt: UPDATED_AT } };
    writeGithubIssues(repo.dir, queued);
    // Before the release the queue holds it: its `queued` record is younger than 24 h.
    assert.equal(nextIssuePrompt(readGithubIssues(repo.dir)!, new Set(), [], now), null);

    assert.equal(
      releaseIssueRetryHold(repo.dir, `GitHub issue #12 on o/r is open and no backlog entry mirrors it`),
      true,
      "an issue prompt names its issue",
    );

    const shortened = readGithubIssues(repo.dir)!.queued!["12"]!;
    assert.equal(shortened.recheckAfterMs, ISSUE_RETRY_HOLD_MS, "the hold is one scan interval");
    assert.equal(shortened.updatedAt, UPDATED_AT, "the record's other fields survive");
    assert.equal(
      nextIssuePrompt(readGithubIssues(repo.dir)!, new Set(), [], now)?.issue,
      12,
      "the queue offers the issue again now",
    );
  } finally {
    repo.cleanup();
  }
});

test("a non-issue prompt, a missing record, and no ledger all release nothing", () => {
  const repo = repoWithLedger();
  try {
    // A director run on any other request never touched the mirror's hold.
    assert.equal(releaseIssueRetryHold(repo.dir, "Fix the flaky gate"), false);
    // A prompt that only mentions an issue in its body is not one the mirror queued.
    assert.equal(releaseIssueRetryHold(repo.dir, "Look at GitHub issue #12 some more"), false);
    // The issue number must follow the opening phrase immediately.
    assert.equal(releaseIssueRetryHold(repo.dir, "GitHub issue ? on o/r"), false);
    // An issue prompt for an issue with no `queued` record writes nothing.
    assert.equal(releaseIssueRetryHold(repo.dir, "GitHub issue #12 on o/r is open"), false);
    assert.equal(readGithubIssues(repo.dir)!.queued, undefined, "no record was created");
  } finally {
    repo.cleanup();
  }
});

test("a fix naming a commit that is not on the base branch leaves fixedIn unchanged", async () => {
  const repo = repoWithLedger();
  try {
    repo.git("checkout", "-q", "-b", "side");
    fs.writeFileSync(path.join(repo.dir, "side.txt"), "s\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "side work");
    const sideSha = repo.git("rev-parse", "HEAD");
    repo.git("checkout", "-q", "main");
    await recordIssueOutcome(repo.dir, { issue: 12, fixedIn: sideSha }, "main", "director", 3000);
    assert.equal(readGithubIssues(repo.dir)?.fixedIn, undefined);
  } finally {
    repo.cleanup();
  }
});

test("a verdict on an issue that is not open records nothing", async () => {
  const repo = repoWithLedger();
  try {
    await recordIssueOutcome(repo.dir, { issue: 99, declined: "not mine" }, "main", "director", 4000);
    const ledger = readGithubIssues(repo.dir);
    assert.equal(ledger?.declined, undefined);
    assert.equal(readEvents(repo.dir).filter((e) => e.type === "github_issue_declined").length, 0);
  } finally {
    repo.cleanup();
  }
});

test("a verdict with no ledger writes no ledger", async () => {
  const dir = tmpdir("issue-outcome-none-");
  try {
    await recordIssueOutcome(dir, { issue: 12, declined: "x" }, "main", "director", 5000);
    assert.equal(readGithubIssues(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
