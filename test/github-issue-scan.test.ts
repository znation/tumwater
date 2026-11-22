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
} from "../src/github/github-issues-state.js";
import type { GithubIssuesLedger } from "../src/github/github-issues-state.js";
import {
  BODY_EXCERPT_MAX_CHARS,
  dueForIssueScan,
  isTrustedIssue,
  newIssueScanClock,
  pollGithubIssues,
  scanGithubIssues,
} from "../src/github/issue-scan.js";
import { githubIssuesPath } from "../src/paths.js";
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
