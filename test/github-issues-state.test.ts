import test from "node:test";
import assert from "node:assert/strict";
import {
  countUpstreamClosed,
  githubIssuesSummary,
  githubUpstreamClosedSentence,
} from "../src/github/github-issues-state.js";
import type { GithubIssueRow, GithubIssuesLedger } from "../src/github/github-issues-state.js";

// The mirror's one count source and the one sentence two surfaces render it with (INV-DG2). The
// stall predicate's cases live in test/github-issue-scan.test.ts, beside the scan that writes the
// ledger; this file pins the fold and the wording alone.

const row = (number: number): GithubIssueRow => ({
  number,
  title: `issue ${number}`,
  url: `https://github.com/acme/widgets/issues/${number}`,
  author: "someone",
  trusted: true,
  mirrored: false,
  labels: [],
  updatedAt: "2026-11-21T00:00:00Z",
});

const ledger = (over: Partial<GithubIssuesLedger> = {}): GithubIssuesLedger => ({
  repo: "acme/widgets",
  branch: "main",
  checkedAt: 1000,
  gh: "ok",
  open: [],
  ...over,
});

test("the summary's upstreamClosed counts the ledger's lost-issue list", () => {
  const lost: GithubIssueRow[] = [{ ...row(7), closedAt: 900 }, { ...row(8), closedAt: 950 }];
  assert.equal(githubIssuesSummary(ledger({ upstreamClosed: lost }), "tumwater").upstreamClosed, 2);
  assert.equal(countUpstreamClosed(ledger({ upstreamClosed: lost })), 2);
});

test("an absent, empty or malformed upstreamClosed list counts 0", () => {
  // The shape every ledger had before the record existed, and the shape a scan leaves when an
  // issue comes back (recordUpstreamCloses deletes the list then).
  for (const upstreamClosed of [undefined, []]) {
    assert.equal(countUpstreamClosed(ledger({ upstreamClosed })), 0);
    assert.equal(githubIssuesSummary(ledger({ upstreamClosed }), "tumwater").upstreamClosed, 0);
  }
  // A hand-edited ledger that names something other than a list is not a count.
  assert.equal(countUpstreamClosed(ledger({ upstreamClosed: "yes" as unknown as GithubIssueRow[] })), 0);
});

test("the upstream-close sentence agrees with its count and names the repo", () => {
  assert.equal(
    githubUpstreamClosedSentence("acme/widgets", 1),
    "1 open issue on acme/widgets was closed upstream with no fix merged by tumwater",
  );
  assert.equal(
    githubUpstreamClosedSentence("acme/widgets", 4),
    "4 open issues on acme/widgets were closed upstream with no fix merged by tumwater",
  );
  // No age clause: a loss says the same thing however fresh or stale the scan is.
  assert.equal(githubUpstreamClosedSentence("acme/widgets", 2).includes("ago"), false);
});
