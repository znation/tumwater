import test from "node:test";
import assert from "node:assert/strict";
import {
  rejectBadRole,
  intQuery,
  windowDays,
  requirePromptText,
  requirePausedFlag,
} from "../src/gui/gui-args.js";
import { DIRECTOR_PROMPT_MAX_CHARS } from "../src/inbox/inbox-submit.js";
import { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS } from "../src/events/event-window.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { fakeRes } from "./fakes/fake-res.js";

// The dashboard's request-argument validators (src/gui/gui-args.ts), exercised at the unit
// level: they have no other direct coverage — the server-level tests (gui.test.ts,
// gui-operator.test.ts) reach them only through happy paths over a live socket. These
// handlers decide whether an API request is refused with the shared 400 wording, so the
// edges matter: absent vs null vs unknown role ids, absent vs malformed integer queries,
// the window's degrade-to-default rule, and the prompt/pause body checks both endpoint
// variants must answer identically. Each helper either answers through sendJson on the
// response or returns its parsed value, so a fake res capturing writeHead/end is enough.

// A configless temp root: knownRoleIdsCached falls back to the built-in catalog there, so
// the valid-id list in the 400s is allRoleIds() and any catalog id validates.
function noRepoRoot(): string {
  return tmpdir();
}

test("rejectBadRole accepts a known id and lets the request through untouched", () => {
  const { res, captured } = fakeRes();
  const stopped = rejectBadRole(noRepoRoot(), res, DIRECTOR_ROLE);
  assert.equal(stopped, false);
  assert.equal(captured.status, undefined);
  assert.equal(captured.body, "");
});

test("rejectBadRole rejects an unknown id with the shared 400 naming the valid ids", () => {
  const root = noRepoRoot();
  const { res, captured } = fakeRes();
  const stopped = rejectBadRole(root, res, "not-a-role");
  assert.equal(stopped, true);
  assert.equal(captured.status, 400);
  assert.ok(
    captured.body.includes('unknown role \\"not-a-role\\" (valid ids: '),
    `expected the shared unknown-role 400, got ${captured.body}`,
  );
});

