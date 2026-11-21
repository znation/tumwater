import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredRoleIds,
  rejectBadRole,
  rejectBadQueueFileName,
  intQuery,
  windowDays,
  requirePromptText,
  requirePausedFlag,
} from "../src/gui/gui-args.js";
import { DIRECTOR_PROMPT_MAX_CHARS } from "../src/inbox/inbox-submit.js";
import { WINDOW_DAY_CASES } from "./fixtures/window-days.js";
import { allRoleIds, DIRECTOR_ROLE } from "../src/roles/roles.js";
import { tmpdir, writeConfig, writeMalformedJson } from "./fixtures/repo-fixtures.js";
import { loadConfig, knownRoleIdsCached } from "../src/config/config.js";
import { writeJsonAtomic } from "../src/files/json-files.js";
import { configPath } from "../src/paths.js";
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

// The write-side all-roles default (POST /api/wake and /api/reset-counters with a `{}` body) must
// be the config's own role list — the base ids a custom role joins — never the instance ids the
// read-only accepted-id list adds. A marker naming a base role already reaches every instance of
// it while the team is live (operator-requests.ts's roleRequestTargets matches on baseRole).
test("configuredRoleIds is the configured role list, not the instance ids validRoleIds adds", () => {
  const root = tmpdir();
  writeConfig(root, { customRoles: [{ name: "docs-auditor", task: "t" }] });
  const expected = Object.keys(loadConfig(root).roles);
  assert.deepEqual(configuredRoleIds(root), expected, "exactly tumwater.json's roles section");
  assert.ok(expected.includes("docs-auditor"), "a custom role is a configured role");
  // The shipped default runs feature-2 … feature-6, and the read-only list accepts them; this
  // writer's list names none of them.
  assert.ok(loadConfig(root).roles.feature!.instances === undefined);
  assert.ok(configuredRoleIds(root).every((id) => !id.startsWith("feature-")), "no instance ids");
  assert.ok(
    configuredRoleIds(root).length < knownRoleIdsCached(root).length,
    "the accepted-id list is the wider one",
  );
  // A hand-written count changes nothing about the shape: still base ids only.
  writeJsonAtomic(configPath(root), { roles: { feature: { instances: 3 }, bugfix: { instances: 1 } } });
  assert.deepEqual(configuredRoleIds(root), expected.filter((id) => id !== "docs-auditor"));
  assert.ok(configuredRoleIds(root).every((id) => !id.startsWith("feature-")));
  // A broken tumwater.json has no configured list: the built-in catalog, never a throw.
  writeMalformedJson(configPath(root));
  assert.deepEqual(configuredRoleIds(root), allRoleIds());
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
  for (const [query, expected] of WINDOW_DAY_CASES) {
    assert.equal(windowDays(new URLSearchParams(query)), expected, query);
  }
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
  assert.match(captured.body, /into the feature run's prefill/);
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

// rejectBadQueueFileName is the file-addressed twin of rejectBadRole: the three guarded
// endpoints share it, so its accept/refuse contract and 400 wording have one home to pin.
test("rejectBadQueueFileName accepts a plain .md basename and lets the request through", () => {
  const { res, captured } = fakeRes();
  assert.equal(rejectBadQueueFileName(res, "1700000000000-1-100.md"), false);
  assert.equal(captured.status, undefined);
  assert.equal(captured.body, "");
});

test("rejectBadQueueFileName refuses each unsafe shape with the shared 400", () => {
  for (const [name, phrase] of [
    ["../secret.md", "plain queue-file basename"],
    ["sub/dir.md", "plain queue-file basename"],
    ["prompt.txt", "inbox message's .md file"],
    [undefined, "file required"],
  ] as const) {
    const { res, captured } = fakeRes();
    assert.equal(rejectBadQueueFileName(res, name), true);
    assert.equal(captured.status, 400);
    assert.ok(
      captured.body.includes(phrase),
      `expected ${JSON.stringify(phrase)} for ${String(name)}, got ${captured.body}`,
    );
  }
});
