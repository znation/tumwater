import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config/config.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { readEvents } from "../src/events/event-read.js";
import { DAY_MS } from "../src/text/datetime.js";
import {
  GITHUB_ISSUES_STALE_MS,
  githubScanStalled,
  isReopened,
  readGithubIssues,
  writeGithubIssues,
} from "../src/github/github-issues-state.js";
import type { GithubIssueRow, GithubIssuesLedger } from "../src/github/github-issues-state.js";
import {
  BODY_EXCERPT_MAX_CHARS,
  dueForIssueScan,
  isTrustedIssue,
  newIssueScanClock,
  pollGithubIssues,
  scanGithubIssues,
} from "../src/github/issue-scan.js";
import { githubIssuesPath } from "../src/paths.js";
import { nextIssuePrompt } from "../src/github/issue-queue.js";
import { fakeGh } from "./fakes/fake-gh.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** A raw issue as `gh api repos/<repo>/issues` returns it, with defaults a test overrides. */
function issue(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: n,
    title: `Issue ${n}`,
    html_url: `https://github.com/o/r/issues/${n}`,
    body: "",
    updated_at: "2026-11-20T00:00:00Z",
    author_association: "NONE",
    user: { login: "someone" },
    labels: [],
    ...overrides,
  };
}

/** A temp project whose checkout is a git repo with a GitHub remote and the given files committed
 * on main. */
function githubRepo(files: Record<string, string>): { dir: string; config: TumwaterConfig; cleanup: () => void } {
  const dir = tmpdir("gh-issues-");
  const git = (...args: string[]): void => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/o/r.git");
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return {
    dir,
    config: loadConfig(dir),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function readLedgerFile(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(githubIssuesPath(dir), "utf8")) as Record<string, unknown>;
}

test("the first scan is due one minute after the team starts, then not until the next tick", () => {
  const clock = newIssueScanClock(0);
  assert.equal(clock.nextAt, 60_000);
  assert.equal(dueForIssueScan(clock.nextAt, 59_999), false);
  assert.equal(dueForIssueScan(clock.nextAt, 60_000), true);
});

test("a maintainer association or the mirror label makes an issue trusted", () => {
  assert.equal(isTrustedIssue({ authorAssociation: "OWNER", labels: [] }, "collaborators", "tumwater"), true);
  assert.equal(isTrustedIssue({ authorAssociation: "MEMBER", labels: [] }, "collaborators", "tumwater"), true);
  assert.equal(isTrustedIssue({ authorAssociation: "NONE", labels: [] }, "collaborators", "tumwater"), false);
  assert.equal(isTrustedIssue({ authorAssociation: "NONE", labels: ["tumwater"] }, "collaborators", "tumwater"), true);
  assert.equal(isTrustedIssue({ authorAssociation: "NONE", labels: [] }, "anyone", "tumwater"), true);
});

test("a scan records trusted and mirrored issues, skips pull requests, and keeps excerpts for trusted issues only", async () => {
  const { dir, config, cleanup } = githubRepo({
    "BUGS.md": "## Open\n\n### Heap OOM (mirrors GitHub issue #1; filed 2026-11-21)\n",
  });
  try {
    const gh = fakeGh({
      issues: [[
        issue(1, { author_association: "OWNER", body: "fix it" }),
        issue(2, { body: "untrusted text" }),
        issue(3, { labels: [{ name: "tumwater" }] }),
        issue(4, { pull_request: {} }),
      ]],
    });
    const ledger = await scanGithubIssues(dir, config, gh.probe, 1_000);
    assert.ok(ledger);
    assert.equal(ledger.gh, "ok");
    assert.equal(ledger.reason, undefined);
    assert.equal(ledger.repo, "o/r");
    assert.equal(ledger.branch, "main");
    assert.deepEqual(ledger.open.map((row) => row.number), [1, 2, 3]);
    assert.deepEqual(ledger.open.map((row) => [row.trusted, row.mirrored]), [[true, true], [false, false], [true, false]]);
    assert.equal(ledger.open[0]?.bodyExcerpt, "fix it");
    assert.equal("bodyExcerpt" in (ledger.open[1] ?? {}), false);
    assert.deepEqual(ledger.open[2]?.labels, ["tumwater"]);
    assert.deepEqual(readLedgerFile(dir).open, ledger.open);
    assert.equal(readLedgerFile(dir).checkedAt, 1_000);
    assert.deepEqual(gh.calls, [
      ["--version"],
      ["auth", "status", "--hostname", "github.com"],
      ["api", "repos/o/r/issues?state=open&per_page=100&page=1"],
    ]);
  } finally {
    cleanup();
  }
});

test("a missing gh records missing and makes no listing call", async () => {
  const { dir, config, cleanup } = githubRepo({});
  try {
    const gh = fakeGh({ version: false });
    const ledger = await scanGithubIssues(dir, config, gh.probe, 1_000);
    assert.equal(ledger?.gh, "missing");
    assert.deepEqual(gh.calls, [["--version"]]);
  } finally {
    cleanup();
  }
});

test("a logged-out gh keeps the previous open list and records unauthenticated", async () => {
  const { dir, config, cleanup } = githubRepo({});
  try {
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(7)]] }).probe, 1_000);
    const gh = fakeGh({ auth: false });
    const ledger = await scanGithubIssues(dir, config, gh.probe, 2_000);
    assert.equal(ledger?.gh, "unauthenticated");
    assert.deepEqual(ledger?.open.map((row) => row.number), [7]);
    assert.equal(gh.calls.some((args) => args[0] === "api"), false);
  } finally {
    cleanup();
  }
});

