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

test("pendingQueueHtml names a re-queued entry's retry and its deferral", () => {
  const { pendingQueueHtml } = clientScope<{ pendingQueueHtml(mergeQueue: unknown, now: number): string }>(
    ["format", "labels", "pending-table"],
    ["pendingQueueHtml"],
  );
  const now = 1_000_000_000_000;
  const q = { depth: 2, entries: [
    { role: "feature", sha: "abcdef1234567890", run: 42, summary: "add the thing", enqueuedAt: now - 180_000 },
    { role: "bugfix", sha: "0123456789abcdef", run: 7, summary: "re-queue the thing", enqueuedAt: now - 5_000, retry: "review_error", notBefore: now + 42_000 },
  ] };
  const html = pendingQueueHtml(q, now);
  assert.match(html, /1\. feature run #42 · abcdef12 · 3m ago · add the thing/, "a fresh entry's line is unchanged");
  assert.match(html, /2\. bugfix run #7 · 01234567 · 5s ago · re-queued after review_error · eligible in 42s · re-queue the thing/);
  assert.doesNotMatch(html, /undefined|NaN/);
  // A row without retry/notBefore renders neither clause and no undefined/NaN.
  const plain = pendingQueueHtml({ depth: 1, entries: [
    { role: "qa", sha: "abcdef12", run: 1, summary: "s", enqueuedAt: now },
  ] }, now);
  assert.doesNotMatch(plain, /re-queued|eligible|undefined|NaN/);
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
  assert.match(html, /value='r&lt;script&gt;'/, "a role id carrying markup is escaped in the picker option");
});

test("pendingQueueHtml keeps the chosen role's merges under their whole-queue positions", () => {
  const { pendingQueueHtml } = clientScope<{ pendingQueueHtml(mergeQueue: unknown, now: number, labels?: unknown, role?: string): string }>(
    ["format", "labels", "pending-table"],
    ["pendingQueueHtml"],
  );
  const now = 1_000_000_000_000;
  const q = { depth: 3, entries: [
    { role: "feature-2", sha: "aaaaaaaaaaaaaaaa", run: 1, summary: "a", enqueuedAt: now },
    { role: "clean", sha: "bbbbbbbbbbbbbbbb", run: 2, summary: "b", enqueuedAt: now },
    { role: "feature", sha: "cccccccccccccccc", run: 3, summary: "c", enqueuedAt: now },
  ] };
  const html = pendingQueueHtml(q, now, [], "clean");
  assert.match(html, /2\. clean run #2 · bbbbbbbb · 0s ago · b/);
  assert.doesNotMatch(html, /1\. |3\. |1\.feature|3\.feature/);
  assert.equal((html.match(/2\. clean run #2/g) || []).length, 1, "only the clean line renders");
  const m = /id='pendingqueuerole'>([\s\S]*?)<\/select>/.exec(html);
  assert.ok(m, "head holds the role picker");
  const opts = m ? m[1] ?? "" : "";
  assert.match(opts, /option value=''>All roles<\/option>/);
  assert.match(opts, /value='clean' selected>[^<]*<\/option>/);
  assert.match(opts, /value='feature'/);
  assert.match(opts, /value='feature-2'/);
  assert.ok(opts.indexOf("value='clean'") < opts.indexOf("value='feature'"), "role options are sorted");
});

test("pendingQueueHtml shows the whole queue for All roles and ignores an absent role", () => {
  const { pendingQueueHtml } = clientScope<{ pendingQueueHtml(mergeQueue: unknown, now: number, labels?: unknown, role?: string): string }>(
    ["format", "labels", "pending-table"],
    ["pendingQueueHtml"],
  );
  const now = 1_000_000_000_000;
  const q = { depth: 3, entries: [
    { role: "feature-2", sha: "aaaaaaaaaaaaaaaa", run: 1, summary: "a", enqueuedAt: now },
    { role: "clean", sha: "bbbbbbbbbbbbbbbb", run: 2, summary: "b", enqueuedAt: now },
    { role: "feature", sha: "cccccccccccccccc", run: 3, summary: "c", enqueuedAt: now },
  ] };
  const all = pendingQueueHtml(q, now, [], "");
  assert.match(all, /1\. feature #2 run #1/);
  assert.match(all, /2\. clean run #2/);
  assert.match(all, /3\. feature run #3/);
  const m = /id='pendingqueuerole'>([\s\S]*?)<\/select>/.exec(all);
  assert.ok(m, "head holds the role picker");
  const opts = m ? m[1] ?? "" : "";
  assert.match(opts, /option value=''>All roles<\/option>/);
  assert.doesNotMatch(opts, /selected/);
  assert.equal(pendingQueueHtml(q, now), all, "the three-argument call equals the All-roles call");
  assert.equal(pendingQueueHtml(q, now, [], "qa"), all, "a role with no waiting merge shows the whole queue");
});

test("pendingQueueHtml renders no role picker without roles", () => {
  const { pendingQueueHtml } = clientScope<{ pendingQueueHtml(mergeQueue: unknown, now: number, labels?: unknown, role?: string): string }>(
    ["format", "labels", "pending-table"],
    ["pendingQueueHtml"],
  );
  const now = 1_000_000_000_000;
  assert.doesNotMatch(pendingQueueHtml({ depth: 0 }, now), /pendingqueuerole|undefined|NaN/);
  assert.match(pendingQueueHtml({ depth: 0 }, now), /Merge queue empty/);
  assert.doesNotMatch(pendingQueueHtml({ depth: 2 }, now), /pendingqueuerole|undefined|NaN/);
  assert.doesNotMatch(pendingQueueHtml({ depth: 1, entries: "nope" }, now), /pendingqueuerole|undefined|NaN/);
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

test("pendingOverlapsHtml's Role picker keeps only the files the chosen role holds, under their unfiltered indexes", () => {
  const { pendingOverlapsHtml, pendingOverlapHolders } = clientScope<{
    pendingOverlapsHtml(view: unknown, open?: unknown, role?: string): string;
    pendingOverlapHolders(view: unknown): string[];
  }>(["format", "labels", "pending-table"], ["pendingOverlapsHtml", "pendingOverlapHolders"]);
  const view = { mainBranch: "main", state: "ready", overlaps: [
    { path: "src/a.ts", roles: ["feature", "qa"] },
    { path: "src/b.ts", roles: ["feature-2", "qa"] },
    { path: "src/c.ts", roles: ["feature", "feature-2"] },
  ] };
  assert.deepEqual(pendingOverlapHolders(view), ["feature", "feature-2", "qa"]);
  assert.deepEqual(pendingOverlapHolders(null), []);
  assert.deepEqual(pendingOverlapHolders({ overlaps: "x" }), []);
  const all = pendingOverlapsHtml(view);
  assert.match(all, /id='pendingoverlaprole'/);
  assert.match(all, /<option value=''>All roles<\/option>/);
  assert.match(all, /<option value='feature-2'>feature #2<\/option>/);
  assert.match(all, /<option value='qa'>qa<\/option>/);
  assert.doesNotMatch(all, / selected/);
  for (const i of [0, 1, 2]) assert.ok(all.includes("data-overlap='" + i + "'"));
  const one = pendingOverlapsHtml(view, null, "feature-2");
  assert.ok(one.includes("data-overlap='1'") && one.includes("data-overlap='2'"));
  assert.ok(!one.includes("data-overlap='0'") && !one.includes("src/a.ts"));
  assert.match(one, /<option value='feature-2' selected>/);
  assert.ok(one.includes("src/b.ts: feature #2, qa"));
  const ghost = pendingOverlapsHtml(view, null, "ghost");
  for (const i of [0, 1, 2]) assert.ok(ghost.includes("data-overlap='" + i + "'"));
  for (const v of [{ overlaps: [] }, { state: "no-base", mainBranch: "main" }, null, { overlaps: "x" }]) {
    assert.doesNotMatch(pendingOverlapsHtml(v), /pendingoverlaprole/);
  }
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

test("pendingOverlapsHtml's Folder picker keeps only the files at or under the chosen directory", () => {
  const { pendingOverlapsHtml, pendingOverlapDirs } = clientScope<{
    pendingOverlapsHtml(view: unknown, open?: unknown, role?: string, dir?: string): string;
    pendingOverlapDirs(view: unknown): string[];
  }>(["format", "labels", "pending-table"], ["pendingOverlapsHtml", "pendingOverlapDirs"]);
  const view = { mainBranch: "main", state: "ready", overlaps: [
    { path: "src/cli/a.ts", roles: ["feature", "qa"] },
    { path: "src/gui/b.ts", roles: ["feature-2", "qa"] },
    { path: "README.md", roles: ["feature", "qa"] },
    { path: "test/new/", roles: ["feature", "qa"] },
  ] };
  assert.deepEqual(pendingOverlapDirs(view), ["src", "src/cli", "src/gui", "test", "test/new"]);
  assert.deepEqual(pendingOverlapDirs(null), []);
  assert.deepEqual(pendingOverlapDirs({ overlaps: "x" }), []);
  const all = pendingOverlapsHtml(view);
  assert.match(all, /id='pendingoverlapdir'/);
  assert.match(all, /<option value=''>All folders<\/option>/);
  assert.match(all, /<option value='src\/cli'>src\/cli\/<\/option>/);
  assert.doesNotMatch(all, / selected/);
  const src = pendingOverlapsHtml(view, null, "", "src");
  assert.ok(src.includes("data-overlap='0'") && src.includes("data-overlap='1'"));
  assert.ok(!src.includes("README.md") && !src.includes("test/new/</button>") && !src.includes("data-overlap='3'"));
  assert.match(src, /<option value='src' selected>/);
  const fresh = pendingOverlapsHtml(view, null, "", "test/new");
  assert.ok(fresh.includes("data-overlap='3'") && !fresh.includes("data-overlap='0'"));
  const none = pendingOverlapsHtml(view, null, "feature-2", "src/cli");
  assert.ok(!none.includes("data-overlap"));
  assert.match(none, /No overlapping file matches the filters/);
  assert.match(none, /pendingoverlaprole/);
  assert.match(none, /pendingoverlapdir/);
  const ghost = pendingOverlapsHtml(view, null, "", "lib");
  for (const i of [0, 1, 2, 3]) assert.ok(ghost.includes("data-overlap='" + i + "'"));
  const root = pendingOverlapsHtml({ state: "ready", overlaps: [{ path: "README.md", roles: ["qa"] }] });
  assert.match(root, /pendingoverlaprole/);
  assert.doesNotMatch(root, /pendingoverlapdir/);
  for (const v of [{ overlaps: [] }, { state: "no-base", mainBranch: "main" }, null, { overlaps: "x" }]) {
    assert.doesNotMatch(pendingOverlapsHtml(v), /pendingoverlapdir/);
  }
});

test("pendingQueueHtml gives each Merge queue row a cancel button, armed only on the matching row", () => {
  const { pendingQueueHtml } = clientScope<{ pendingQueueHtml(mergeQueue: unknown, now: number, labels?: unknown, role?: string, cancelArmedSha?: string): string }>(
    ["format", "labels", "pending-table"],
    ["pendingQueueHtml"],
  );
  const now = 1_000_000_000_000;
  const q = { depth: 2, entries: [
    { role: "feature", sha: "abcdef1234567890", run: 1, summary: "a", enqueuedAt: now },
    { role: "bugfix", sha: "0123456789abcdef", run: 2, summary: "b", enqueuedAt: now },
  ] };
  // No fifth argument: every row carries a Cancel button, none armed.
  const plain = pendingQueueHtml(q, now);
  assert.equal(plain.split("data-cancel='abcdef1234567890'>Cancel</").length - 1, 1);
  assert.equal(plain.split("data-cancel='0123456789abcdef'>Cancel</").length - 1, 1);
  assert.doesNotMatch(plain, /Confirm cancel/);
  // Armed on one sha: exactly that row reads Confirm cancel, the rest stay Cancel.
  const armed = pendingQueueHtml(q, now, [], "", "0123456789abcdef");
  assert.equal(armed.split("data-cancel='0123456789abcdef'>Confirm cancel</").length - 1, 1);
  assert.equal(armed.split("data-cancel='abcdef1234567890'>Cancel</").length - 1, 1);
  assert.doesNotMatch(armed, /data-cancel='abcdef1234567890'>Confirm cancel/);
  assert.equal(armed, pendingQueueHtml(q, now, [], "", "0123456789abcdef"), "the armed call is stable");
});

test("queue buttons carry no data-cancel in the drawer, and a malformed row renders no undefined", () => {
  const { pendingQueueHtml, drawerQueueHtml } = clientScope<{
    pendingQueueHtml(mergeQueue: unknown, now: number, labels?: unknown, role?: string, cancelArmedSha?: string): string;
    drawerQueueHtml(q: unknown, role: string, now: number, labels?: unknown): string;
  }>(["format", "labels", "pending-table"], ["pendingQueueHtml", "drawerQueueHtml"]);
  const now = 1_000_000_000_000;
  const q = { depth: 1, entries: [{ role: "feature", sha: "abcdef12", run: 1, summary: "a", enqueuedAt: now }] };
  // The drawer's queue section renders no cancel button at all.
  assert.doesNotMatch(drawerQueueHtml(q, "feature", now), /data-cancel|Cancel/);
  // A malformed entry (no sha) renders no button and no undefined.
  const bad = pendingQueueHtml({ depth: 1, entries: [{ role: "qa", run: 1, summary: "s", enqueuedAt: now }] }, now, [], "", "anything");
  assert.doesNotMatch(bad, /data-cancel|undefined|NaN/);
  assert.match(bad, /qa/);
});
