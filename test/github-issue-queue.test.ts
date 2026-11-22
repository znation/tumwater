import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config/config.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { readEvents } from "../src/events/event-read.js";
import { nextIssuePrompt } from "../src/github/issue-queue.js";
import { queueOneIssue, resetGithubTargetCache, scanGithubIssues } from "../src/github/issue-scan.js";
import { readGithubIssues, type GithubIssuesLedger, type GithubIssueRow } from "../src/github/github-issues-state.js";
import { DIRECTOR_PROMPT_MAX_CHARS } from "../src/inbox/inbox-submit.js";
import { fakeGh } from "./fakes/fake-gh.js";
import { loggingGit, tmpdir } from "./fixtures/repo-fixtures.js";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function row(n: number, overrides: Partial<GithubIssueRow> = {}): GithubIssueRow {
  return {
    number: n,
    title: `Issue ${n}`,
    url: `https://github.com/o/r/issues/${n}`,
    author: "maintainer",
    trusted: true,
    mirrored: false,
    labels: [],
    updatedAt: "2026-11-20T00:00:00Z",
    ...overrides,
  };
}

function ledgerWith(open: GithubIssueRow[], extra: Partial<GithubIssuesLedger> = {}): GithubIssuesLedger {
  return { repo: "o/r", branch: "main", checkedAt: NOW, gh: "ok", open, ...extra };
}

test("with two trusted unmirrored issues the queue picks only the older, then the second once the first is mirrored and its prompt is gone", () => {
  // Listed newest-first, the order `gh api repos/<repo>/issues` returns, so the pick cannot just
  // take the array's first row.
  const ledger = ledgerWith([row(5), row(2)]);
  // The older one first; it is not mirrored and not blocked, so it is picked.
  const first = nextIssuePrompt(ledger, new Set(), [], NOW);
  assert.equal(first?.issue, 2);
  // While its prompt sits in the director queue, nothing else is offered.
  assert.equal(nextIssuePrompt(ledger, new Set(), ["dir prompt", "GitHub issue #2 on o/r …"], NOW), null);
  // Once the prompt is gone and the first is mirrored, the second is offered.
  assert.equal(nextIssuePrompt({ ...ledger, open: [row(5), row(2, { mirrored: true })] }, new Set([2]), [], NOW)?.issue, 5);
});

test("a queued issue is not re-offered within 24 h, then is offered again; a declined issue waits for its updatedAt; a fixed issue is never offered", () => {
  const base = ledgerWith([row(7)]);
  // Queued 2 h ago: held.
  assert.equal(nextIssuePrompt({ ...base, queued: { "7": { at: NOW - 2 * HOUR, updatedAt: "t" } } }, new Set(), [], NOW), null);
  // Queued 25 h ago: offered again (its prompt is gone).
  const again = nextIssuePrompt({ ...base, queued: { "7": { at: NOW - 25 * HOUR, updatedAt: "t" } } }, new Set(), [], NOW);
  assert.equal(again?.issue, 7);
  // Declined at the current updatedAt: held until GitHub's copy changes.
  assert.equal(nextIssuePrompt({ ...base, declined: { "7": { at: NOW, updatedAt: "2026-11-20T00:00:00Z", reason: "dup" } } }, new Set(), [], NOW), null);
  // Declined at an older updatedAt: a GitHub edit changed it, so it is offered again.
  const edited = nextIssuePrompt({ ...base, declined: { "7": { at: NOW, updatedAt: "2026-11-19T00:00:00Z", reason: "dup" } } }, new Set(), [], NOW);
  assert.equal(edited?.issue, 7);
  // Reported fixed: never offered.
  assert.equal(nextIssuePrompt({ ...base, fixedIn: { "7": { sha: "aaaa", at: NOW } } }, new Set(), [], NOW), null);
});