test("a failed listing records error with its reason", async () => {
  const { dir, config, cleanup } = githubRepo({});
  try {
    const ledger = await scanGithubIssues(dir, config, fakeGh({ apiFail: true }).probe, 1_000);
    assert.equal(ledger?.gh, "error");
    assert.equal(ledger?.reason, "gh api could not list the issues");
  } finally {
    cleanup();
  }
});

test("the listing stops at five pages, so a repo with 600 issues yields 500", async () => {
  const { dir, config, cleanup } = githubRepo({});
  try {
    const pages = Array.from({ length: 6 }, (_, p) =>
      Array.from({ length: 100 }, (_, i) => issue(p * 100 + i + 1)),
    );
    const gh = fakeGh({ issues: pages });
    const ledger = await scanGithubIssues(dir, config, gh.probe, 1_000);
    assert.equal(ledger?.open.length, 500);
    assert.equal(gh.calls.filter((args) => args[0] === "api").length, 5);
  } finally {
    cleanup();
  }
});

test("a short last page ends the listing and keeps every issue on it", async () => {
  const { dir, config, cleanup } = githubRepo({});
  try {
    const first = Array.from({ length: 100 }, (_, i) => issue(i + 1));
    const second = [issue(101), issue(102), issue(103)];
    const gh = fakeGh({ issues: [first, second] });
    const ledger = await scanGithubIssues(dir, config, gh.probe, 1_000);
    assert.equal(ledger?.open.length, 103);
    assert.equal(gh.calls.filter((args) => args[0] === "api").length, 2);
  } finally {
    cleanup();
  }
});

test("a trusted body is kept to its excerpt cap", async () => {
  const { dir, config, cleanup } = githubRepo({});
  try {
    const gh = fakeGh({ issues: [[issue(1, { author_association: "MEMBER", body: "x".repeat(3_000) })]] });
    const ledger = await scanGithubIssues(dir, config, gh.probe, 1_000);
    assert.equal(ledger?.open[0]?.bodyExcerpt?.length, BODY_EXCERPT_MAX_CHARS);
  } finally {
    cleanup();
  }
});

