import test from "node:test";
import assert from "node:assert/strict";
import {
  grepIssueRows,
  issueRowAt,
  issueRows,
  issuesHeader,
  renderIssueDetail,
  renderIssues,
} from "../src/github/github-issues-render.js";
import type { GithubIssuesLedger } from "../src/github/github-issues-state.js";

// The issues render module, unit-level: the arms the CLI test drives end-to-end are not
// re-asserted here; these cover the branches a hand-built ledger reaches more directly — the
// fold of the ledger's optional state maps onto its rows, a row whose timestamp is not a date,
// and the position rule shared by the list and the detail view.

const T = "2026-11-20T12:00:00.000Z";

function ledger(extra: Partial<GithubIssuesLedger> = {}): GithubIssuesLedger {
  return {
    repo: "znation/proj",
    branch: "main",
    checkedAt: Date.parse(T),
    gh: "ok",
    open: [
      {
        number: 10,
        title: "Ten",
        url: "https://github.com/znation/proj/issues/10",
        author: "zach",
        trusted: true,
        mirrored: false,
        labels: ["plan"],
        updatedAt: T,
      },
      {
        number: 2,
        title: "Two",
        url: "https://github.com/znation/proj/issues/2",
        author: "bot",
        trusted: false,
        mirrored: true,
        labels: [],
        updatedAt: "not-a-date",
      },
    ],
    ...extra,
  };
}

test("issueRows numbers the open list ascending by issue number and folds every state map in", () => {
  const rows = issueRows(
    ledger({
      queued: { "2": { at: 1_700_000_000_000, updatedAt: T } },
      declined: { "10": { at: 1_700_000_100_000, updatedAt: T, reason: "already planned" } },
      fixedIn: { "2": { sha: "abc1234", at: 1_700_000_200_000 } },
      closed: { "10": { at: 1_700_000_300_000, shas: ["def5678"] } },
      waitingPush: { "10": ["aaa1111"] },
      retiredOnly: [10],
    }),
  );
  assert.deepEqual(
    rows.map((r) => [r.position, r.number]),
    [
      [1, 2],
      [2, 10],
    ],
    "ascending by number, numbered from 1",
  );
  assert.equal(rows[0]!.queuedAt, 1_700_000_000_000);
  assert.equal(rows[0]!.fixedIn, "abc1234");
  assert.deepEqual(rows[1]!.closed, { at: 1_700_000_300_000, shas: ["def5678"] });
  assert.deepEqual(rows[1]!.waitingPush, ["aaa1111"]);
  assert.equal(rows[1]!.retiredOnly, true);
  assert.equal(rows[1]!.reason, "already planned");
});

test("issueRows omits every state key the ledger does not hold, and an empty waitingPush", () => {
  const rows = issueRows(ledger({ waitingPush: { "2": [] } }));
  for (const r of rows) {
    assert.ok(!("closed" in r) && !("queuedAt" in r) && !("reason" in r) && !("fixedIn" in r) && !("retiredOnly" in r));
  }
  assert.ok(!("waitingPush" in rows[0]!), "a state map holding no shas states nothing");
});

test("the list names a row whose updatedAt is not a date as updated unknown", () => {
  const l = ledger();
  const text = renderIssues(issueRows(l), issuesHeader(l), Date.parse(T));
  assert.match(text, /^1\. #2 — Two — untrusted, mirrored, updated unknown$/m, "a foreign timestamp is stated, not NaN");
});

test("the header states a non-ok gh probe with its reason and drops the reason when gh is ok", () => {
  const ok = ledger();
  assert.ok(!("reason" in issuesHeader(ok)), "an ok probe carries no reason");
  const off = ledger({ gh: "missing", reason: "gh is not installed", open: [] });
  const text = renderIssues(issueRows(off), issuesHeader(off), Date.parse(T));
  assert.equal(text, "github issues — znation/proj (main): 0 open, checked 0s ago\ngh missing: gh is not installed");
});

test("grepIssueRows keeps whole-list positions and issueRowAt addresses the unfiltered list", () => {
  const rows = issueRows(ledger());
  const kept = grepIssueRows(rows, "TEN");
  assert.deepEqual(
    kept.map((r) => [r.position, r.number]),
    [[2, 10]],
    "the kept row keeps the position the full list gives it",
  );
  assert.deepEqual(
    grepIssueRows(rows, "0").map((r) => r.number),
    [10],
    "a numeric pattern matches the issue number as a substring",
  );
  assert.deepEqual(grepIssueRows(rows, "nothing"), []);
  assert.equal(issueRowAt(ledger(), 1)!.number, 2);
  assert.equal(issueRowAt(ledger(), 3), null, "past the end");
  assert.equal(issueRowAt(ledger(), 0), null, "below 1");
});

test("renderIssueDetail names only the states the ledger holds and prints the excerpt verbatim", () => {
  const l = ledger({
    declined: { "10": { at: Date.parse(T), updatedAt: T, reason: "already planned" } },
    open: [
      { ...ledger().open[0]!, bodyExcerpt: "line one\nline two" },
    ],
  });
  const row = issueRowAt(l, 1)!;
  const detail = renderIssueDetail(row, 1, Date.parse(T));
  assert.ok(detail.startsWith("issue 1: #10 — Ten\n"), detail);
  assert.ok(detail.includes("labels: plan"));
  assert.ok(detail.includes("declined 0s ago: already planned"));
  assert.ok(detail.includes("body excerpt:\n    line one\n    line two"), "the excerpt keeps its lines");
  assert.ok(!detail.includes("queued"), "no line for a state the ledger lacks");
  assert.ok(!detail.includes("closed"), "no close line for an issue the ledger never closed");
});