test("rejectBadRole suggests the closest valid id for a string near miss", () => {
  const { res, captured } = fakeRes();
  const stopped = rejectBadRole(noRepoRoot(), res, "bugfx");
  assert.equal(stopped, true);
  assert.equal(captured.status, 400);
  assert.match(captured.body, /unknown role \\"bugfx\\" \(valid ids: .*did you mean `bugfix`\?/);
});

test("rejectBadRole rejects a non-string id, never treating it as absent", () => {
  const { res, captured } = fakeRes();
  const stopped = rejectBadRole(noRepoRoot(), res, 123 as unknown as string);
  assert.equal(stopped, true);
  assert.equal(captured.status, 400);
  assert.match(captured.body, /unknown role 123/);
});

test("rejectBadRole treats an absent id as required unless allowMissing is set", () => {
  const root = noRepoRoot();
  const required = fakeRes();
  assert.equal(rejectBadRole(root, required.res, undefined), true);
  assert.equal(required.captured.status, 400);
  assert.match(required.captured.body, /^{"error":"role required \(valid ids: /);

  // With allowMissing the wake endpoint's {} rides the all-roles default — no 400, and the
  // id list is not even computed.
  const allowed = fakeRes();
  assert.equal(rejectBadRole(root, allowed.res, undefined, true), false);
  assert.equal(allowed.captured.status, undefined);
});

test("rejectBadRole rejects an explicit null even under allowMissing", () => {
  const { res, captured } = fakeRes();
  const stopped = rejectBadRole(noRepoRoot(), res, null, true);
  assert.equal(stopped, true);
  assert.equal(captured.status, 400);
  assert.match(captured.body, /role required/);
});

test("intQuery falls back when absent and requires the parameter when no fallback is given", () => {
  const { res, captured } = fakeRes();
  assert.equal(intQuery(new URLSearchParams(""), res, "n", "positive", 25), 25);
  assert.equal(captured.status, undefined);

  const required = fakeRes();
  assert.equal(intQuery(new URLSearchParams(""), required.res, "n", "positive"), null);
  assert.equal(required.captured.status, 400);
  assert.match(required.captured.body, /"error":"n required"/);
});

test("intQuery parses plain decimals and rejects malformed spellings with the kind's wording", () => {
  const { res } = fakeRes();
  assert.equal(intQuery(new URLSearchParams("n=5"), res, "n", "positive"), 5);

  const zero = fakeRes();
  assert.equal(intQuery(new URLSearchParams("n=0"), zero.res, "n", "non-negative"), 0);
  assert.equal(zero.captured.status, undefined);

  // Zero is not a positive integer; a signed, scientific, or padded spelling is not a
  // plain decimal at all.
  for (const [raw, kind] of [
    ["0", "positive"],
    ["-3", "positive"],
    ["1e3", "positive"],
    ["0x10", "non-negative"],
    [" 5", "non-negative"],
  ] as const) {
    const bad = fakeRes();
    assert.equal(intQuery(new URLSearchParams(`n=${encodeURIComponent(raw)}`), bad.res, "n", kind), null);
    assert.equal(bad.captured.status, 400, `expected a 400 for ${raw}`);
    assert.match(bad.captured.body, /n must be a (positive|non-negative) integer \(got /);
    // The offending spelling rides in the message JSON-encoded, so its quotes are escaped:
    // compare against the inner value with its own quotes stripped.
    assert.ok(
      bad.captured.body.includes(JSON.stringify(raw).slice(1, -1)),
      `expected the raw spelling ${raw} echoed in ${bad.captured.body}`,
    );
  }
});

test("windowDays degrades a missing or non-decimal window to the default, clamping the range", () => {
  assert.equal(windowDays(new URLSearchParams("")), REPORT_DEFAULT_DAYS);
  assert.equal(windowDays(new URLSearchParams("days=abc")), REPORT_DEFAULT_DAYS);
  assert.equal(windowDays(new URLSearchParams("days=1e3")), REPORT_DEFAULT_DAYS);
  assert.equal(windowDays(new URLSearchParams("days=-5")), REPORT_DEFAULT_DAYS);
  assert.equal(windowDays(new URLSearchParams("days=0")), 1);
  assert.equal(windowDays(new URLSearchParams("days=3")), 3);
  assert.equal(windowDays(new URLSearchParams(`days=${REPORT_MAX_DAYS + 500}`)), REPORT_MAX_DAYS);
});

test("requirePromptText returns the text for a valid body, untrimmed", () => {
  const { res } = fakeRes();
  assert.equal(requirePromptText(res, { text: "  ship it  " }), "  ship it  ");
});

test("requirePromptText rejects a non-string, a blank string, and an over-long prompt", () => {
  const missing = fakeRes();
  assert.equal(requirePromptText(missing.res, {}), null);
  assert.equal(missing.captured.status, 400);
  assert.match(missing.captured.body, /"error":"text must be a string"/);

  const nonString = fakeRes();
  assert.equal(requirePromptText(nonString.res, { text: 42 }), null);
  assert.equal(nonString.captured.status, 400);
  assert.match(nonString.captured.body, /text must be a string \(got 42\)/);

  const blank = fakeRes();
  assert.equal(requirePromptText(blank.res, { text: "   " }), null);
  assert.equal(blank.captured.status, 400);
  assert.match(blank.captured.body, /"error":"text required"/);

  const tooLong = fakeRes();
  const long = "x".repeat(DIRECTOR_PROMPT_MAX_CHARS + 1);
  assert.equal(requirePromptText(tooLong.res, { text: long }), null);
  assert.equal(tooLong.captured.status, 400);
  assert.match(tooLong.captured.body, /shorten it to at most /);
});

test("requirePromptText carries a custom role into the over-long message", () => {
  const { res, captured } = fakeRes();
  const long = "x".repeat(DIRECTOR_PROMPT_MAX_CHARS + 1);
  assert.equal(requirePromptText(res, { text: long }, "feature"), null);
  assert.match(captured.body, /into the feature tick's prefill/);
});

test("requirePausedFlag returns an explicit boolean and rejects everything else", () => {
  const okTrue = fakeRes();
  assert.equal(requirePausedFlag(okTrue.res, { paused: true }), true);
  const okFalse = fakeRes();
  assert.equal(requirePausedFlag(okFalse.res, { paused: false }), false);
  assert.equal(okTrue.captured.status, undefined);
  assert.equal(okFalse.captured.status, undefined);

  const missing = fakeRes();
  assert.equal(requirePausedFlag(missing.res, {}), null);
  assert.equal(missing.captured.status, 400);
  assert.match(missing.captured.body, /"error":"paused must be a boolean"/);

  const stringy = fakeRes();
  assert.equal(requirePausedFlag(stringy.res, { paused: "true" }), null);
  assert.equal(stringy.captured.status, 400);
  assert.ok(
    stringy.captured.body.includes('got \\"true\\"'),
    `expected the offending value echoed in ${stringy.captured.body}`,
  );
});