test("a rewrite keeps the queue records a later part wrote into the ledger", async () => {
  const { dir, config, cleanup } = githubRepo({});
  try {
    fs.mkdirSync(path.dirname(githubIssuesPath(dir)), { recursive: true });
    fs.writeFileSync(
      githubIssuesPath(dir),
      JSON.stringify({ repo: "o/r", branch: "main", checkedAt: 1, gh: "ok", open: [], queued: { "5": { at: 1, updatedAt: "t" } } }),
    );
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(5)]] }).probe, 2_000);
    assert.deepEqual(readLedgerFile(dir).queued, { "5": { at: 1, updatedAt: "t" } });
    assert.equal(readLedgerFile(dir).checkedAt, 2_000);
  } finally {
    cleanup();
  }
});

test("two consecutive outages log one github_issues_unavailable event", async () => {
  const { dir, config, cleanup } = githubRepo({});
  try {
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(1)]] }).probe, 1_000);
    await scanGithubIssues(dir, config, fakeGh({ auth: false }).probe, 2_000);
    await scanGithubIssues(dir, config, fakeGh({ auth: false }).probe, 3_000);
    const events = readEvents(dir).filter((e) => e.type === "github_issues_unavailable");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.gh, "unauthenticated");
  } finally {
    cleanup();
  }
});

test("a disabled feature makes no gh call and writes no ledger", async () => {
  const { dir, config, cleanup } = githubRepo({});
  try {
    const off = { ...config, githubIssues: { ...config.githubIssues, enabled: false } } as TumwaterConfig;
    const gh = fakeGh();
    assert.equal(await scanGithubIssues(dir, off, gh.probe, 1_000), null);
    assert.equal(gh.calls.length, 0);
    assert.equal(fs.existsSync(githubIssuesPath(dir)), false);
  } finally {
    cleanup();
  }
});

test("a project with no GitHub remote makes no gh call", async () => {
  const dir = tmpdir("gh-issues-");
  try {
    const gh = fakeGh();
    assert.equal(await scanGithubIssues(dir, loadConfig(dir), gh.probe, 1_000), null);
    assert.equal(gh.calls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the poll scans once when due, then waits a full interval", async () => {
  const { dir, config, cleanup } = githubRepo({});
  try {
    const gh = fakeGh({ issues: [[issue(1)]] });
    const clock = newIssueScanClock(0);
    await pollGithubIssues(dir, config, clock, () => {}, gh.probe, 59_999);
    assert.equal(gh.calls.length, 0);
    await pollGithubIssues(dir, config, clock, () => {}, gh.probe, 60_000);
    const afterFirst = gh.calls.length;
    assert.equal(afterFirst > 0, true);
    assert.equal(clock.nextAt, 60_000 + 60 * 60_000);
    await pollGithubIssues(dir, config, clock, () => {}, gh.probe, 60_000 + 60 * 60_000 - 1);
    assert.equal(gh.calls.length, afterFirst);
  } finally {
    cleanup();
  }
});

test("a scan keeps a closed issue's row across scans and drops it when the issue is open again", async () => {
  // The closer wrote #7's row into closedRows and took it out of open. A scan that does not report
  // #7 must leave that row (number and title intact); a scan that does report #7 open again moves
  // the issue back to `open`, drops its closed row, and keeps the `closed["7"]` marker so the issue
  // still reads as a reopen and the queue offers it again.
  const { dir, config, cleanup } = githubRepo({});
  try {
    const closedAt = 5_000;
    fs.mkdirSync(path.dirname(githubIssuesPath(dir)), { recursive: true });
    fs.writeFileSync(
      githubIssuesPath(dir),
      JSON.stringify({
        repo: "o/r",
        branch: "main",
        checkedAt: 1_000,
        gh: "ok",
        open: [],
        closedRows: [row7(closedAt)],
        closed: { "7": { at: closedAt, shas: ["abc1234"] } },
      }),
    );
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(8)]] }).probe, 2_000);
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(8)]] }).probe, 3_000);
    let ledger = readGithubIssues(dir)!;
    assert.deepEqual(ledger.open.map((r) => r.number), [8]);
    assert.deepEqual(
      ledger.closedRows?.map((r) => [r.number, r.title]),
      [[7, "Issue 7"]],
      "two scans that never saw #7 leave its closed row intact",
    );

    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(7, { author_association: "OWNER" }), issue(8)]] }).probe, 4_000);
    ledger = readGithubIssues(dir)!;
    assert.deepEqual(ledger.open.map((r) => r.number), [7, 8], "#7 is listed as open again");
    assert.equal(ledger.closedRows?.some((r) => r.number === 7), false, "a closed row for an open issue is gone");
    assert.deepEqual(ledger.closed?.["7"], { at: closedAt, shas: ["abc1234"] }, "the close marker survives the reopen");
    assert.equal(isReopened(ledger, ledger.open.find((r) => r.number === 7)!), true, "the row reads as a reopen");
    // And the queue offers it again, its preamble naming the sha that closed it.
    const picked = nextIssuePrompt(ledger, new Set([7]), [], 4_000);
    assert.equal(picked?.issue, 7, "a reopened issue is offered again");
    assert.match(picked!.text, /it was reopened after tumwater closed it citing abc1234\./);
  } finally {
    cleanup();
  }
});

