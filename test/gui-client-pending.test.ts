import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_PENDING_JS } from "../src/ui/gui/gui-client-pending.js";
import { GUI_CLIENT_JS } from "../src/ui/gui/gui-client.js";
import { clientScope } from "./helpers/gui-client-scope.js";

// The dashboard's Pending view (src/ui/gui/gui-client-pending.ts): the roster it paints from
// /api/diff's fleet document — each role's branch, state, commits ahead with their subjects,
// and uncommitted-file count — and its place in the assembled script. The drawer's full-patch
// half lives beside the drawer (test/gui-client-drawer.test.ts).

test("GUI_CLIENT_JS carries the pending module verbatim", () => {
  assert.ok(GUI_CLIENT_JS.includes(GUI_CLIENT_PENDING_JS), "the module's constant appears verbatim in the assembled script");
});

test("pendingTableHtml lists every role's branch, state, commits ahead with subjects, and dirty count", () => {
  const { pendingTableHtml } = clientScope<{ pendingTableHtml(fleet: unknown): string }>(
    ["format", "labels", "pending-table"],
    ["pendingTableHtml"],
  );
  const fleet = {
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
  const html = pendingTableHtml(fleet);
  // Every role is listed and every row opens that loop's drawer.
  for (const role of ["feature", "qa", "clean"]) {
    assert.match(html, new RegExp(`data-open='${role}'`), `${role} row opens its drawer`);
  }
  assert.match(html, /tumwater\/feature/);
  assert.match(html, /2 commits/);
  assert.match(html, /abc12345 add the thing/);
  assert.match(html, /def67890 fix the thing/);
  assert.match(html, /title='notes\.txt'[^>]*>1 file</);
  // An idle loop reads as such with no work line; an absent worktree degrades.
  assert.match(html, /no unmerged work/);
  assert.match(html, /no worktree/);
  assert.doesNotMatch(html, /undefined|NaN/);
});

test("pendingTableHtml degrades empty, all-no-base, and absent documents without throwing", () => {
  const { pendingTableHtml } = clientScope<{ pendingTableHtml(fleet: unknown): string }>(
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
  const { pendingTableHtml } = clientScope<{ pendingTableHtml(fleet: unknown): string }>(
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

// The Merge queue card (pendingQueueHtml): the queued landings the status payload already
// carries, painted in execution order like `tumwater queue` — from a pure function of the
// payload and a fixed `now` so the ages are pinned.
test("pendingQueueHtml lists each queued landing in order with position, role, tick, short sha, age, and summary", () => {
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

test("pendingQueueHtml adds a landing label per row, escaped, and ignores absent labels", () => {
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
