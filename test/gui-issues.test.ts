import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { handleIssuesList, handleIssuesShow } from "../src/gui/gui-endpoint-commands.js";
import { githubIssuesPath } from "../src/paths.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { startLocalGui } from "./fixtures/gui-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import { captureJson, type Captured } from "./fakes/fake-res.js";

// The dashboard's GitHub-issues mirror endpoints (src/gui/gui-issues-commands.ts): the browser
// twins of `tumwater issues` and `tumwater issues --show <n>`, driven the way
// test/gui-salvage.test.ts drives the salvage handlers
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

interface ShowBody {
  ok?: boolean;
  message?: string;
  error?: string;
  position?: number;
  number?: number;
  title?: string;
  text?: string;
}

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

/** The same mirror plus one upstream-close record, so `?state=lost` has a row of its own to keep:
 * open #4 and #7, the closed row #2, and #6 which a listing came back without. `issueRows` numbers
 * open rows first, then closed, then lost, so #6 is position 4 of the whole list. */
function seedLostLedger(repo: string): string {
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
      upstreamClosed: [row(6, "Sixth", { updatedAt: CLOSE_ISO, closedAt: CLOSE_AT })],
    }),
  );
  return repo;
}

async function list(query: string, root: string): Promise<Body> {
  const q = new URLSearchParams(query.replace(/^\?/, ""));
  const { data } = await captureJson((res) => handleIssuesList(q, res, root));
  return data as Body;
}

