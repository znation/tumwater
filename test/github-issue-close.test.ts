import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config/config.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { readEvents } from "../src/events/event-read.js";
import { closeCandidates, closeFixedIssues } from "../src/github/issue-close.js";
import {
  githubCloseForStatus,
  readGithubIssues,
  writeGithubIssues,
  type GithubIssuesLedger,
  type GithubIssueRow,
} from "../src/github/github-issues-state.js";
import { mirrorStates, type MirrorEntry } from "../src/github/issue-mirrors.js";
import { pollGithubIssues } from "../src/github/issue-scan.js";
import { fakeGh } from "./fakes/fake-gh.js";
import { tmpdir, loggingGit } from "./fixtures/repo-fixtures.js";

const NOW = Date.parse("2026-11-21T12:00:00Z");

function row(n: number, overrides: Partial<GithubIssueRow> = {}): GithubIssueRow {
  return {
    number: n,
    title: `Issue ${n}`,
    url: `https://github.com/o/r/issues/${n}`,
    author: "maintainer",
    trusted: true,
    mirrored: true,
    labels: [],
    updatedAt: "2026-11-20T00:00:00Z",
    ...overrides,
  };
}

function ledgerWith(open: GithubIssueRow[], extra: Partial<GithubIssuesLedger> = {}): GithubIssuesLedger {
  return { repo: "o/r", branch: "main", checkedAt: NOW, gh: "ok", open, ...extra };
}

function entry(section: string, retired = false): MirrorEntry {
  return { file: section === "Fixed" ? "BUGS-FIXED.md" : "BUGS.md", section, heading: "Some bug", retired };
}

test("a finished entry that is a real fix closes its issue; a live one does not", () => {
  const ledger = ledgerWith([row(1), row(2)]);
  const mirrors = new Map([
    [1, [entry("Fixed")]],
    [2, [entry("Open")]],
  ]);
  assert.deepEqual(closeCandidates(ledger, mirrors), { close: [1], retiredOnly: [] });
});

test("an issue whose only entries were retired is listed as retired-only, never closed", () => {
  const ledger = ledgerWith([row(3)]);
  const mirrors = new Map([[3, [entry("Done", true)]]]);
  assert.deepEqual(closeCandidates(ledger, mirrors), { close: [], retiredOnly: [3] });
});

test("a Verified-section entry counts as finished: it closes the issue on its own", () => {
  // The close read's promise (docs/steering.md): an issue closes once every entry mirroring it
  // sits in a `## Done`, `## Fixed` or `## Verified` section. The entries here come from the real
  // backlog read, so the section the reader records is the one the verdict branches on.
  const ledger = ledgerWith([row(9)]);
  const mirrors = mirrorStates({
    "BUGS.md": "## Open\n\n## Fixed\n\n## Verified\n\n### Crash (mirrors GitHub issue #9)\n",
  });
  assert.deepEqual(closeCandidates(ledger, mirrors), { close: [9], retiredOnly: [] });
});

test("a retired Verified entry keeps the issue out of the close list, as retired-only", () => {
  const ledger = ledgerWith([row(10)]);
  const mirrors = mirrorStates({
    "BUGS.md": "## Verified\n\n### Crash (mirrors GitHub issue #10; retired 2026-11-02)\n",
  });
  assert.deepEqual(closeCandidates(ledger, mirrors), { close: [], retiredOnly: [10] });
});

test("a Verified entry does not close an issue another entry still answers", () => {
  // One entry verified, its sibling part still live in `## Planned`: not every entry is finished.
  const ledger = ledgerWith([row(11)]);
  const mirrors = mirrorStates({
    "BUGS.md": "## Verified\n\n### Fix (mirrors GitHub issue #11)\n",
    "PLANS.md": "## Planned\n\n### Part 2 (mirrors GitHub issue #11)\n\n## Done\n",
  });
  assert.deepEqual(closeCandidates(ledger, mirrors), { close: [], retiredOnly: [] });
});

test("two parts of one plan: the issue stays open until every part is finished", () => {
  const ledger = ledgerWith([row(4)]);
  const onePart = new Map([[4, [entry("Done"), { ...entry("Planned"), heading: "Part 2" }]]]);
  assert.deepEqual(closeCandidates(ledger, onePart), { close: [], retiredOnly: [] });
  const bothParts = new Map([[4, [entry("Done"), entry("Done")]]]);
  assert.deepEqual(closeCandidates(ledger, bothParts), { close: [4], retiredOnly: [] });
});

