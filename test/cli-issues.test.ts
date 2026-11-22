import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { githubIssuesPath } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli, cliWithEnv } from "./helpers/cli-harness.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import { writeScript } from "./fakes/fake-commands.js";
import { teamWorkspaceMessage } from "../src/gates/readiness-gates.js";
import { teamWorkspace } from "./fixtures/repo-fixtures.js";

// The `issues` command: the GitHub-issues mirror read from its ledger file alone, via the CLI —
// an initialized repo, child-process runs, output assertions. Every ledger here is written with
// writeFileDeep at the path src/github/github-issues-state.ts reads, so no test shells out to
// `gh` or calls the scan (plans/github-issues.md invariant 2).

interface IssueRowFixture {
  number: number;
  title: string;
  url?: string;
  author?: string;
  trusted?: boolean;
  mirrored?: boolean;
  labels?: string[];
  updatedAt?: string;
  authorAssociation?: string;
  bodyExcerpt?: string;
}

function issueRow(n: number, title: string, extra: Partial<IssueRowFixture> = {}): IssueRowFixture {
  return {
    number: n,
    title,
    url: `https://github.com/znation/proj/issues/${n}`,
    author: "outsider",
    trusted: false,
    mirrored: false,
    labels: [],
    updatedAt: new Date(Date.UTC(2026, 10, 10, 12, 0, 0)).toISOString(),
    ...extra,
  };
}

function writeLedger(repo: string, ledger: unknown): void {
  writeFileDeep(githubIssuesPath(repo), JSON.stringify(ledger));
}

const REPO_LEDGER = {
  repo: "znation/proj",
  branch: "main",
  checkedAt: Date.parse("2026-11-20T12:00:00.000Z"),
  gh: "ok",
  open: [
    issueRow(7, "Reclaim leaves a stale lock", {
      trusted: true,
      mirrored: true,
      author: "zach",
      authorAssociation: "OWNER",
      labels: ["bug"],
      updatedAt: new Date(Date.UTC(2026, 10, 18, 8, 0, 0)).toISOString(),
    }),
    issueRow(3, "Report totals drift", { updatedAt: new Date(Date.UTC(2026, 10, 1, 8, 0, 0)).toISOString() }),
    issueRow(12, "A quiet request", { mirrored: true }),
  ],
};

async function issuesRepo(name: string): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, name);
  return repo;
}

test("issues prints the not-read line and exits 0 with no ledger file", async () => {
  const repo = await issuesRepo("issues empty test");
  const r = await cli(repo, "issues");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "the GitHub issues mirror has not been read yet");
  assert.ok(!fs.existsSync(githubIssuesPath(repo)), "the read never writes the ledger");
});

test("issues --json with no ledger names read:false and the resolved target, not an error", async () => {
  const repo = await issuesRepo("issues empty json test");
  const r = await cli(repo, "issues", "--json");
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout) as { read: boolean; repo: string | null; branch: string | null };
  assert.equal(doc.read, false);
  // A makeRepo'd project pushes to no GitHub remote, so the mirror has no target to name.
  assert.equal(doc.repo, null);
  assert.equal(doc.branch, null);
  assert.ok(!("issues" in doc), "no issues key when nothing was read");
});

