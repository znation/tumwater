import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { handleIssuesList } from "../src/gui/gui-endpoint-commands.js";
import { githubIssuesPath } from "../src/paths.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { startLocalGui } from "./fixtures/gui-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import { captureJson } from "./fakes/fake-res.js";

// The dashboard's GitHub-issues mirror endpoint (src/gui/gui-issues-commands.ts): the browser
// twin of `tumwater issues`, driven the way test/gui-salvage.test.ts drives the salvage handlers
// — the real read over a ledger written at the path src/github/github-issues-state.ts reads,
// captured through the shared fake request/response, no socket and no `gh` call
// (plans/github-issues.md invariant 2).
//
// Every expected position and count here is derived from the ledger the test wrote, never read
// back from the handler's own output: the two open issues are numbered by ascending issue number
// and the closed row keeps its whole-list position, exactly as issueRows numbers them.

const CHECKED_ISO = "2026-11-20T12:00:00.000Z";
const CHECKED_AT = Date.parse(CHECKED_ISO);
const CLOSE_ISO = "2026-11-19T09:00:00.000Z";
const CLOSE_AT = Date.parse(CLOSE_ISO);

interface Body {
  read?: boolean;
  empty?: boolean;
  repo?: string;
  branch?: string;
  checkedAt?: number;
  gh?: string;
  reason?: string;
  openCount?: number;
  closedCount?: number;
  upstreamClosedCount?: number;
  state?: string;
  issues?: Array<{
    position: number;
    number: number;
    title: string;
    mirrored: boolean;
    trusted: boolean;
    wasClosed?: boolean;
    upstreamClosed?: boolean;
    updatedAt?: string;
  }>;
  error?: string;
}

/** A ledger-shaped row with the fields readGithubIssues' guard requires. */
function row(
  number: number,
  title: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    title,
    url: `https://github.com/znation/proj/issues/${number}`,
    author: "zach",
    trusted: true,
    mirrored: true,
    labels: [],
    updatedAt: CHECKED_ISO,
    ...extra,
  };
}

/** Seed a repo with the mirror ledger the acceptance cases read: open #4 (trusted, mirrored) and
 * #7 (untrusted, not mirrored), plus one row tumwater closed (#2). Returns the repo. */
function seedLedger(repo: string): string {
  writeFileDeep(
    githubIssuesPath(repo),
    JSON.stringify({
      repo: "znation/proj",
      branch: "main",
      checkedAt: CHECKED_AT,
      gh: "ok",
      open: [
        row(4, "Fourth"),
        row(7, "Seventh", { trusted: false, mirrored: false }),
      ],
      closedRows: [row(2, "Second", { updatedAt: CLOSE_ISO })],
      closed: { "2": { at: CLOSE_AT, shas: ["abc1234"] } },
    }),
  );
  return repo;
}

async function list(query: string, root: string): Promise<Body> {
  const q = new URLSearchParams(query.replace(/^\?/, ""));
  const { data } = await captureJson((res) => handleIssuesList(q, res, root));
  return data as Body;
}

test("GET /api/issues answers the whole mirror with its ledger counts and ascending positions", async () => {
  const repo = seedLedger(makeRepo());
  const d = await list("", repo);
  assert.equal(d.read, true);
  assert.equal(d.empty, false);
  // repo and branch come only from the ledger, never from a remote resolution of the
  // endpoint's own.
  assert.equal(d.repo, "znation/proj");
  assert.equal(d.branch, "main");
  assert.equal(d.checkedAt, CHECKED_AT);
  assert.equal(d.gh, "ok");
  assert.equal(d.reason, undefined, "an ok gate state carries no reason");
  // A mirror holding no upstream-close record counts none.
  assert.equal(d.upstreamClosedCount, 0);
  // Positions run by ascending issue number inside each list, and the closed row is numbered
  // after the open ones rather than on its own low number — the one numbering the CLI lists by.
  assert.deepEqual(
    d.issues!.map((r) => [r.position, r.number, r.wasClosed === true]),
    [[1, 4, false], [2, 7, false], [3, 2, true]],
  );
  const fourth = d.issues!.find((r) => r.number === 4)!;
  assert.equal(fourth.title, "Fourth");
  assert.equal(fourth.mirrored, true);
  assert.equal(fourth.trusted, true);
  const seventh = d.issues!.find((r) => r.number === 7)!;
  assert.equal(seventh.mirrored, false, "an unmirrored issue reports it");
  assert.equal(seventh.trusted, false, "the untrusted flag reaches the card");
  const closed = d.issues!.find((r) => r.number === 2)!;
  assert.equal(closed.wasClosed, true, "the closed row is marked as closed");
  assert.equal(closed.updatedAt, CLOSE_ISO, "a closed row's age rides the close instant");
  // The whole-mirror counts, not a count of the rows returned: two open, one closed by tumwater.
  assert.equal(d.openCount, 2);
  assert.equal(d.closedCount, 1);
  // No state filter was asked for, so no state is echoed.
  assert.equal(d.state, undefined);
});

test("GET /api/issues with no ledger answers read:false and creates nothing", async () => {
  const repo = makeRepo();
  const d = await list("", repo);
  assert.equal(d.read, false);
  assert.equal(d.empty, true);
  assert.equal(d.openCount, 0);
  assert.equal(d.closedCount, 0);
  assert.equal(d.upstreamClosedCount, 0);
  assert.deepEqual(d.issues, []);
  // The endpoint reports only what the ledger holds: with no ledger it names no remote, and it
  // never writes one the scan has not written.
  assert.equal(d.repo, undefined);
  assert.equal(d.branch, undefined);
  assert.equal(fs.existsSync(githubIssuesPath(repo)), false, "the read never writes the ledger");
});

