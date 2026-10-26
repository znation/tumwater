import test from "node:test";
import assert from "node:assert/strict";
import { priorObjectionNumber } from "../src/review/review-verdict.js";

/** Edge coverage for the repeat tag the revision-finality policy reads: which reasons count as a
 * `(prior N)` restatement, and what a tag with no matching prior count is worth. The tag is the
 * reviewer's own vocabulary, so these are unit tests of the parser only; the revision cases that
 * exercised it through a reviewer verdict were retired by part 3r/3 (a deterministic gate
 * rejection carries no `(prior N)` tag), and the pre-merge reviewer run is removed by part 3h/3. */

test("priorObjectionNumber reads only a leading (prior N) tag with N of at least one", () => {
  assert.equal(priorObjectionNumber("(prior 3) still wrong"), 3);
  assert.equal(priorObjectionNumber("  (PRIOR 2) still wrong"), 2, "trimmed and case-insensitive");
  assert.equal(priorObjectionNumber("(prior 0) still wrong"), null);
  assert.equal(priorObjectionNumber("prior to the change, x"), null);
  assert.equal(priorObjectionNumber("see (prior 1) above"), null, "a tag mid-line is not a tag");
  assert.equal(priorObjectionNumber("(prior one) x"), null);
});