test("issues lists three open issues under a header naming repo and 3 open, numbered ascending", async () => {
  const repo = await issuesRepo("issues list test");
  writeLedger(repo, REPO_LEDGER);
  const r = await cli(repo, "issues");
  assert.equal(r.code, 0);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 4, "header plus one line per row");
  assert.match(
    lines[0]!,
    /^github issues — znation\/proj \(main\): 3 open, checked \d+[smhd] ago$/,
    "the header names the repo, branch, open count and scan age",
  );
  // Ascending by issue number, so position 1 is the lowest number, not the ledger's order.
  assert.match(lines[1]!, /^1\. #3 — Report totals drift — untrusted, not mirrored, updated \d+[smhd] ago$/);
  assert.match(lines[2]!, /^2\. #7 — Reclaim leaves a stale lock — trusted, mirrored, updated \d+[smhd] ago$/);
  assert.match(lines[3]!, /^3\. #12 — A quiet request — untrusted, mirrored, updated \d+[smhd] ago$/);
});

test("issues --json serves the ledger's facts with each row's position", async () => {
  const repo = await issuesRepo("issues json test");
  writeLedger(repo, REPO_LEDGER);
  const r = await cli(repo, "issues", "--json");
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout) as {
    read: boolean;
    repo: string;
    branch: string;
    checkedAt: number;
    gh: string;
    issues: { position: number; number: number; trusted: boolean; mirrored: boolean }[];
  };
  assert.equal(doc.read, true);
  assert.equal(doc.repo, "znation/proj");
  assert.equal(doc.branch, "main");
  assert.equal(doc.checkedAt, REPO_LEDGER.checkedAt);
  assert.equal(doc.gh, "ok");
  assert.ok(!("reason" in doc), "an ok gh probe names no reason");
  assert.deepEqual(
    doc.issues.map((i) => [i.position, i.number, i.trusted, i.mirrored]),
    [
      [1, 3, false, false],
      [2, 7, true, true],
      [3, 12, false, true],
    ],
  );
});

test("issues --show <n> prints the issue the list numbered n, unsquashed, with the body excerpt", async () => {
  const repo = await issuesRepo("issues show test");
  const long = `Reclaim leaves a stale lock across ${"x".repeat(100)} worktrees`;
  writeLedger(repo, {
    ...REPO_LEDGER,
    open: [
      issueRow(7, long, {
        trusted: true,
        mirrored: true,
        author: "zach",
        authorAssociation: "OWNER",
        labels: ["bug", "gated"],
        bodyExcerpt: "the lock file survives\nand the next run refuses",
      }),
    ],
  });
  const list = await cli(repo, "issues");
  assert.ok(!list.stdout.includes(long), "the list squashes the long title");
  const before = fs.readFileSync(githubIssuesPath(repo), "utf8");
  const r = await cli(repo, "issues", "--show", "1");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes(`issue 1: #7 — ${long}`), "detail prints the whole title");
  assert.ok(r.stdout.includes("url: https://github.com/znation/proj/issues/7"));
  assert.ok(r.stdout.includes("author: zach (OWNER)"));
  assert.ok(r.stdout.includes("labels: bug, gated"));
  assert.ok(r.stdout.includes("updated: 2026-11-10T12:00:00.000Z"), "the ISO update time prints");
  assert.ok(r.stdout.includes("body excerpt:"), "a trusted issue's excerpt prints");
  assert.ok(r.stdout.includes("the lock file survives"));
  assert.ok(!r.stdout.includes("declined"), "a plain open issue names no state it lacks");
  assert.ok(!r.stdout.includes("queued"));
  assert.ok(!r.stdout.includes("closed"));
  assert.equal(fs.readFileSync(githubIssuesPath(repo), "utf8"), before, "the ledger is byte-unchanged");
});

test("issues --show <n> names every state the ledger holds for that issue", async () => {
  const repo = await issuesRepo("issues show state test");
  writeLedger(repo, {
    ...REPO_LEDGER,
    open: [issueRow(7, "Reclaim leaves a stale lock", { trusted: true })],
    queued: { "7": { at: Date.parse("2026-11-19T12:00:00.000Z"), updatedAt: "2026-11-18T08:00:00.000Z" } },
    closed: { "7": { at: Date.parse("2026-11-01T12:00:00.000Z"), shas: ["abc1234"] } },
    waitingPush: { "7": ["def5678", "aaa1111"] },
    retiredOnly: [7],
  });
  const r = await cli(repo, "issues", "--show", "1");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /closed \d+[smhd] ago: abc1234/);
  assert.match(r.stdout, /waiting for a push of def5678, aaa1111/);
  assert.match(r.stdout, /queued \d+[smhd] ago/);
  assert.ok(r.stdout.includes("every mirroring entry is retired"));
  const declined = await issuesRepo("issues show declined test");
  writeLedger(declined, {
    ...REPO_LEDGER,
    open: [issueRow(9, "Out of scope", { trusted: true })],
    declined: { "9": { at: Date.parse("2026-11-19T12:00:00.000Z"), updatedAt: "2026-11-18T08:00:00.000Z", reason: "already covered by INV-T5" } },
  });
  const d = await cli(declined, "issues", "--show", "1");
  assert.match(d.stdout, /declined \d+[smhd] ago: already covered by INV-T5/);
});

