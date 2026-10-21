import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_PENDING_JS } from "../src/ui/gui/gui-client-pending.js";
import { GUI_CLIENT_JS } from "../src/ui/gui/gui-client.js";
import { clientScope } from "./helpers/gui-client-scope.js";

// The dashboard's Pending view (src/ui/gui/gui-client-pending.ts): the roster it paints from
// /api/diff's team document — each role's branch, state, commits ahead with their subjects,
// and uncommitted-file count — and its place in the assembled script. The drawer's full-patch
// half lives beside the drawer (test/gui-client-drawer.test.ts).

test("GUI_CLIENT_JS carries the pending module verbatim", () => {
  assert.ok(GUI_CLIENT_JS.includes(GUI_CLIENT_PENDING_JS), "the module's constant appears verbatim in the assembled script");
});

test("pendingTableHtml lists every role's branch, state, commits ahead with subjects, and dirty count", () => {
  const { pendingTableHtml } = clientScope<{ pendingTableHtml(team: unknown): string }>(
    ["format", "labels", "pending-table"],
    ["pendingTableHtml"],
  );
  const team = {
    mainBranch: "main",
    roles: [
      { role: "feature", branch: "tumwater/feature", state: "ready", ahead: 2, commits: [
        { sha: "abc12345", subject: "add the thing" },
        { sha: "def67890", subject: "fix the thing" },
      ], dirtyFiles: ["notes.txt"] },
      { role: "qa", branch: "tumwater/qa", state: "ready", ahead: 0, commits: [], dirtyFiles: [] },
      { role: "clean", branch: "tumwater/clean", state: "absent", ahead: 0, commits: [], dirtyFiles: [] },
    ],
  };
  const html = pendingTableHtml(team);
  // Every role is listed and every row opens that role's drawer.
  for (const role of ["feature", "qa", "clean"]) {
    assert.match(html, new RegExp(`data-open='${role}'`), `${role} row opens its drawer`);
  }
  assert.match(html, /tumwater\/feature/);
  assert.match(html, /2 commits/);
  assert.match(html, /abc12345 add the thing/);
  assert.match(html, /def67890 fix the thing/);
  assert.match(html, /title='notes\.txt'[^>]*>1 file</);
  // An idle role reads as such with no work line; an absent worktree degrades.
  assert.match(html, /no unmerged work/);
  assert.match(html, /no worktree/);
  assert.doesNotMatch(html, /undefined|NaN/);
});

test("pendingTableHtml degrades empty, all-no-base, and absent documents without throwing", () => {
  const { pendingTableHtml } = clientScope<{ pendingTableHtml(team: unknown): string }>(
    ["format", "labels", "pending-table"],
    ["pendingTableHtml"],
  );
  assert.match(pendingTableHtml(null), /No roles yet/);
  assert.match(pendingTableHtml({ mainBranch: "main", roles: [] }), /No roles yet/);
  const noBase = pendingTableHtml({ mainBranch: "ghost", roles: [{ role: "feature", branch: "tumwater/feature", state: "no-base", ahead: 0, commits: [], dirtyFiles: [] }] });
  assert.match(noBase, /Main branch ghost does not exist/);
  // A role with no dirtyFiles/commits arrays (a malformed payload) still renders.
  const sparse = pendingTableHtml({ mainBranch: "main", roles: [{ role: "qa", branch: "tumwater/qa", state: "ready", ahead: 0 }] });
  assert.match(sparse, /no unmerged work/);
  assert.doesNotMatch(sparse, /undefined/);
});

test("pendingTableHtml escapes role, branch, and subject text", () => {
  const { pendingTableHtml } = clientScope<{ pendingTableHtml(team: unknown): string }>(
    ["format", "labels", "pending-table"],
    ["pendingTableHtml"],
  );
  const html = pendingTableHtml({
    mainBranch: "main",
    roles: [{ role: "r<script>", branch: "b&c", state: "ready", ahead: 1, commits: [{ sha: "a1", subject: "<img>" }], dirtyFiles: ["x<y"] }],
  });
  assert.doesNotMatch(html, /<script>|<img>/);
  assert.match(html, /r&lt;script&gt;/);
  assert.match(html, /b&amp;c/);
  assert.match(html, /&lt;img&gt;/);
  assert.match(html, /x&lt;y/);
});