test("a scan whose gh cannot list keeps the closed rows it already holds", async () => {
  // A failed listing keeps the previous `open`; it must keep `closedRows` too, so a gh outage never
  // silently drops the mirror's record of what it closed.
  const { dir, config, cleanup } = githubRepo({});
  try {
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(7)]] }).probe, 1_000);
    // The closer's state: #7 is out of `open` and its row is in `closedRows`.
    writeGithubIssues(dir, {
      ...(readGithubIssues(dir) as GithubIssuesLedger),
      open: [],
      closedRows: [row7(2_000)],
      closed: { "7": { at: 2_000, shas: ["abc1234"] } },
    });
    const ledger = await scanGithubIssues(dir, config, fakeGh({ auth: false }).probe, 3_000);
    assert.equal(ledger?.gh, "unauthenticated");
    assert.deepEqual(ledger?.closedRows?.map((r) => r.number), [7]);
  } finally {
    cleanup();
  }
});

test("an issue the next listing stops reporting is recorded as closed upstream, not lost", async () => {
  // The mirror only ever asks GitHub for open issues, so an issue someone closes on GitHub simply
  // stops appearing. The scan must keep a trace: the last full row, stamped with the instant of the
  // scan that first missed it, and GitHub's own updatedAt kept.
  const { dir, config, cleanup } = githubRepo({});
  try {
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(7), issue(8)]] }).probe, 1_000);
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(7)]] }).probe, 2_000);
    const ledger = readGithubIssues(dir)!;
    assert.deepEqual(ledger.open.map((r) => r.number), [7], "#8 left the open list");
    assert.deepEqual(
      ledger.upstreamClosed?.map((r) => [r.number, r.closedAt, r.updatedAt, r.title, r.url, r.author]),
      [[8, 2_000, "2026-11-20T00:00:00Z", "Issue 8", "https://github.com/o/r/issues/8", "someone"]],
      "the record is the last full row plus this scan's instant",
    );
    assert.equal(ledger.closedRows, undefined, "an upstream close writes no closed row — tumwater closed nothing");
    assert.deepEqual(readLedgerFile(dir).upstreamClosed, ledger.upstreamClosed, "the record is on disk");
  } finally {
    cleanup();
  }
});