test("GET /api/issues?state=closed keeps only the closed row and echoes the state, counts unchanged", async () => {
  const repo = seedLedger(makeRepo());
  const d = await list("?state=closed", repo);
  assert.equal(d.state, "closed");
  assert.deepEqual(d.issues!.map((r) => [r.position, r.number]), [[3, 2]]);
  // INV-DE3: the header counts are the ledger's, so a filtered reply still states the whole mirror.
  assert.equal(d.openCount, 2);
  assert.equal(d.closedCount, 1);
  assert.equal(d.read, true);
  assert.equal(d.empty, false);
});

test("GET /api/issues?state=open drops the closed row and keeps the whole-mirror counts", async () => {
  const repo = seedLedger(makeRepo());
  const d = await list("?state=open", repo);
  assert.equal(d.state, "open");
  assert.deepEqual(d.issues!.map((r) => [r.position, r.number]), [[1, 4], [2, 7]]);
  assert.equal(d.openCount, 2);
  assert.equal(d.closedCount, 1);
});

test("GET /api/issues?state=<other> answers 400 with the got-clause and no issues list", async () => {
  const repo = seedLedger(makeRepo());
  const q = new URLSearchParams({ state: "both" });
  const { captured, data } = await captureJson((res) => handleIssuesList(q, res, repo));
  assert.equal(captured.status, 400);
  assert.deepEqual(JSON.parse(captured.body), {
    error: 'state must be open or closed (got "both")',
  });
  assert.equal((data as Body).issues, undefined, "a refused state sends no list at all");
});

test("GET /api/issues?q= keeps the matching rows at their whole-list positions", async () => {
  const repo = seedLedger(makeRepo());
  const d = await list("?q=seven", repo);
  assert.deepEqual(d.issues!.map((r) => [r.position, r.number]), [[2, 7]]);
  assert.equal(d.openCount, 2);
  assert.equal(d.closedCount, 1);
  // A numeric pattern matches the number, the rule grepIssueRows keeps for --grep.
  const byNumber = await list("?q=2", repo);
  assert.deepEqual(byNumber.issues!.map((r) => [r.position, r.number]), [[3, 2]]);
});

test("GET /api/issues?q= and state= together narrow the list and echo the state", async () => {
  const repo = seedLedger(makeRepo());
  const d = await list("?state=closed&q=second", repo);
  assert.equal(d.state, "closed");
  assert.deepEqual(d.issues!.map((r) => r.number), [2]);
  // The pattern alone would keep nothing in the closed list: an open title matches no closed row.
  const none = await list("?state=closed&q=seventh", repo);
  assert.deepEqual(none.issues, []);
  assert.equal(none.state, "closed");
  assert.equal(none.openCount, 2, "an empty filtered frame still counts the whole mirror");
});

test("GET /api/issues reports a not-ok gh gate with its reason", async () => {
  const repo = makeRepo();
  writeFileDeep(
    githubIssuesPath(repo),
    JSON.stringify({
      repo: "znation/proj",
      branch: "main",
      checkedAt: CHECKED_AT,
      gh: "unauthenticated",
      reason: "gh auth status failed",
      open: [],
    }),
  );
  const d = await list("", repo);
  assert.equal(d.read, true);
  assert.equal(d.empty, false, "a scanned mirror with nothing open is not an unread mirror");
  assert.equal(d.gh, "unauthenticated");
  assert.equal(d.reason, "gh auth status failed");
  assert.deepEqual(d.issues, []);
  assert.equal(d.openCount, 0);
  assert.equal(d.closedCount, 0);
});

test("GET /api/issues counts the ledger's upstream-close records without listing them as closes", async () => {
  const repo = makeRepo();
  writeFileDeep(
    githubIssuesPath(repo),
    JSON.stringify({
      repo: "znation/proj",
      branch: "main",
      checkedAt: CHECKED_AT,
      gh: "ok",
      open: [row(4, "Fourth")],
      upstreamClosed: [row(9, "Lost", { closedAt: CLOSE_AT, updatedAt: CLOSE_ISO })],
    }),
  );
  const d = await list("", repo);
  assert.equal(d.closedCount, 0, "an issue GitHub lost is not a close tumwater made");
  assert.equal(d.upstreamClosedCount, 1);
  assert.deepEqual(d.issues!.map((r) => [r.position, r.number, r.upstreamClosed === true]), [
    [1, 4, false],
    [2, 9, true],
  ]);
  // The state filter keeps such a row on the open side: only `wasClosed` marks a closed row.
  const open = await list("?state=open", repo);
  assert.deepEqual(open.issues!.map((r) => r.number), [4, 9]);
});

test("the live server routes GET /api/issues to the mirror read and refuses POST", async () => {
  const repo = seedLedger(tmpdir());
  const { server, base } = await startLocalGui(repo);
  try {
    const res = await fetch(base + "/api/issues");
    assert.equal(res.status, 200);
    const d = (await res.json()) as Body;
    assert.equal(d.read, true);
    assert.equal(d.openCount, 2);
    const bad = await fetch(base + "/api/issues?state=both");
    assert.equal(bad.status, 400);
    const post = await fetch(base + "/api/issues", { method: "POST" });
    assert.equal(post.status, 404, "the mirror read is read-only: no POST route exists");
  } finally {
    server.close();
  }
});
