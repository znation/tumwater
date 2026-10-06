import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_PENDING_JS } from "../src/ui/gui-client-pending.js";
import { GUI_CLIENT_JS } from "../src/ui/gui-client.js";
import { clientScope } from "./gui-client-scope.js";

// The dashboard's Pending view (src/ui/gui-client-pending.ts): the roster it paints from
// /api/diff's fleet document — each role's branch, state, commits ahead with their subjects,
// and uncommitted-file count — and its place in the assembled script. The drawer's full-patch
// half lives beside the drawer (test/gui-client-drawer.test.ts).

test("GUI_CLIENT_JS carries the pending module verbatim", () => {
  assert.ok(GUI_CLIENT_JS.includes(GUI_CLIENT_PENDING_JS), "the module's constant appears verbatim in the assembled script");
});

test("pendingTableHtml lists every role's branch, state, commits ahead with subjects, and dirty count", () => {
  const { pendingTableHtml } = clientScope<{ pendingTableHtml(fleet: unknown): string }>(
    ["pending-table"],
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
  assert.match(html, /no unlanded work/);
  assert.match(html, /no worktree/);
  assert.doesNotMatch(html, /undefined|NaN/);
});

test("pendingTableHtml degrades empty, all-no-base, and absent documents without throwing", () => {
  const { pendingTableHtml } = clientScope<{ pendingTableHtml(fleet: unknown): string }>(
    ["pending-table"],
    ["pendingTableHtml"],
  );
  assert.match(pendingTableHtml(null), /No loops yet/);
  assert.match(pendingTableHtml({ mainBranch: "main", roles: [] }), /No loops yet/);
  const noBase = pendingTableHtml({ mainBranch: "ghost", roles: [{ role: "feature", branch: "tumwater/feature", state: "no-base", ahead: 0, commits: [], dirtyFiles: [] }] });
  assert.match(noBase, /Main branch ghost does not exist/);
  // A role with no dirtyFiles/commits arrays (a malformed payload) still renders.
  const sparse = pendingTableHtml({ mainBranch: "main", roles: [{ role: "qa", branch: "tumwater/qa", state: "ready", ahead: 0 }] });
  assert.match(sparse, /no unlanded work/);
  assert.doesNotMatch(sparse, /undefined/);
});

test("pendingTableHtml escapes role, branch, and subject text", () => {
  const { pendingTableHtml } = clientScope<{ pendingTableHtml(fleet: unknown): string }>(
    ["pending-table"],
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