test("losing an issue upstream logs one github_issue_upstream_closed event, and a re-scan logs none", async () => {
  // The ledger record of part 1/2 is only readable through `tumwater issues`; the operator watching
  // `tumwater logs` saw the mirror lose an issue as nothing at all. One event per lost issue — and
  // a row already carried in `upstreamClosed` logs nothing, the way the outage pair logs one event
  // per outage rather than one per scan.
  const { dir, config, cleanup } = githubRepo({});
  try {
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(7), issue(8)]] }).probe, 1_000);
    assert.equal(
      readEvents(dir).filter((e) => e.type === "github_issue_upstream_closed").length,
      0,
      "a first scan loses nothing, so it logs nothing",
    );
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(7)]] }).probe, 2_000);
    const events = readEvents(dir).filter((e) => e.type === "github_issue_upstream_closed");
    assert.equal(events.length, 1, "one event for #8");
    assert.equal(events[0]?.repo, "o/r", "the scanned repo");
    assert.equal(events[0]?.issue, 8, "the lost issue");
    assert.equal(events[0]?.updatedAt, "2026-11-20T00:00:00Z", "GitHub's last word on it, as recorded");
    // The same listing again: #8 already sits in `upstreamClosed`, so the same loss is not
    // announced a second time.
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(7)]] }).probe, 3_000);
    assert.equal(
      readEvents(dir).filter((e) => e.type === "github_issue_upstream_closed").length,
      1,
      "a carried record logs nothing",
    );
  } finally {
    cleanup();
  }
});

test("a listing that stopped at MAX_ISSUE_PAGES records no upstream closes", async () => {
  // A walk out of pages never saw the issue, so it cannot have missed it: recording one would
  // claim a close the scan has no evidence for.
  const { dir, config, cleanup } = githubRepo({});
  try {
    const pages = Array.from({ length: 6 }, (_, p) =>
      Array.from({ length: 100 }, (_, i) => issue(p * 100 + i + 1)),
    );
    await scanGithubIssues(dir, config, fakeGh({ issues: pages }).probe, 1_000);
    assert.equal(readLedgerFile(dir).upstreamClosed, undefined, "the first capped scan records nothing");
    // A capped scan that misses #500 from its pages — five full pages again, one renumbered — still
    // records nothing: it never saw the issue, so it has no evidence of a loss.
    const shrunk = pages.map((page, p) => page.map((_, i) => issue(p * 100 + i + 1 === 500 ? 501 : p * 100 + i + 1)));
    await scanGithubIssues(dir, config, fakeGh({ issues: shrunk }).probe, 2_000);
    const ledger = readGithubIssues(dir)!;
    assert.equal(ledger.open.length, 500, "the capped listing is still five pages");
    assert.equal(ledger.open.some((r) => r.number === 500), false, "#500 is missing from it");
    assert.equal(ledger.upstreamClosed, undefined, "a capped listing records no upstream close");
    assert.equal(
      readEvents(dir).filter((e) => e.type === "github_issue_upstream_closed").length,
      0,
      "and it logs no upstream close either",
    );
  } finally {
    cleanup();
  }
});

test("an upstream close skips an issue tumwater closed, and a reopen clears its record", async () => {
  // Two arms of one helper. First: #7 sits in `closedRows` as well as in the previous `open` (a
  // hand-edited or transient ledger) — the ledger already records why it left, so no upstream
  // row is written for it, and with nothing else lost the ledger keeps no upstream list at all.
  // Then: #8 is
  // recorded upstream and the next listing reports it open again — it moves back to `open`, its
  // record is dropped, and its `closed`/`queued` records survive so it still reads as a reopen.
  const { dir, config, cleanup } = githubRepo({});
  try {
    fs.mkdirSync(path.dirname(githubIssuesPath(dir)), { recursive: true });
    fs.writeFileSync(
      githubIssuesPath(dir),
      JSON.stringify({
        repo: "o/r",
        branch: "main",
        checkedAt: 1_000,
        gh: "ok",
        open: [row7(1_000), row8(1_000)],
        closedRows: [row7(5_000)],
        closed: { "7": { at: 5_000, shas: ["abc1234"] } },
      }),
    );
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(8)]] }).probe, 6_000);
    let ledger = readGithubIssues(dir)!;
    assert.deepEqual(ledger.open.map((r) => r.number), [8], "#7 stays out of open: it is a closed row");
    assert.deepEqual(ledger.closedRows?.map((r) => r.number), [7], "the closed row is kept as it was");
    assert.equal(ledger.upstreamClosed, undefined, "a closed issue leaves no upstream record");

    writeGithubIssues(dir, { ...ledger, open: [], upstreamClosed: [row8(7_000)] });
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(8)]] }).probe, 8_000);
    ledger = readGithubIssues(dir)!;
    assert.deepEqual(ledger.open.map((r) => r.number), [8], "#8 is listed open again");
    assert.equal(ledger.upstreamClosed, undefined, "so its upstream record is dropped");
    assert.deepEqual(ledger.closed?.["7"], { at: 5_000, shas: ["abc1234"] }, "the close marker survives");
    assert.equal(
      isReopened(ledger, ledger.open.find((r) => r.number === 8)!),
      false,
      "#8 was never closed, so it reads as a plain open issue",
    );
  } finally {
    cleanup();
  }
});