test("issues --show <n> --json serves the positioned row", async () => {
  const repo = await issuesRepo("issues show json test");
  writeLedger(repo, REPO_LEDGER);
  const r = await cli(repo, "issues", "--show", "2", "--json");
  assert.equal(r.code, 0);
  const row = JSON.parse(r.stdout) as { position: number; number: number; title: string };
  assert.equal(row.position, 2);
  assert.equal(row.number, 7);
  assert.ok(!r.stdout.includes("issue 2:"), "--json prints no header text");
});

test("issues --show <n> past the end fails with the quarantine detail's wording", async () => {
  const repo = await issuesRepo("issues show range test");
  writeLedger(repo, REPO_LEDGER);
  const before = fs.readFileSync(githubIssuesPath(repo), "utf8");
  const r = await cli(repo, "issues", "--show", "4");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("no GitHub issue at position 4 (github issues mirror holds 3 issues) — valid: 1-3"), r.stderr);
  assert.equal(fs.readFileSync(githubIssuesPath(repo), "utf8"), before, "the ledger is byte-unchanged");
  const empty = await issuesRepo("issues show empty test");
  const e = await cli(empty, "issues", "--show", "1");
  assert.equal(e.code, 1, "no ledger degrades to an empty mirror, so position 1 is past the end");
  assert.ok(e.stderr.includes("no GitHub issue at position 1 (github issues mirror holds 0 issues)"), e.stderr);
  assert.ok(!e.stderr.includes("valid: 1-"), "an empty mirror names no range");
});

test("issues --show refuses --grep and a missing, zero or non-integer position", async () => {
  const repo = await issuesRepo("issues show flag test");
  writeLedger(repo, REPO_LEDGER);
  let r = await cli(repo, "issues", "--show", "1", "--grep", "drift");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("--grep"), "the refusal names --grep");
  r = await cli(repo, "issues", "--show");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("--show needs a position number (e.g. `--show 2`)"), "the shared position parse wording");
  r = await cli(repo, "issues", "--show", "0");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("positive integer"), r.stderr);
  r = await cli(repo, "issues", "--show", "abc");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("positive integer"), r.stderr);
});

test("issues --grep keeps whole-list positions so --show addresses the same issue", async () => {
  const repo = await issuesRepo("issues grep test");
  writeLedger(repo, REPO_LEDGER);
  const r = await cli(repo, "issues", "--grep", "DRIFT");
  assert.equal(r.code, 0);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2, "header plus the one kept row");
  assert.match(lines[1]!, /^1\. #3 — Report totals drift/, "a title match keeps its whole-list number");
  const byNumber = await cli(repo, "issues", "--grep", "12");
  const numLines = byNumber.stdout.trimEnd().split("\n");
  assert.equal(numLines[1]!, "3. #12 — A quiet request — untrusted, mirrored, updated 12d ago", "a numeric pattern matches the number and keeps its whole-list position");
  const none = await cli(repo, "issues", "--grep", "nothing-here");
  assert.equal(none.code, 0);
  assert.equal(none.stdout.trim(), 'no GitHub issues match "nothing-here"');
});

test("issues --grep with no value fails with the shared missing-value wording", async () => {
  const repo = await issuesRepo("issues grep novalue test");
  writeLedger(repo, REPO_LEDGER);
  const r = await cli(repo, "issues", "--grep");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("issues --grep needs text (usage: tumwater issues --grep <text>)"), r.stderr);
});

test("issues lists a mirror whose gh probe was not ok and names that state", async () => {
  const repo = await issuesRepo("issues gh state test");
  writeLedger(repo, { ...REPO_LEDGER, gh: "unauthenticated", reason: "gh is not logged in — run gh auth login" });
  const r = await cli(repo, "issues");
  assert.equal(r.code, 0);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines[1], "gh unauthenticated: gh is not logged in — run gh auth login");
  assert.equal(lines.length, 5, "header + state line + three rows: the state line costs no row");
  const missing = await cli(repo, "issues", "--json");
  const doc = JSON.parse(missing.stdout) as { gh: string; reason: string };
  assert.equal(doc.gh, "unauthenticated");
  assert.equal(doc.reason, "gh is not logged in — run gh auth login");
});