test("isDeclinedHold is the queue's only decline gate: a decline stamped with a foreign updatedAt never holds", () => {
  // The queue and the status fold share one gate (github-issues-state.ts `isDeclinedHold`), so the
  // banner and the prompt cannot disagree about a declined issue. The comparison is exact string
  // equality, so a decline whose recorded `updatedAt` matches nothing GitHub carries — a
  // hand-edited or foreign-generation ledger — fails open and the issue is offered again.
  const base = ledgerWith([row(7)]);
  assert.equal(
    nextIssuePrompt({ ...base, declined: { "7": { at: NOW, updatedAt: "2026-11-20T00:00:00Z", reason: "dup" } } }, new Set(), [], NOW),
    null,
  );
  assert.equal(
    nextIssuePrompt({ ...base, declined: { "7": { at: NOW, updatedAt: "not a timestamp", reason: "dup" } } }, new Set(), [], NOW)?.issue,
    7,
  );
  // A decline recorded for another issue holds nothing here.
  assert.equal(
    nextIssuePrompt({ ...base, declined: { "8": { at: NOW, updatedAt: "2026-11-20T00:00:00Z", reason: "dup" } } }, new Set(), [], NOW)?.issue,
    7,
  );
});

test("an unsettled run's shortened hold re-offers the issue next interval, and a broken value falls back to 24 h", () => {
  const base = ledgerWith([row(7)]);
  // The hold a director run leaves behind when it never settled the issue: one scan interval.
  // Queued 2 h ago under that hold: offered again, not held to the day.
  const retry = nextIssuePrompt(
    { ...base, queued: { "7": { at: NOW - 2 * HOUR, updatedAt: "t", recheckAfterMs: HOUR } } },
    new Set(),
    [],
    NOW,
  );
  assert.equal(retry?.issue, 7);
  // The same record 5 minutes old is still held: the shortened span is a span, not a free pass.
  assert.equal(
    nextIssuePrompt({ ...base, queued: { "7": { at: NOW - 5 * 60 * 1000, updatedAt: "t", recheckAfterMs: HOUR } } }, new Set(), [], NOW),
    null,
  );
  // A hand-edited record whose span is not a usable number keeps the full 24 h rather than
  // offering the issue on every poll.
  for (const bad of [-1, Number.NaN, "3600000"] as unknown as number[]) {
    assert.equal(
      nextIssuePrompt({ ...base, queued: { "7": { at: NOW - 2 * HOUR, updatedAt: "t", recheckAfterMs: bad } } }, new Set(), [], NOW),
      null,
      `a ${JSON.stringify(bad)} span must not shorten the hold`,
    );
  }
});

test("an untrusted issue's text is never offered", () => {
  const ledger = ledgerWith([row(9, { trusted: false })]);
  assert.equal(nextIssuePrompt(ledger, new Set(), [], NOW), null);
});

test("a reopened issue an closed entry mirrors is treated as unmirrored and re-offered", () => {
  const closedAt = NOW;
  const reopened = ledgerWith([row(10, { updatedAt: "2026-11-22T00:00:00Z" })], {
    closed: { "10": { at: closedAt, shas: ["abc1234"] } },
  });
  // It is in the mirror set (an old entry), but it was reopened after tumwater closed it, so the
  // queue treats it as unmirrored and offers it, with the reopened note in its preamble.
  const picked = nextIssuePrompt(reopened, new Set([10]), [], NOW);
  assert.equal(picked?.issue, 10);
  assert.ok(picked!.text.startsWith("GitHub issue #10 on o/r is open and no backlog entry mirrors it; it was reopened after tumwater closed it citing abc1234."), picked!.text);
});

test("the composed prompt keeps the preamble and the full ask under the prompt cap for a very long body", () => {
  const ledger = ledgerWith([row(11, { bodyExcerpt: "x".repeat(20_000) })]);
  const picked = nextIssuePrompt(ledger, new Set(), [], NOW);
  assert.ok(picked);
  assert.ok(picked.text.length <= DIRECTOR_PROMPT_MAX_CHARS, `prompt is ${picked.text.length} chars`);
  assert.ok(picked.text.startsWith("GitHub issue #11 on o/r is open and no backlog entry mirrors it."), "preamble kept");
  assert.ok(picked.text.endsWith("Never close or comment on the issue: tumwater closes it when the fix reaches GitHub."), "full ask kept");
});