test("a reopen of an issue tumwater closed keeps its records and offers it again", async () => {
  // The upstream record must not interfere with the reopen hold: a closed row whose number the
  // listing reports open again moves back to `open`, keeps `closed[<n>]`, and is offered with the
  // reopened preamble — the rule the closedRows reopen filter already keeps.
  const { dir, config, cleanup } = githubRepo({});
  try {
    fs.mkdirSync(path.dirname(githubIssuesPath(dir)), { recursive: true });
    fs.writeFileSync(
      githubIssuesPath(dir),
      JSON.stringify({
        repo: "o/r",
        branch: "main",
        checkedAt: 1_000,
        gh: "ok",
        open: [],
        closedRows: [row8(5_000)],
        upstreamClosed: [row7(5_000)],
        closed: { "8": { at: 5_000, shas: ["def5678"] } },
        queued: { "8": { at: 1_600, updatedAt: "2026-11-20T00:00:00Z" } },
      }),
    );
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(8, { author_association: "OWNER" })]] }).probe, 9_000);
    const ledger = readGithubIssues(dir)!;
    assert.deepEqual(ledger.open.map((r) => r.number), [8], "the reopened issue is listed open");
    assert.equal(ledger.closedRows?.some((r) => r.number === 8), false, "its closed row is gone");
    assert.deepEqual(
      ledger.upstreamClosed?.map((r) => r.number),
      [7],
      "and an unrelated upstream record is kept",
    );
    assert.deepEqual(ledger.queued?.["8"], { at: 1_600, updatedAt: "2026-11-20T00:00:00Z" }, "the 24 h hold survives");
    const picked = nextIssuePrompt(ledger, new Set<number>(), [], 5_000_000_000);
    assert.equal(picked?.issue, 8, "past the hold it is offered again");
    assert.match(picked!.text, /it was reopened after tumwater closed it citing def5678\./);
  } finally {
    cleanup();
  }
});

test("an upstream-close record whose issue the ledger still lists open is never queued or closed again", async () => {
  // The record exists only so the read can name the loss. The queue and the close pass iterate
  // `open`, so a lost issue is neither offered nor closed, and its waitingPush stays owed.
  const { dir, config, cleanup } = githubRepo({});
  try {
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(8, { labels: [{ name: "tumwater" }] })]] }).probe, 1_000);
    writeGithubIssues(dir, {
      ...(readGithubIssues(dir) as GithubIssuesLedger),
      open: [],
      upstreamClosed: [row8(2_000)],
      waitingPush: { "8": ["abc1234"] },
    });
    const ledger = readGithubIssues(dir)!;
    assert.equal(nextIssuePrompt(ledger, new Set<number>(), [], 3_000), null, "a lost issue is not offered");
    assert.deepEqual(ledger.upstreamClosed?.map((r) => r.number), [8], "and the record survives the read");
  } finally {
    cleanup();
  }
});

test("the upstream-close list keeps the 50 newest records, stored ascending", async () => {
  // The same cap the closer puts on closed rows, so no ledger list grows unbounded. All 51 losses
  // share one scan instant, and a tie breaks toward the higher number, so #1 is the oldest cut.
  const { dir, config, cleanup } = githubRepo({});
  try {
    const numbers = Array.from({ length: 51 }, (_, i) => i + 1);
    await scanGithubIssues(dir, config, fakeGh({ issues: [numbers.map((n) => issue(n))] }).probe, 1_000);
    await scanGithubIssues(dir, config, fakeGh({ issues: [[]] }).probe, 2_000);
    const ledger = readGithubIssues(dir)!;
    assert.deepEqual(ledger.upstreamClosed?.map((r) => r.number), numbers.slice(1));
    assert.equal(ledger.upstreamClosed?.[0]?.closedAt, 2_000);
  } finally {
    cleanup();
  }
});

