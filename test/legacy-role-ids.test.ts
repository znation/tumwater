import { test } from "node:test";
import assert from "node:assert/strict";
import { LEGACY_ROLE_IDS, canonicalRoleId, legacyRoleIdsOf, roleCommitGrep } from "../src/roles/legacy-role-ids.js";
import { canonicalConfigKey, normalizeConfigKeys } from "../src/config/config-aliases.js";
import { searchGuidance } from "../src/roles/role-guidance.js";

const legacy = { oldy: "newy" };

test("canonicalRoleId maps an old id and leaves others alone", () => {
  assert.equal(canonicalRoleId("oldy", legacy), "newy");
  assert.equal(canonicalRoleId("newy", legacy), "newy");
  assert.equal(canonicalRoleId("toString", legacy), "toString");
});

test("legacyRoleIdsOf lists the old ids of a new id", () => {
  assert.deepEqual(legacyRoleIdsOf("newy", legacy), ["oldy"]);
  assert.deepEqual(legacyRoleIdsOf("other", legacy), []);
});

test("roleCommitGrep holds one --grep per id", () => {
  assert.equal(roleCommitGrep("newy", legacy), '--grep="tumwater(newy)" --grep="tumwater(oldy)"');
  assert.equal(roleCommitGrep("other", legacy), '--grep="tumwater(other)"');
});

test("normalizeConfigKeys moves old role ids in all three maps and lists each move", () => {
  const out = normalizeConfigKeys(
    { roles: { oldy: { model: "m" } }, maxDailyCostUsdPerRole: { oldy: 1 }, quietHoursPerRole: { oldy: "1-2" } },
    legacy,
  );
  assert.deepEqual(out.raw, {
    roles: { newy: { model: "m" } },
    maxDailyCostUsdPerRole: { newy: 1 },
    quietHoursPerRole: { newy: "1-2" },
  });
  assert.deepEqual(out.renamed, [
    "roles.oldy → roles.newy",
    "maxDailyCostUsdPerRole.oldy → maxDailyCostUsdPerRole.newy",
    "quietHoursPerRole.oldy → quietHoursPerRole.newy",
  ]);
  assert.deepEqual(out.problems, []);
});

test("normalizeConfigKeys refuses a file holding both ids", () => {
  const input = { roles: { oldy: {}, newy: {} } };
  const out = normalizeConfigKeys(input, legacy);
  assert.deepEqual(out.problems, ["sets both roles.oldy and roles.newy — keep roles.newy (oldy is its old id)"]);
  assert.deepEqual(out.renamed, []);
  assert.deepEqual(out.raw, input);
});

test("canonicalConfigKey maps an old role id in a dotted key", () => {
  assert.equal(canonicalConfigKey("roles.oldy.model", legacy), "roles.newy.model");
  assert.equal(canonicalConfigKey("maxDailyCostUsdPerRole.oldy", legacy), "maxDailyCostUsdPerRole.newy");
  assert.equal(canonicalConfigKey("roles.newy.model", legacy), "roles.newy.model");
});

test("with the real, empty table every function is the identity", () => {
  assert.deepEqual(LEGACY_ROLE_IDS, {});
  assert.equal(canonicalRoleId("dry"), "dry");
  assert.deepEqual(legacyRoleIdsOf("dry"), []);
  assert.equal(roleCommitGrep("dry"), '--grep="tumwater(dry)"');
  const cfg = { roles: { dry: {} } };
  assert.deepEqual(normalizeConfigKeys(cfg), { raw: cfg, renamed: [], problems: [] });
  assert.equal(canonicalConfigKey("roles.dry.model"), "roles.dry.model");
  assert.ok(searchGuidance("dry").includes('--grep="tumwater(dry)"'));
});