// The Merge queue card (pendingQueueHtml): the queued merges the status payload already
// carries, painted in execution order like `tumwater queue` — from a pure function of the
// payload and a fixed `now` so the ages are pinned.
test("pendingQueueHtml lists each queued merge in order with position, role, run, short sha, age, and summary", () => {
  const { pendingQueueHtml } = clientScope<{ pendingQueueHtml(mergeQueue: unknown, now: number): string }>(
    ["format", "labels", "pending-table"],
    ["pendingQueueHtml"],
  );
  const now = 1_000_000_000_000;
  const html = pendingQueueHtml({ depth: 2, entries: [
    { role: "feature", sha: "abcdef1234567890", run: 42, summary: "add the thing", enqueuedAt: now - 180_000 },
    { role: "bugfix", sha: "0123456789abcdef", run: 7, summary: "fix the thing", enqueuedAt: now - 5_000 },
  ] }, now);
  assert.match(html, /1\. feature run #42 · abcdef12 · 3m ago · add the thing/);
  assert.match(html, /2\. bugfix run #7 · 01234567 · 5s ago · fix the thing/);
  assert.ok(html.indexOf("1. feature") < html.indexOf("2. bugfix"), "array order is the row order");
});

test("pendingQueueHtml adds a merge label per row, escaped, and ignores absent labels", () => {
  const { pendingQueueHtml } = clientScope<{ pendingQueueHtml(mergeQueue: unknown, now: number, labels?: unknown): string }>(
    ["format", "labels", "pending-table"],
    ["pendingQueueHtml"],
  );
  const now = 1_000_000_000_000;
  const q = { depth: 2, entries: [
    { role: "feature", sha: "abcdef1234567890", run: 1, summary: "a", enqueuedAt: now },
    { role: "bugfix", sha: "0123456789abcdef", run: 2, summary: "b", enqueuedAt: now },
  ] };
  const html = pendingQueueHtml(q, now, ["landing 2m · reviewing", "<b>x</b>"]);
  assert.match(html, /0s ago · \[landing 2m · reviewing\] · a/);
  assert.match(html, /\[&lt;b&gt;x&lt;\/b&gt;\] · b/);
  assert.equal(pendingQueueHtml(q, now, "nope"), pendingQueueHtml(q, now));
  assert.doesNotMatch(pendingQueueHtml(q, now, ["", ""]), /\[/);
});

test("pendingQueueHtml names a re-submitted change's revision round and prior objections", () => {
  const { pendingQueueHtml } = clientScope<{ pendingQueueHtml(mergeQueue: unknown, now: number): string }>(
    ["format", "labels", "pending-table"],
    ["pendingQueueHtml"],
  );
  const now = 1_000_000_000_000;
  const q = { depth: 2, entries: [
    { role: "feature", sha: "abcdef1234567890", run: 42, summary: "add the thing", enqueuedAt: now - 180_000 },
    { role: "bugfix", sha: "0123456789abcdef", run: 7, summary: "revise the thing", enqueuedAt: now - 5_000, revisionRound: 1, priorObjections: 2 },
  ] };
  const html = pendingQueueHtml(q, now);
  assert.match(html, /1\. feature run #42 · abcdef12 · 3m ago · add the thing/, "a fresh entry's line is unchanged");
  assert.match(html, /2\. bugfix run #7 · 01234567 · 5s ago · revision 1 · 2 prior objections · revise the thing/);
  // A malformed revisionRound or priorObjections renders no note and no undefined/NaN.
  const bad = pendingQueueHtml({ depth: 1, entries: [
    { role: "qa", sha: "abcdef12", run: 1, summary: "s", enqueuedAt: now, revisionRound: "2", priorObjections: NaN },
  ] }, now);
  assert.doesNotMatch(bad, /revision|undefined|NaN/);
});

test("pendingQueueHtml states an empty, unreadable-only, or malformed queue without undefined or NaN", () => {
  const { pendingQueueHtml } = clientScope<{ pendingQueueHtml(mergeQueue: unknown, now: number): string }>(
    ["format", "labels", "pending-table"],
    ["pendingQueueHtml"],
  );
  const now = 1_000_000_000_000;
  assert.match(pendingQueueHtml({ depth: 0 }, now), /Merge queue empty/);
  assert.match(pendingQueueHtml(null, now), /Merge queue empty/);
  // A depth with no readable list is the unreadable-file count, stated without inventing rows.
  assert.match(pendingQueueHtml({ depth: 2 }, now), /merge queue: 2 waiting/);
  // An entries field that is not an array, and an entry missing its sha/enqueuedAt, degrades.
  assert.doesNotMatch(pendingQueueHtml({ depth: 1, entries: "nope" }, now), /undefined|NaN/);
  const malformed = pendingQueueHtml({ depth: 1, entries: [
    { role: "qa", run: undefined, summary: undefined, sha: undefined, enqueuedAt: undefined },
  ] }, now);
  assert.match(malformed, /qa/);
  assert.doesNotMatch(malformed, /undefined|NaN/);
});

test("pendingQueueHtml escapes role and summary markup", () => {
  const { pendingQueueHtml } = clientScope<{ pendingQueueHtml(mergeQueue: unknown, now: number): string }>(
    ["format", "labels", "pending-table"],
    ["pendingQueueHtml"],
  );
  const now = 1_000_000_000_000;
  const html = pendingQueueHtml({ depth: 1, entries: [
    { role: "r<script>", sha: "abcdef12", run: 1, summary: "<img>", enqueuedAt: now - 1_000 },
  ] }, now);
  assert.doesNotMatch(html, /<script>|<img>/);
  assert.match(html, /r&lt;script&gt;/);
  assert.match(html, /&lt;img&gt;/);
});

test("drawerQueueHtml lists only the role's queued merges under their whole-queue positions and labels", () => {
  const { drawerQueueHtml } = clientScope<{ drawerQueueHtml(q: unknown, role: string, now: number, labels?: unknown): string }>(
    ["format", "labels", "pending-table"],
    ["drawerQueueHtml"],
  );
  const now = 1_000_000_000_000;
  const e = (role: string, summary = "s") => ({ role, sha: "abcdef1234567890", run: 3, summary, enqueuedAt: now });
  const q = { depth: 3, entries: [e("feature-2"), e("bugfix"), e("feature-2")] };
  const html = drawerQueueHtml(q, "feature-2", now, ["", "", "merging 1m"]);
  assert.match(html, /1\. feature #2 run #/);
  assert.match(html, /3\. feature #2 run #/);
  assert.doesNotMatch(html, /bugfix/);
  assert.doesNotMatch(html, /2\. /);
  assert.match(html, /3\. [^\n]*\[merging 1m\]/);
  assert.ok(html.includes("2 of 3 waiting"));
  assert.equal(drawerQueueHtml(q, "clean", now, []), "");
  assert.equal(drawerQueueHtml({ depth: 0 }, "feature-2", now), "");
  assert.equal(drawerQueueHtml(null, "feature-2", now), "");
  assert.equal(drawerQueueHtml({ entries: "nope" }, "feature-2", now), "");
  assert.match(drawerQueueHtml({ depth: 1, entries: [e("clean", "<b>x</b>")] }, "clean", now), /&lt;b&gt;x&lt;\/b&gt;/);
});

test("pendingOverlapsHtml makes each path a toggle and expands only the open one", () => {
  const { pendingOverlapsHtml } = clientScope<{ pendingOverlapsHtml(view: unknown, open?: unknown): string }>(
    ["format", "labels", "pending-table"],
    ["pendingOverlapsHtml"],
    { drawerChangeHtml: () => "<p>patch</p>" },
  );
  const view = { mainBranch: "main", state: "ready", overlaps: [
    { path: "src/a.ts", roles: ["feature"] },
    { path: "src/b.ts", roles: ["qa"] },
  ] };
  const closed = pendingOverlapsHtml(view);
  assert.match(closed, /data-overlap='0'/);
  assert.match(closed, /data-overlap='1'/);
  assert.doesNotMatch(closed, /overlap-detail/);
  const html = pendingOverlapsHtml(view, { path: "src/a.ts", rows: [{ role: "feature", state: "loading" }] });
  assert.equal(html.split("overlap-detail").length, 2);
  const at = html.indexOf("overlap-detail");
  assert.ok(html.indexOf("src/a.ts: feature") < at && at < html.indexOf("src/b.ts: qa"));
  assert.match(html.slice(at, html.indexOf("src/b.ts: qa")), /Loading…/);
});

test("pendingOverlapsHtml lists each shared path with its roles, and states no-base, empty, and malformed documents", () => {
  const { pendingOverlapsHtml } = clientScope<{ pendingOverlapsHtml(view: unknown): string }>(
    ["format", "labels", "pending-table"],
    ["pendingOverlapsHtml"],
  );
  const html = pendingOverlapsHtml({ mainBranch: "main", state: "ready", overlaps: [
    { path: "src/a.ts", roles: ["feature", "feature-2"] },
    { path: "<b>.md", roles: ["qa"] },
  ] });
  assert.match(html, /Overlapping files/);
  assert.match(html, /src\/a\.ts: feature, feature #2/);
  assert.match(html, /&lt;b&gt;\.md/);
  assert.ok(!html.includes("<b>"), "paths are escaped");
  assert.match(pendingOverlapsHtml({ mainBranch: "trunk", state: "no-base", overlaps: [] }), /Main branch trunk does not exist/);
  for (const view of [{ mainBranch: "main", state: "ready", overlaps: [] }, null, undefined, { overlaps: "x" }]) {
    const out = pendingOverlapsHtml(view);
    assert.match(out, /No file is touched by two pending changes/);
    assert.doesNotMatch(out, /undefined|NaN/);
  }
  const bad = pendingOverlapsHtml({ state: "ready", overlaps: [{ roles: null }] });
  assert.match(bad, /\?:/);
  assert.doesNotMatch(bad, /undefined|null/);
});
