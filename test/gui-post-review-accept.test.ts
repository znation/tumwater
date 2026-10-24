import test from "node:test";
import assert from "node:assert/strict";
import { handlePostReviewAccept } from "../src/gui/gui-endpoint-commands.js";
import { captureJson, fakeReq } from "./fakes/fake-res.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import { postReviewPath } from "../src/paths.js";
import { readPostReviews } from "../src/review/post-merge-review.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";

// POST /api/post-review-accept (src/gui/gui-operator-commands.ts): the Post-merge reviews card
// row's two-click Accept, the browser twin of `tumwater reviews --accept <n>` — through the same
// acceptPostReviewBySha removal, so the endpoint and the CLI remove the same entry and log the
// same warning.

const post = (root: string, body: unknown) => captureJson((res) => handlePostReviewAccept(fakeReq(JSON.stringify(body)), res, root));

function seed(root: string, entries: unknown[]): void {
  writeFileDeep(postReviewPath(root), JSON.stringify({ pending: entries }));
}

test("POST /api/post-review-accept { sha } answers 200 accepted and removes the matching entry", async () => {
  const root = makeRepo();
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  seed(root, [
    { commit: a, role: "improve", summary: "tidy the parser" },
    { commit: b, role: "clean", summary: "rework the docs" },
  ]);
  const { captured, data } = await post(root, { sha: b.toUpperCase() });
  assert.equal(captured.status, 200);
  const d = data as { ok: boolean; status: string; role: string; commit: string; summary: string; message: string };
  assert.equal(d.ok, true);
  assert.equal(d.status, "accepted");
  assert.equal(d.role, "clean");
  assert.equal(d.commit, b);
  assert.equal(d.summary, "rework the docs");
  assert.match(d.message, /^accepted the post-merge review of [0-9a-f]{8} unreviewed — rework the docs$/);
  assert.deepEqual(
    readPostReviews(root).map((e) => e.role),
    ["improve"],
    "the matching entry is removed, the other keeps FIFO order",
  );
  const warnings = eventsOfType(root, "warning").filter((e) => e.source === "clean");
  assert.equal(warnings.length, 1, "exactly one warning under clean");
});

test("POST /api/post-review-accept an unknown sha answers 200 gone and writes nothing", async () => {
  const root = makeRepo();
  seed(root, [{ commit: "a".repeat(40), role: "improve", summary: "tidy the parser" }]);
  const before = readPostReviews(root);
  const { captured, data } = await post(root, { sha: "f".repeat(40) });
  assert.equal(captured.status, 200);
  assert.deepEqual((data as { ok: boolean; status: string }).status, "gone");
  assert.deepEqual(readPostReviews(root), before, "nothing is removed");
  assert.equal(eventsOfType(root, "warning").length, 0, "no warning is logged");
});

test("POST /api/post-review-accept a rejected sha answers 409 and leaves the file", async () => {
  const root = makeRepo();
  const b = "b".repeat(40);
  seed(root, [
    { commit: "a".repeat(40), role: "improve", summary: "tidy the parser" },
    { commit: b, role: "clean", summary: "bad change", rejected: ["no tests"] },
  ]);
  const before = readPostReviews(root);
  const { captured, data } = await post(root, { sha: b });
  assert.equal(captured.status, 409);
  assert.match((data as { error: string }).error, /stays on main with the reviewer's reasons — there is nothing to accept/);
  assert.deepEqual(readPostReviews(root), before, "the rejected entry is left in place");
  assert.equal(eventsOfType(root, "warning").length, 0, "no warning is logged");
});

test("POST /api/post-review-accept a settled fixed sha answers 409 and leaves the file", async () => {
  const root = makeRepo();
  const b = "b".repeat(40);
  seed(root, [
    { commit: "a".repeat(40), role: "improve", summary: "tidy the parser" },
    { commit: b, role: "clean", summary: "fixed change", fixed: "c".repeat(40) },
  ]);
  const before = readPostReviews(root);
  const { captured, data } = await post(root, { sha: b });
  assert.equal(captured.status, 409);
  assert.match((data as { error: string }).error, /already merged its fix on main — nothing to accept/);
  assert.deepEqual(readPostReviews(root), before, "the settled fixed entry is left in place");
  assert.equal(eventsOfType(root, "warning").length, 0, "no warning is logged");
});

test("POST /api/post-review-accept a missing or non-hex sha answers 400 and writes nothing", async () => {
  const root = makeRepo();
  seed(root, [{ commit: "a".repeat(40), role: "improve", summary: "tidy the parser" }]);
  const before = readPostReviews(root);
  for (const body of [{}, { sha: "main" }, { sha: "--json" }, { sha: 42 }]) {
    const { captured, data } = await post(root, body);
    assert.equal(captured.status, 400, JSON.stringify(body));
    assert.doesNotMatch((data as { error: string }).error, /got undefined/);
  }
  assert.deepEqual(readPostReviews(root), before, "nothing is removed");
  assert.equal(eventsOfType(root, "warning").length, 0, "no warning is logged");
});