test("a gh outage or a failed listing records no upstream close and keeps the records it holds", async () => {
  // No listing at all means no evidence of a loss: the previous scan's records survive and
  // nothing new is written, exactly as a failed listing keeps `open` and `closedRows`.
  const { dir, config, cleanup } = githubRepo({});
  try {
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(7), issue(8)]] }).probe, 1_000);
    await scanGithubIssues(dir, config, fakeGh({ issues: [[issue(7)]] }).probe, 2_000);
    const held = readGithubIssues(dir)!.upstreamClosed;
    const logged = readEvents(dir).filter((e) => e.type === "github_issue_upstream_closed").length;
    await scanGithubIssues(dir, config, fakeGh({ auth: false }).probe, 3_000);
    const ledger = readGithubIssues(dir)!;
    assert.equal(ledger.gh, "unauthenticated");
    assert.deepEqual(ledger.upstreamClosed, held, "an outage keeps the records");
    await scanGithubIssues(dir, config, fakeGh({ apiFail: true }).probe, 4_000);
    assert.deepEqual(readGithubIssues(dir)!.upstreamClosed, held, "and so does a failed listing");
    assert.equal(
      readEvents(dir).filter((e) => e.type === "github_issue_upstream_closed").length,
      logged,
      "neither logs an upstream close it has no evidence for",
    );
  } finally {
    cleanup();
  }
});

/** An open row as the scan writes it, for the ledger fixtures the scan tests hand-write. */
function row8(checkedAt: number): GithubIssueRow {
  return {
    number: 8,
    title: "Issue 8",
    url: "https://github.com/o/r/issues/8",
    author: "someone",
    trusted: false,
    mirrored: false,
    labels: [],
    updatedAt: new Date(checkedAt).toISOString(),
  };
}

/** A closed row as the closer writes it, for the scan's own tests. */
function row7(at: number): GithubIssueRow {
  return {
    number: 7,
    title: "Issue 7",
    url: "https://github.com/o/r/issues/7",
    author: "someone",
    trusted: true,
    mirrored: true,
    labels: [],
    updatedAt: new Date(at).toISOString(),
  };
}

/** A minimal ledger for the stall predicate, which reads only `checkedAt`. */
function ledgerAt(checkedAt: unknown): GithubIssuesLedger {
  return {
    repo: "o/r",
    branch: "main",
    checkedAt,
    gh: "ok",
    open: [],
  } as unknown as GithubIssuesLedger;
}

test("githubScanStalled is true only past the window, and false for no ledger or a foreign checkedAt", () => {
  const now = 1_764_000_000_000;
  // The boundary is exclusive: exactly the window old is not stalled, one millisecond past is.
  assert.equal(githubScanStalled(ledgerAt(now - GITHUB_ISSUES_STALE_MS), now), false);
  assert.equal(githubScanStalled(ledgerAt(now - GITHUB_ISSUES_STALE_MS + 1), now), false);
  assert.equal(githubScanStalled(ledgerAt(now - GITHUB_ISSUES_STALE_MS - 1), now), true);
  assert.equal(githubScanStalled(ledgerAt(now - 4 * DAY_MS), now), true);
  // Never scanned (or an unreadable file) is not a stall, the way qaCoverageStalled reads an
  // empty ledger.
  assert.equal(githubScanStalled(null, now), false);
  // A hand-edited file's checkedAt reads "not stalled" and never throws.
  assert.equal(githubScanStalled(ledgerAt("1764000000000"), now), false);
  assert.equal(githubScanStalled(ledgerAt(undefined), now), false);
});