async function show(query: string, root: string): Promise<{ captured: Captured; data: ShowBody }> {
  const q = new URLSearchParams(query.replace(/^\?/, ""));
  const { captured, data } = await captureJson((res) => handleIssuesShow(q, res, root));
  return { captured, data: data as ShowBody };
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

test("GET /api/issues?state=lost keeps only the upstream-closed row at its whole-list position", async () => {
  const repo = seedLostLedger(makeRepo());
  const d = await list("?state=lost", repo);
  assert.equal(d.state, "lost");
  // The lost row is numbered after the open and closed rows, exactly as the CLI's --lost does.
  assert.deepEqual(d.issues!.map((r) => [r.position, r.number]), [[4, 6]]);
  assert.equal(d.issues![0]!.upstreamClosed, true, "the kept row is marked as lost upstream");
  // INV-DE3: the counts are the ledger's, so a lost-filtered reply states the whole mirror.
  assert.equal(d.openCount, 2);
  assert.equal(d.closedCount, 1);
  assert.equal(d.upstreamClosedCount, 1);
  assert.equal(d.read, true);
  assert.equal(d.empty, false);
});

test("GET /api/issues?state=lost composes with q= the way the CLI's --lost --grep does", async () => {
  const repo = seedLostLedger(makeRepo());
  // "seven" matches open #7, which the lost filter must drop even though it matches the pattern.
  const d = await list("?state=lost&q=seven", repo);
  assert.equal(d.state, "lost");
  assert.deepEqual(d.issues!.map((r) => [r.position, r.number]), []);
});

test("GET /api/issues?state=<other> answers 400 with the got-clause and no issues list", async () => {
  const repo = seedLedger(makeRepo());
  const q = new URLSearchParams({ state: "both" });
  const { captured, data } = await captureJson((res) => handleIssuesList(q, res, repo));
  assert.equal(captured.status, 400);
  assert.deepEqual(JSON.parse(captured.body), {
    error: 'state must be one of open, closed, lost (got "both")',
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
  // INV-DG1: `stateIssueRows` classifies by `upstreamClosed` first, so the lost row answers
  // neither `state=open` nor `state=closed` — only `--lost` names it, and the endpoint's state
  // query stays the --open/--closed pair (INV-DE6).
  const open = await list("?state=open", repo);
  assert.deepEqual(open.issues!.map((r) => r.number), [4]);
  const closed = await list("?state=closed", repo);
  assert.deepEqual(closed.issues!.map((r) => r.number), []);
});

test("GET /api/issues-show?position=<n> answers that issue's whole detail, closed rows included", async () => {
  const repo = seedLedger(makeRepo());
  const { captured, data } = await show("?position=3", repo);
  assert.equal(captured.status, 200);
  assert.equal(data.ok, undefined, "a hit answers the row, not an ok flag");
  // Position 3 of the whole list is the closed row #2, not an open one — the same numbering the
  // list answers with, so a View click on any listed row reads that row.
  assert.equal(data.position, 3);
  assert.equal(data.number, 2);
  assert.equal(data.title, "Second");
  // The text is renderIssueDetail's output: the header line, the ledger facts, and the close the
  // CLI states — the client renders it verbatim, so no wording is invented browser-side.
  assert.ok(data.text!.startsWith("issue 3: #2 — Second\n"), data.text!);
  assert.match(data.text!, /^  closed \d+[smhd] ago: abc1234$/m, "the CLI's close line reaches the browser");
  assert.match(data.text!, /^  updated: /m);
});

test("GET /api/issues-show carries the body excerpt inside the text, unsquashed", async () => {
  const repo = makeRepo();
  writeFileDeep(
    githubIssuesPath(repo),
    JSON.stringify({
      repo: "znation/proj",
      branch: "main",
      checkedAt: CHECKED_AT,
      gh: "ok",
      open: [row(4, "Fourth", { bodyExcerpt: "the lock file survives\nand the next run refuses" })],
    }),
  );
  const { data } = await show("?position=1", repo);
  assert.ok(data.text!.includes("body excerpt:"), "the excerpt heading is the CLI's");
  assert.ok(
    data.text!.includes("    the lock file survives\n    and the next run refuses"),
    "the excerpt lines keep the CLI's indent and line breaks",
  );
});

test("GET /api/issues-show states every tumwater state line in the CLI's own words", async () => {
  const repo = makeRepo();
  writeFileDeep(
    githubIssuesPath(repo),
    JSON.stringify({
      repo: "znation/proj",
      branch: "main",
      checkedAt: CHECKED_AT,
      gh: "ok",
      open: [
        row(4, "Fourth"),
        row(7, "Seventh"),
        // Position 3: the open row that carries every state the ledger can hold for one issue.
        row(9, "Ninth"),
      ],
      closed: { "9": { at: CLOSE_AT, shas: ["abc1234"] } },
      declined: { "9": { at: CLOSE_AT, updatedAt: CLOSE_ISO, reason: "already covered by INV-T5" } },
      fixedIn: { "9": { sha: "deadbee", at: CLOSE_AT } },
      waitingPush: { "9": ["cafe123"] },
      queued: { "9": { at: CLOSE_AT, updatedAt: CLOSE_ISO } },
      upstreamClosed: [row(6, "Sixth", { updatedAt: CLOSE_ISO, closedAt: CLOSE_AT })],
    }),
  );
  const { data } = await show("?position=3", repo);
  assert.equal(data.position, 3);
  assert.equal(data.number, 9);
  assert.equal(data.title, "Ninth");
  assert.ok(data.text!.startsWith("issue 3: #9 — Ninth\n"), data.text!);
  // Each line is renderIssueDetail's, in its order: a close tumwater made, the decline with its
  // reason, the fix sha, the push wait, the queue age. A paraphrase here would be a second wording.
  assert.match(data.text!, /^  closed \d+[smhd] ago: abc1234$/m);
  assert.match(data.text!, /^  fixed by deadbee$/m);
  assert.match(data.text!, /^  waiting for a push of cafe123$/m);
  assert.match(data.text!, /^  queued \d+[smhd] ago$/m);
  assert.match(data.text!, /^  declined \d+[smhd] ago: already covered by INV-T5$/m);
  // The lost row at position 4 states the loss in its own line, never a close tumwater made.
  const lost = await show("?position=4", repo);
  assert.equal(lost.data.number, 6);
  assert.match(lost.data.text!, /^  closed upstream — last seen open \d+[smhd] ago$/m);
  assert.ok(!/^  closed \d/m.test(lost.data.text!), lost.data.text!);
});

test("GET /api/issues-show past the end answers the CLI's miss sentence, not an empty panel", async () => {
  const repo = seedLedger(makeRepo());
  const { captured, data } = await show("?position=9", repo);
  assert.equal(captured.status, 200, "a miss is a readable answer, the shape the salvage show answers");
  assert.equal(data.ok, false);
  // Three issues in this mirror: two open and one closed. Byte-for-byte the sentence `tumwater
  // issues --show 9` fails with (INV-DE6), so the card can show it unchanged.
  assert.equal(data.message, "no GitHub issue at position 9 (github issues mirror holds 3 issues) — valid: 1-3");
  assert.equal(data.text, undefined, "a miss carries no detail text");
  const far = await show("?position=100", repo);
  assert.equal(far.data.ok, false, "a position well past the end is a miss too");
});

test("GET /api/issues-show of a mirror never read misses without creating a ledger", async () => {
  const repo = makeRepo();
  const { captured, data } = await show("?position=1", repo);
  assert.equal(captured.status, 200);
  assert.equal(data.ok, false);
  assert.equal(data.message, "no GitHub issue at position 1 (github issues mirror holds 0 issues)");
  assert.equal(fs.existsSync(githubIssuesPath(repo)), false, "a detail read never writes the ledger");
});

test("GET /api/issues-show refuses a missing or malformed position with the shared 400 wording", async () => {
  const repo = seedLedger(makeRepo());
  const missing = await show("", repo);
  assert.equal(missing.captured.status, 400);
  assert.deepEqual(JSON.parse(missing.captured.body), { error: "position required" });
  const bad = await show("?position=abc", repo);
  assert.equal(bad.captured.status, 400);
  assert.deepEqual(JSON.parse(bad.captured.body), {
    error: 'position must be a positive integer (got "abc")',
  });
  const zeroQuery = await show("?position=0", repo);
  assert.equal(zeroQuery.captured.status, 400, "position 0 is refused by the shared positive-integer rule, not read as a list position");
  assert.deepEqual(JSON.parse(zeroQuery.captured.body), {
    error: "position must be a positive integer (got \"0\")",
  });
});

test("GET /api/issues-show reads only the ledger: a filtered list never shifts the position", async () => {
  const repo = seedLedger(makeRepo());
  // The card may have fetched ?state=open, which lists only positions 1-2, yet a View click on the
  // closed row still carries position 3 and reads it — one numbering, no filter in the detail read.
  const d = await list("?state=open", repo);
  assert.deepEqual(d.issues!.map((r) => r.position), [1, 2]);
  const { data } = await show("?position=3", repo);
  assert.equal(data.number, 2, "the closed row is addressable at its whole-list position");
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
    // The detail read is routed beside it: the same ledger, the whole-list numbering, and the
    // same read-only stance.
    const shown = await fetch(base + "/api/issues-show?position=3");
    assert.equal(shown.status, 200);
    const s = (await shown.json()) as ShowBody;
    assert.equal(s.number, 2, "GET /api/issues-show is routed to the same detail read");
    assert.ok(s.text!.startsWith("issue 3: #2 — Second\n"), s.text!);
    const miss = await fetch(base + "/api/issues-show?position=9");
    assert.equal(miss.status, 200);
    assert.equal(((await miss.json()) as ShowBody).ok, false);
    const postShow = await fetch(base + "/api/issues-show?position=1", { method: "POST" });
    assert.equal(postShow.status, 404, "the detail read is read-only too: no POST route exists");
  } finally {
    server.close();
  }
});