test("issues reads the ledger with gh nowhere on PATH — the same list, no scan", async () => {
  const repo = await issuesRepo("issues no gh test");
  writeLedger(repo, REPO_LEDGER);
  const withGh = await cli(repo, "issues");
  assert.equal(withGh.code, 0);
  // A fake gh that would record a scan; with PATH emptied of every directory the real gh could
  // be on, the command must still print the ledger untouched.
  const bin = path.join(repo, ".tumwater", "fake-bin");
  fs.mkdirSync(bin, { recursive: true });
  const calls = path.join(repo, ".tumwater", "gh-calls.log");
  writeScript(path.join(bin, "gh"), `echo "$@" >> '${calls}'`);
  const r = await cliWithEnv(repo, { PATH: bin }, ["issues"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, withGh.stdout, "no gh on PATH changes nothing in the output");
  assert.ok(!fs.existsSync(calls), "the read never invoked gh");
});

test("issues lists the issues tumwater closed after the open ones, under a header counting them", async () => {
  // A ledger whose closedRows holds #9 while #7 and #8 are open: the closed issue is listed last
  // however low its number, its age segment reads `closed <ago>`, and the header names the closed
  // count between the open count and the scan age.
  const repo = await issuesRepo("issues closed rows test");
  const closedAt = Date.parse("2026-11-10T12:00:00.000Z");
  writeLedger(repo, {
    ...REPO_LEDGER,
    open: [issueRow(7, "Reclaim leaves a stale lock"), issueRow(8, "A newer request")],
    closedRows: [issueRow(9, "A closed request", { updatedAt: new Date(closedAt).toISOString() })],
    closed: { "9": { at: closedAt, shas: ["abc1234"] } },
  });
  const r = await cli(repo, "issues");
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 4, "header plus three rows");
  assert.match(lines[0]!, /^github issues — znation\/proj \(main\): 2 open, 1 closed by tumwater, checked \d+[smhd] ago$/);
  assert.match(lines[1]!, /^1\. #7 — Reclaim leaves a stale lock — untrusted, not mirrored, updated \d+[smhd] ago$/);
  assert.match(lines[2]!, /^2\. #8 — A newer request — untrusted, not mirrored, updated \d+[smhd] ago$/);
  assert.match(lines[3]!, /^3\. #9 — A closed request — untrusted, not mirrored, closed \d+[smhd] ago$/, "the closed row is listed last and reads as closed");

  const shown = await cli(repo, "issues", "--show", "3");
  assert.equal(shown.code, 0, shown.stderr);
  assert.ok(shown.stdout.includes("issue 3: #9 — A closed request"), shown.stdout);
  assert.match(shown.stdout, /closed \d+[smhd] ago: abc1234/, "the detail names the close instant and its sha");

  const json = await cli(repo, "issues", "--json");
  assert.equal(json.code, 0, json.stderr);
  const doc = JSON.parse(json.stdout) as { issues: { position: number; number: number; wasClosed?: boolean }[] };
  assert.deepEqual(
    doc.issues.map((i) => [i.position, i.number, i.wasClosed === true]),
    [
      [1, 7, false],
      [2, 8, false],
      [3, 9, true],
    ],
    "--json serves the closed row flagged, past the open ones",
  );

  const grep = await cli(repo, "issues", "--grep", "9");
  assert.equal(grep.code, 0, grep.stderr);
  const grepLines = grep.stdout.trimEnd().split("\n");
  assert.equal(grepLines.length, 2, "header plus the one kept row");
  assert.match(grepLines[1]!, /^3\. #9 — A closed request/, "the kept row keeps its whole-list position");
  assert.match(
    grepLines[0]!,
    /^github issues — znation\/proj \(main\): 2 open, 1 closed by tumwater, checked \d+[smhd] ago$/,
    "a filtered frame restates the ledger's own counts, not its kept rows",
  );
  const none = await cli(repo, "issues", "--grep", "nothing-here");
  assert.equal(none.stdout.trim(), 'no GitHub issues match "nothing-here"');

  // The list holds closed rows too, so a position past its end counts them without calling them
  // open: the refusal says what the list holds, not what GitHub holds.
  const past = await cli(repo, "issues", "--show", "4");
  assert.equal(past.code, 1, past.stdout);
  assert.ok(
    past.stderr.includes("no GitHub issue at position 4 (github issues mirror holds 3 issues) — valid: 1-3"),
    past.stderr,
  );
});

test("issues reads a ledger with no closedRows key, and one whose closedRows holds junk", async () => {
  // A ledger written before closed rows existed has no such key at all: its list and header are
  // exactly what they were. A hand-edited closedRows holding non-rows degrades to no closed rows
  // through the same row guard the open list passes, and never fails the read.
  const repo = await issuesRepo("issues no closedRows key test");
  writeLedger(repo, REPO_LEDGER);
  const before = await cli(repo, "issues");
  assert.equal(before.code, 0, before.stderr);
  assert.match(before.stdout, /^github issues — znation\/proj \(main\): 3 open, checked \d+[smhd] ago$/m, "no closed-count segment when none are on record");

  const junk = await issuesRepo("issues junk closedRows test");
  writeLedger(junk, { ...REPO_LEDGER, closedRows: ["not-a-row", null] });
  const r = await cli(junk, "issues");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, before.stdout, "junk closed rows cost the read nothing but themselves");
});

test("issues refuses an unknown flag naming the command and its valid flags", async () => {
  const repo = await issuesRepo("issues unknown flag test");
  writeLedger(repo, REPO_LEDGER);
  const r = await cli(repo, "issues", "--bogus");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("unknown argument: --bogus (valid flags for tumwater issues:"), r.stderr);
  assert.ok(r.stderr.includes("--json") && r.stderr.includes("--grep"), "the valid-flag list names what it takes");
});

test("issues run from a role worktree refuses the way quarantine does", async () => {
  const { root, slot } = teamWorkspace();
  for (const args of [["issues"], ["issues", "--show", "1"], ["issues", "--json"]]) {
    const r = await cli(slot, ...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.ok(r.stderr.includes(teamWorkspaceMessage(root)), args.join(" "));
  }
});

test("issues drops a malformed row out of a hand-edited ledger instead of failing", async () => {
  // `readJsonFile` only checks "a plain object", so a hand-edited ledger can hold `null`, a
  // string, a half-written row or a row with a non-string label in its `open` list. Every reader
  // indexes the row straight out of that list, so the read boundary (readGithubIssues) drops what
  // is not a declared row: the mirror keeps the issues it can state.
  const repo = await issuesRepo("issues malformed rows test");
  writeLedger(repo, {
    ...REPO_LEDGER,
    open: [
      issueRow(3, "Report totals drift"),
      null,
      "not a row",
      { number: 9, title: "half a row" },
      { ...issueRow(12, "A quiet request"), labels: ["ok", 7] },
    ],
  });
  const r = await cli(repo, "issues");
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2, "the header plus only the well-formed row");
  assert.match(lines[0]!, /: 1 open, checked \d+[smhd] ago$/);
  assert.match(lines[1]!, /^1\. #3 — Report totals drift/, "positions count only kept rows");
  const shown = await cli(repo, "issues", "--show", "1");
  assert.equal(shown.code, 0, shown.stderr);
  assert.ok(shown.stdout.includes("#3 — Report totals drift"), shown.stdout);
  const past = await cli(repo, "issues", "--show", "2");
  assert.equal(past.code, 1);
  assert.ok(
    past.stderr.includes("github issues mirror holds 1 issue) — valid: 1-1"),
    past.stderr,
  );
});

test("issues reads a ledger whose open list is missing as an empty mirror", async () => {
  const repo = await issuesRepo("issues malformed test");
  writeLedger(repo, { repo: "znation/proj", branch: "main", checkedAt: REPO_LEDGER.checkedAt, gh: "ok" });
  const r = await cli(repo, "issues");
  assert.equal(r.code, 0);
  assert.match(r.stdout.trimEnd(), /^github issues — znation\/proj \(main\): 0 open, checked \d+[smhd] ago$/);
  const e = await cli(repo, "issues", "--show", "1");
  assert.equal(e.code, 1, "a mirror holding nothing has no position 1");
});