test("a reopened issue with a new live entry is not closed again; a newer fix is", () => {
  const closedAt = NOW;
  const reopened = ledgerWith([row(5, { updatedAt: "2026-11-22T00:00:00Z" })], {
    closed: { "5": { at: closedAt, shas: ["aaaa"] } },
  });
  assert.deepEqual(closeCandidates(reopened, new Map([[5, [entry("Open")]]])), { close: [], retiredOnly: [] });
  assert.deepEqual(closeCandidates(reopened, new Map([[5, [entry("Fixed")]]])), { close: [5], retiredOnly: [] });
});

test("an issue closed at or after its current updatedAt is skipped", () => {
  const ledger = ledgerWith([row(6, { updatedAt: "2026-11-20T00:00:00Z" })], {
    closed: { "6": { at: NOW, shas: ["aaaa"] } },
  });
  assert.deepEqual(closeCandidates(ledger, new Map([[6, [entry("Fixed")]]])), { close: [], retiredOnly: [] });
});

test("a director-reported fix closes its issue even with no mirror entry", () => {
  const ledger = ledgerWith([row(7)], { fixedIn: { "7": { sha: "bbbb", at: NOW } } });
  assert.deepEqual(closeCandidates(ledger, new Map()), { close: [7], retiredOnly: [] });
});

test("an unmirrored issue is never a candidate", () => {
  assert.deepEqual(closeCandidates(ledgerWith([row(8)]), new Map()), { close: [], retiredOnly: [] });
});

