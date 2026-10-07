import test from "node:test";
import assert from "node:assert/strict";
import { didYouMean, suggestClosest, typoSuffix } from "../src/text/suggest.js";

// text/suggest.ts is the single home of the did-you-mean layer every unknown-X error surface
// (unknown command, unknown config key, unknown role, unknown help topic) renders through.

// suggestClosest is the shared did-you-mean behind the unknown-command and unknown-config-key
// errors. The contract the CLI wording relies on: a typo (≤2 edits, case-insensitive) names
// its closest real token, a different word or an empty input gets null, and ties/near-misses
// never invent a candidate — the caller still prints the full valid list.
test("suggestClosest names the closest candidate within two edits, case-insensitively", () => {
  assert.equal(suggestClosest("modle", ["model", "thinking"]), "model");
  assert.equal(suggestClosest("MODLE", ["model"]), "model");
  assert.equal(suggestClosest("statis", ["status", "logs"]), "status");
  assert.equal(suggestClosest("frobnicate", ["model", "status"]), null);
  assert.equal(suggestClosest("", ["model"]), null);
  // The closest candidate wins even when another is also within the cap:
  // modle→model is 2 edits, modle→modeller 3, so the nearer spelling is named.
  assert.equal(suggestClosest("modle", ["modeller", "model"]), "model");
  // An empty candidate list has nothing to suggest.
  assert.equal(suggestClosest("model", []), null);
});

// didYouMean is the pinned wording the suffix and the bare callers (cli.ts's unknown-command
// and no-help-topic errors) share.
test("didYouMean wraps a suggestion in the pinned wording, empty string for none", () => {
  assert.equal(didYouMean("model"), " — did you mean `model`?");
  assert.equal(didYouMean(null), "");
});

// typoSuffix composes suggestClosest + didYouMean — the suffix every unknown-X error appends.
// It renders the suggestion through didYouMean's pinned wording, and the empty string when
// suggestClosest has nothing close enough (the same contract as its two halves).
test("typoSuffix appends the did-you-mean wording for a close typo, nothing otherwise", () => {
  assert.equal(typoSuffix("modle", ["model", "status"]), " — did you mean `model`?");
  assert.equal(typoSuffix("frobnicate", ["model", "status"]), "");
  assert.equal(typoSuffix("model", []), "");
});