/** A temp project whose checkout is a git repo with a GitHub remote and a committed backlog. */
function githubRepo(): { dir: string; config: TumwaterConfig; cleanup: () => void } {
  const dir = tmpdir("gh-queue-");
  const git = (...args: string[]): void => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/o/r.git");
  fs.writeFileSync(path.join(dir, "BUGS.md"), "## Open\n\n");
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return {
    dir,
    config: loadConfig(dir),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function issue(n: number): Record<string, unknown> {
  return {
    number: n,
    title: `Issue ${n}`,
    html_url: `https://github.com/o/r/issues/${n}`,
    body: "",
    updated_at: "2026-11-20T00:00:00Z",
    author_association: "OWNER",
    user: { login: "maintainer" },
    labels: [],
  };
}

test("queueOneIssue scans once, then queues one issue and records it; the next attempt queues nothing", async () => {
  const repo = githubRepo();
  try {
    // GitHub lists the newer issue first, so the ledger's open list is newest-first here too.
    const gh = fakeGh({ issues: [[issue(2), issue(1)]] });
    await scanGithubIssues(repo.dir, repo.config, gh.probe, NOW);
    // Two trusted unmirrored issues; the queue picks the older (#1, the lower number) only.
    const first = await queueOneIssue(repo.dir, repo.config, NOW);
    assert.equal(first?.issue, 1);
    const events = readEvents(repo.dir).filter((e) => e.type === "github_issue_queued");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.issue, 1);
    const ledger = readGithubIssues(repo.dir)!;
    assert.deepEqual(ledger.queued, { "1": { at: NOW, updatedAt: "2026-11-20T00:00:00Z" } });
    // Its prompt still sits in the director queue, so nothing else queues now.
    assert.equal(await queueOneIssue(repo.dir, repo.config, NOW + HOUR), null);
    assert.equal(readEvents(repo.dir).filter((e) => e.type === "github_issue_queued").length, 1);
  } finally {
    repo.cleanup();
  }
});

/** How many `git config --get` a logging-git log names. */
function configReads(logFile: string): number {
  if (!fs.existsSync(logFile)) return 0;
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.includes("config --get")).length;
}

test("the queue's GitHub target is resolved once per throttle window: a repeat call in the window spawns no git config, and a later call re-reads it", async () => {
  const repo = githubRepo();
  resetGithubTargetCache();
  const logFile = path.join(tmpdir("gh-target-log-"), "git.log");
  const restore = loggingGit(logFile);
  try {
    const first = await queueOneIssue(repo.dir, repo.config, NOW);
    assert.equal(first, null, "an empty ledger queues nothing");
    const readsAfterFirst = configReads(logFile);
    assert.ok(readsAfterFirst > 0, "the first queue step reads the target from git config");

    // A later poll inside the window: same answer, no new git config spawns.
    const second = await queueOneIssue(repo.dir, repo.config, NOW + 30_000);
    assert.equal(second, null);
    assert.equal(configReads(logFile), readsAfterFirst, "a poll inside the window spawns no git config");

    // Past the window the target is re-read from git.
    await queueOneIssue(repo.dir, repo.config, NOW + 61_000);
    assert.ok(configReads(logFile) > readsAfterFirst, "past the window the target is re-read");
  } finally {
    restore();
    resetGithubTargetCache();
    repo.cleanup();
  }
});

test("the queue's cached target is handed out as a copy, so mutating a poll's answer cannot poison the next", async () => {
  const repo = githubRepo();
  resetGithubTargetCache();
  try {
    const { githubTargetForPoll } = await import("../src/github/issue-scan.js");
    const first = await githubTargetForPoll(repo.dir, repo.config, NOW);
    assert.deepEqual(first, { repo: "o/r", branch: "main" });
    first!.repo = "someone-else/repo";
    first!.branch = "feature";
    assert.deepEqual(
      await githubTargetForPoll(repo.dir, repo.config, NOW + 1_000),
      { repo: "o/r", branch: "main" },
      "the cached answer is untouched by the caller's edit",
    );
  } finally {
    resetGithubTargetCache();
    repo.cleanup();
  }
});