test("the status figures count waiting fixes and retired-only issues, and are absent when neither holds", () => {
  const dir = tmpdir("gh-close-status-");
  try {
    assert.equal(githubCloseForStatus(dir), undefined, "no ledger yet");
    writeGithubIssues(dir, ledgerWith([], { waitingPush: { "1": ["aaaa"] }, retiredOnly: [3, 4] }));
    assert.deepEqual(githubCloseForStatus(dir), { repo: "o/r", waitingPush: 1, retiredOnly: 2 });
    writeGithubIssues(dir, ledgerWith([]));
    assert.equal(githubCloseForStatus(dir), undefined, "nothing waiting");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A temp project whose checkout is a git repo with a GitHub remote; each commit is a list of
 * [file, text] pairs, the first commit the setup. */
function githubRepo(): { dir: string; config: TumwaterConfig; git: (...args: string[]) => string; cleanup: () => void } {
  const dir = tmpdir("gh-close-");
  const git = (...args: string[]): string => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/o/r.git");
  return {
    dir,
    config: loadConfig(dir),
    git,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function commitFiles(dir: string, git: (...args: string[]) => string, files: Record<string, string>, subject: string): string {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", subject);
  return git("rev-parse", "HEAD");
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

const MIRROR_HEADING = "### Heap OOM after the GUI starts (mirrors GitHub issue #1)";
const FIX_SUBJECT = "tumwater(bugfix): Cap the history read";

test("a fix on main closes the mirrored issue once GitHub has it, citing the fix commit once", async () => {
  const repo = githubRepo();
  try {
    commitFiles(repo.dir, repo.git, { "BUGS.md": `## Open\n\n${MIRROR_HEADING}\n\nBody.\n`, "BUGS-FIXED.md": "## Fixed\n\n" }, "init");
    const fix = commitFiles(
      repo.dir,
      repo.git,
      { "BUGS.md": "## Open\n\n", "BUGS-FIXED.md": `## Fixed\n\n${MIRROR_HEADING}\n\nBody.\n` },
      FIX_SUBJECT,
    );
    const gh = fakeGh({ issues: [[issue(1)]], compare: { [fix]: "ahead" } });
    await pollGithubIssues(repo.dir, repo.config, { nextAt: 0 }, () => {}, gh.probe, NOW);

    const closes = gh.calls.filter((args) => args[0] === "issue");
    assert.equal(closes.length, 1);
    const [, , number, , repoArg, , reason, , comment] = closes[0] ?? [];
    assert.equal(number, "1");
    assert.equal(repoArg, "o/r");
    assert.equal(reason, "completed");
    assert.ok((comment ?? "").includes(`${fix.slice(0, 8)} ("${FIX_SUBJECT}")`), String(comment));
    assert.match(comment ?? "", /mirrored this issue as BUGS\.md entry "Heap OOM after the GUI starts"/);
    assert.equal(readGithubIssues(repo.dir)?.closed?.["1"]?.shas[0], fix);
    const closed = readEvents(repo.dir).filter((event) => event.type === "github_issue_closed");
    assert.equal(closed.length, 1);
    assert.equal(closed[0]?.issue, 1);
  } finally {
    repo.cleanup();
  }
});

test("a fix that is not on GitHub yet waits for the push, then closes when GitHub has it", async () => {
  const repo = githubRepo();
  try {
    commitFiles(repo.dir, repo.git, { "BUGS.md": `## Open\n\n${MIRROR_HEADING}\n\nBody.\n`, "BUGS-FIXED.md": "## Fixed\n\n" }, "init");
    const fix = commitFiles(
      repo.dir,
      repo.git,
      { "BUGS.md": "## Open\n\n", "BUGS-FIXED.md": `## Fixed\n\n${MIRROR_HEADING}\n\nBody.\n` },
      FIX_SUBJECT,
    );
    const compare: Record<string, string> = {};
    const gh = fakeGh({ issues: [[issue(1)]], compare });
    await pollGithubIssues(repo.dir, repo.config, { nextAt: 0 }, () => {}, gh.probe, NOW);
    assert.equal(gh.calls.filter((args) => args[0] === "issue").length, 0, "no close while the fix is unpushed");
    assert.deepEqual(readGithubIssues(repo.dir)?.waitingPush, { "1": [fix] });
    assert.deepEqual(githubCloseForStatus(repo.dir), { repo: "o/r", waitingPush: 1, retiredOnly: 0 });

    compare[fix] = "ahead";
    await pollGithubIssues(repo.dir, repo.config, { nextAt: 0 }, () => {}, gh.probe, NOW + 3_600_000);
    assert.equal(gh.calls.filter((args) => args[0] === "issue").length, 1);
    assert.equal(readGithubIssues(repo.dir)?.waitingPush?.["1"], undefined);
  } finally {
    repo.cleanup();
  }
});

/** A repo whose single commit moved 62 mirror headings into BUGS-FIXED.md, so each of issues 1..62
 * has one finished mirroring entry and that one commit as its fix. */
function sixtyTwoIssueRepo(): { dir: string; config: TumwaterConfig; fix: string; cleanup: () => void } {
  const repo = githubRepo();
  try {
    commitFiles(repo.dir, repo.git, { "BUGS.md": "## Open\n\n", "BUGS-FIXED.md": "## Fixed\n\n" }, "init");
    const headings = Array.from({ length: 62 }, (_, i) => `### Fix number ${i + 1} (mirrors GitHub issue #${i + 1})`).join("\n\n");
    const fix = commitFiles(
      repo.dir,
      repo.git,
      { "BUGS.md": "## Open\n\n", "BUGS-FIXED.md": `## Fixed\n\n${headings}\n` },
      "tumwater(bugfix): Fix sixty-two issues",
    );
    return { dir: repo.dir, config: repo.config, fix, cleanup: repo.cleanup };
  } catch (err) {
    repo.cleanup();
    throw err;
  }
}

test("a close keeps the closed issue's row, and the next pass never closes that issue again", async () => {
  const repo = githubRepo();
  try {
    commitFiles(repo.dir, repo.git, { "BUGS.md": `## Open\n\n${MIRROR_HEADING}\n\nBody.\n`, "BUGS-FIXED.md": "## Fixed\n\n" }, "init");
    const fix = commitFiles(
      repo.dir,
      repo.git,
      { "BUGS.md": "## Open\n\n", "BUGS-FIXED.md": `## Fixed\n\n${MIRROR_HEADING}\n\nBody.\n` },
      FIX_SUBJECT,
    );
    writeGithubIssues(repo.dir, ledgerWith([row(1, { title: "Inbox lock survives", bodyExcerpt: "the lock file survives" })]));
    const gh = fakeGh({ compare: { [fix]: "ahead" } });
    await closeFixedIssues(repo.dir, repo.config, gh.probe, () => {}, NOW);
    const ledger = readGithubIssues(repo.dir)!;
    assert.deepEqual(ledger.closed?.["1"], { at: NOW, shas: [fix] }, "the close marker is what it always was");
    assert.deepEqual(ledger.open, [], "the row left the open list");
    assert.equal(ledger.closedRows?.length, 1);
    const kept = ledger.closedRows?.[0]!;
    assert.equal(kept.number, 1);
    assert.equal(kept.title, "Inbox lock survives", "the row is the one the closer replaced");
    assert.equal(kept.url, "https://github.com/o/r/issues/1");
    assert.equal(kept.author, "maintainer");
    assert.equal(kept.bodyExcerpt, "the lock file survives", "--show can still print why the issue existed");
    assert.equal(kept.updatedAt, new Date(NOW).toISOString(), "its age segment reads the close instant");
    // The closer's next pass reads the ledger it just wrote: #1 is in neither list as a candidate,
    // so `gh issue close` runs no second time.
    await closeFixedIssues(repo.dir, repo.config, gh.probe, () => {}, NOW + 3_600_000);
    assert.equal(gh.calls.filter((args) => args[0] === "issue").length, 1, "no second close call");
    assert.equal(readGithubIssues(repo.dir)?.closedRows?.length, 1, "and no second row");
  } finally {
    repo.cleanup();
  }
});

test("a pass closing more issues than the closed-row cap keeps the 50 rows of the newest closes", async () => {
  const repo = sixtyTwoIssueRepo();
  try {
    writeGithubIssues(repo.dir, ledgerWith(Array.from({ length: 62 }, (_, i) => row(i + 1))));
    const gh = fakeGh({ compare: { [repo.fix]: "ahead" } });
    await closeFixedIssues(repo.dir, repo.config, gh.probe, () => {}, NOW);
    const ledger = readGithubIssues(repo.dir)!;
    assert.equal(gh.calls.filter((args) => args[0] === "issue").length, 62, "every candidate closed");
    assert.equal(ledger.closedRows?.length, 50, "the ledger never grows past the cap on kept bodies");
    // One pass closes at one instant, so the trim's tie breaks toward the closes it made last:
    // issues 13..62 survive and the ten it closed first are dropped.
    assert.deepEqual(ledger.closedRows?.map((r) => r.number), Array.from({ length: 50 }, (_, i) => i + 13));
    assert.deepEqual(ledger.open, [], "no closed row stayed in the open list");
    // A later pass re-closes one issue GitHub reopened, at a later instant: its row is the newest
    // close, so it evicts the oldest kept row and the ledger still holds exactly the cap.
    const reopened = { ...ledger, open: [row(5, { updatedAt: "2026-11-23T00:00:00Z" })] };
    writeGithubIssues(repo.dir, reopened);
    await closeFixedIssues(repo.dir, repo.config, gh.probe, () => {}, NOW + 3_600_000);
    const after = readGithubIssues(repo.dir)!;
    assert.equal(after.closedRows?.length, 50, "the trim holds at the cap across passes");
    assert.deepEqual(
      after.closedRows?.map((r) => r.number),
      [5, ...Array.from({ length: 49 }, (_, i) => i + 14)],
      "the reopened issue's new row is kept and the oldest kept row (#13) is dropped",
    );
  } finally {
    repo.cleanup();
  }
});

test("githubIssues.close false makes no issue close call", async () => {
  const repo = githubRepo();
  try {
    commitFiles(repo.dir, repo.git, { "BUGS.md": `## Open\n\n${MIRROR_HEADING}\n\nBody.\n`, "BUGS-FIXED.md": "## Fixed\n\n" }, "init");
    const fix = commitFiles(
      repo.dir,
      repo.git,
      { "BUGS.md": "## Open\n\n", "BUGS-FIXED.md": `## Fixed\n\n${MIRROR_HEADING}\n\nBody.\n` },
      FIX_SUBJECT,
    );
    const gh = fakeGh({ issues: [[issue(1)]], compare: { [fix]: "ahead" } });
    const config = { ...repo.config, githubIssues: { close: false } };
    await pollGithubIssues(repo.dir, config, { nextAt: 0 }, () => {}, gh.probe, NOW);
    assert.equal(gh.calls.filter((args) => args[0] === "issue").length, 0);
  } finally {
    repo.cleanup();
  }
});

/** How many `git log --pickaxe-regex` a logging-git log names: the fix-finding archive walk. */
function pickaxeCount(logFile: string): number {
  if (!fs.existsSync(logFile)) return 0;
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.includes("--pickaxe-regex")).length;
}

test("the fix walk runs once per branch tip: passes at an unchanged tip re-walk nothing and still cite the fix", async () => {
  const repo = githubRepo();
  try {
    commitFiles(repo.dir, repo.git, { "BUGS.md": `## Open\n\n${MIRROR_HEADING}\n\nBody.\n`, "BUGS-FIXED.md": "## Fixed\n\n" }, "init");
    const fix = commitFiles(
      repo.dir,
      repo.git,
      { "BUGS.md": "## Open\n\n", "BUGS-FIXED.md": `## Fixed\n\n${MIRROR_HEADING}\n\nBody.\n` },
      FIX_SUBJECT,
    );
    // The fix is unpushed for the first two passes, so the same walk would otherwise run again.
    const compare: Record<string, string> = {};
    const gh = fakeGh({ issues: [[issue(1)]], compare });
    const logFile = path.join(tmpdir("gh-close-walk-log-"), "git.log");
    const restore = loggingGit(logFile);
    try {
      await pollGithubIssues(repo.dir, repo.config, { nextAt: 0 }, () => {}, gh.probe, NOW);
      assert.equal(pickaxeCount(logFile), 1, "the first pass walks the archives once");
      assert.deepEqual(readGithubIssues(repo.dir)?.waitingPush, { "1": [fix] }, "the fix waits for a push");

      // Same tip, second pass: the walk is cached, so nothing is re-diffed.
      await pollGithubIssues(repo.dir, repo.config, { nextAt: 0 }, () => {}, gh.probe, NOW + 3_600_000);
      assert.equal(pickaxeCount(logFile), 1, "a pass at an unchanged tip spawns no second walk");
      assert.equal(gh.calls.filter((args) => args[0] === "issue").length, 0, "still unpushed, still no close");

      // Pushed: the cached walk's commits are cited, byte-for-byte as the uncached walk's would be.
      compare[fix] = "ahead";
      await pollGithubIssues(repo.dir, repo.config, { nextAt: 0 }, () => {}, gh.probe, NOW + 7_200_000);
      assert.equal(pickaxeCount(logFile), 1, "the close pass adds no walk either");
      const closes = gh.calls.filter((args) => args[0] === "issue");
      assert.equal(closes.length, 1, "the issue closes once the fix is on GitHub");
      const comment = closes[0]?.[8] ?? "";
      assert.ok(comment.includes(`${fix.slice(0, 8)} ("${FIX_SUBJECT}")`), String(comment));
    } finally {
      restore();
    }
  } finally {
    repo.cleanup();
  }
});

test("a moved tip re-walks: a fix commit the cached tip never saw is found and cited", async () => {
  const repo = githubRepo();
  try {
    commitFiles(repo.dir, repo.git, {
      "BUGS.md": `## Open\n\n${MIRROR_HEADING}\n\nBody.\n\n### Second bug (mirrors GitHub issue #2)\n\nBody.\n`,
      "BUGS-FIXED.md": "## Fixed\n\n",
    }, "init");
    const fix1 = commitFiles(
      repo.dir,
      repo.git,
      { "BUGS.md": "## Open\n\n### Second bug (mirrors GitHub issue #2)\n\nBody.\n", "BUGS-FIXED.md": `## Fixed\n\n${MIRROR_HEADING}\n\nBody.\n` },
      "tumwater(bugfix): Fix the first bug",
    );
    const gh = fakeGh({ issues: [[issue(1), issue(2)]], compare: { [fix1]: "ahead" } });
    await pollGithubIssues(repo.dir, repo.config, { nextAt: 0 }, () => {}, gh.probe, NOW);
    assert.deepEqual(gh.calls.filter((args) => args[0] === "issue").map((args) => args[2]), ["1"], "only the fixed issue closes");

    const fix2 = commitFiles(
      repo.dir,
      repo.git,
      { "BUGS.md": "## Open\n\n", "BUGS-FIXED.md": `## Fixed\n\n${MIRROR_HEADING}\n\nBody.\n\n### Second bug (mirrors GitHub issue #2)\n\nBody.\n` },
      "tumwater(bugfix): Fix the second bug",
    );
    const gh2 = fakeGh({ issues: [[issue(1), issue(2)]], compare: { [fix1]: "ahead", [fix2]: "ahead" } });
    await pollGithubIssues(repo.dir, repo.config, { nextAt: 0 }, () => {}, gh2.probe, NOW + 3_600_000);
    const closes = gh2.calls.filter((args) => args[0] === "issue");
    assert.deepEqual(closes.map((args) => args[2]), ["2"], "the new tip's fix commit is found after the tip moved");
    assert.ok((closes[0]?.[8] ?? "").includes(`${fix2.slice(0, 8)} ("tumwater(bugfix): Fix the second bug")`), String(closes[0]?.[8]));
  } finally {
    repo.cleanup();
  }
});
