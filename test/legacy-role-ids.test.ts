import { test } from "node:test";
import assert from "node:assert/strict";
import { LEGACY_ROLE_IDS, canonicalRoleId, legacyRoleIdsOf, roleCommitGrep } from "../src/roles/legacy-role-ids.js";
import { canonicalConfigKey, normalizeConfigKeys } from "../src/config/config-aliases.js";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { loadConfig } from "../src/config/config.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
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

test("the real table maps dry to dedupe", () => {
  assert.deepEqual(LEGACY_ROLE_IDS, { dry: "dedupe", telemetry: "selfcheck" });
  assert.equal(canonicalRoleId("dry"), "dedupe");
  assert.equal(canonicalRoleId("dedupe"), "dedupe");
  assert.deepEqual(legacyRoleIdsOf("dedupe"), ["dry"]);
  assert.equal(roleCommitGrep("dedupe"), '--grep="tumwater(dedupe)" --grep="tumwater(dry)"');
  assert.equal(roleCommitGrep("clean"), '--grep="tumwater(clean)"');
  assert.deepEqual(normalizeConfigKeys({ roles: { dry: {} } }).renamed, ["roles.dry → roles.dedupe"]);
  assert.equal(canonicalConfigKey("roles.dry.model"), "roles.dedupe.model");
  assert.ok(searchGuidance("dedupe").includes('--grep="tumwater(dry)"'));
});

// --- end to end through the real CLI

test("tumwater role dry shows dedupe, like tumwater role dedupe", async () => {
  const repo = makeRepo();
  await initProject(repo, "legacy role id role view");
  const viaNew = await cli(repo, "role", "dedupe");
  const viaOld = await cli(repo, "role", "dry");
  assert.equal(viaNew.code, 0);
  assert.match(viaNew.stdout, /duplication remover/);
  assert.equal(viaOld.code, 0);
  assert.equal(viaOld.stdout, viaNew.stdout);
});

test("history --role dry lists dedupe's runs, and an old event source reads as dedupe", async () => {
  const repo = makeRepo();
  await initProject(repo, "legacy role id history");
  writeEvents(repo, [
    { ts: Date.now() - 60_000, loop: "dry", type: "run_start", run: 1 },
    { ts: Date.now() - 30_000, loop: "dry", type: "run_end", run: 1, result: "changed", summary: "merged copies" },
  ]);
  const r = await cli(repo, "history", "--role", "dry");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /dedupe/);
  assert.match(r.stdout, /merged copies/);
});

test("roles.dry.enabled: false disables dedupe, and doctor names the rename", async () => {
  const repo = makeRepo();
  await initProject(repo, "legacy role id config");
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify({ roles: { dry: { enabled: false } } }));
  const cfg = loadConfig(repo);
  assert.equal(cfg.roles.dedupe!.enabled, false);
  assert.equal(cfg.roles.dry, undefined);
  const r = await cli(repo, "doctor");
  assert.match(r.stdout, /roles\.dry → roles\.dedupe/);
});

test("roles.telemetry.enabled: true enables selfcheck, and doctor names the rename", async () => {
  const repo = makeRepo();
  await initProject(repo, "legacy telemetry config");
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify({ roles: { telemetry: { enabled: true } } }));
  const cfg = loadConfig(repo);
  assert.equal(cfg.roles.selfcheck!.enabled, true);
  assert.equal(cfg.roles.telemetry, undefined);
  const r = await cli(repo, "doctor");
  assert.match(r.stdout, /roles\.telemetry → roles\.selfcheck/);
  assert.equal(roleCommitGrep("selfcheck"), '--grep="tumwater(selfcheck)" --grep="tumwater(telemetry)"');
});
