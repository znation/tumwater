// The `tumwater role` writes that hold a role back (see cli-operators.test.ts for the split):
// --quiet-hours, --cap and --min-run-interval, each set and cleared in tumwater.json.

import test from "node:test";
import { readJson } from "./helpers/json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import type { TeamConfigFile } from "./fixtures/config-fixtures.js";

test("role --quiet-hours and --clear-quiet-hours write the role's quiet hours", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role quiet hours");
  const config = () => readJson<TeamConfigFile>(path.join(repo, "tumwater.json"));

  // `--quiet-hours <window>` writes quietHoursPerRole.feature through the config core.
  let r = await cli(repo, "role", "feature", "--quiet-hours", "23:00-07:00");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: quiet hours set to 23:00-07:00/);
  assert.equal(config().quietHoursPerRole.feature, "23:00-07:00");

  // The rendered view and --json carry the resolved window.
  r = await cli(repo, "role", "feature");
  assert.match(r.stdout, /- Quiet hours: 23:00-07:00/);
  r = await cli(repo, "role", "feature", "--json");
  assert.match(r.stdout, /"23:00-07:00"/);

  // An instance id targets its base role: feature-2 writes quietHoursPerRole.feature.
  const configured = readJson<TeamConfigFile>(path.join(repo, "tumwater.json"));
  configured.roles = { ...configured.roles, feature: { ...configured.roles.feature, instances: 2 } };
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(configured, null, 2));
  r = await cli(repo, "role", "feature-2", "--quiet-hours", "22:00-06:00");
  assert.equal(r.code, 0);
  assert.equal(config().quietHoursPerRole.feature, "22:00-06:00");

  // A clear removes the key; `--quiet-hours ""` and a whitespace-only value clear it too
  // (empty means off, the config's own reading), and a clear writes nothing when unset.
  r = await cli(repo, "role", "feature", "--clear-quiet-hours");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: quiet hours cleared/);
  assert.equal(config().quietHoursPerRole, undefined);
  const bytesAfterClear = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "feature", "--clear-quiet-hours");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: quiet hours is not set in tumwater.json, so nothing was cleared/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), bytesAfterClear, "clearing an unset key writes nothing");
  r = await cli(repo, "role", "feature", "--quiet-hours", "");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: quiet hours is not set in tumwater.json, so nothing was cleared/);
  assert.equal(config().quietHoursPerRole, undefined);
  r = await cli(repo, "role", "feature", "--quiet-hours", "   ");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: quiet hours is not set in tumwater.json, so nothing was cleared/);
  assert.equal(config().quietHoursPerRole, undefined);

  // A malformed window fails with checkQuietHours's message naming the key, leaving the
  // file unchanged; the director and an unknown id are refused.
  const before = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  for (const bad of ["nope", "23:00", "23:00-23:00"]) {
    r = await cli(repo, "role", "feature", "--quiet-hours", bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /quietHoursPerRole.feature/);
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, `file unchanged on ${bad}`);
  }
  r = await cli(repo, "role", "director", "--quiet-hours", "23:00-07:00");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the director has no quiet hours/);
  r = await cli(repo, "role", "bogus", "--quiet-hours", "23:00-07:00");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);

  // Mutually exclusive or inapplicable flags are refused and write nothing.
  r = await cli(repo, "role", "feature", "--clear-quiet-hours", "--quiet-hours", "x");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --clear-quiet-hours or --quiet-hours, not both/);
  r = await cli(repo, "role", "feature", "--quiet-hours", "x", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to a quiet-hours write/);
  r = await cli(repo, "role", "feature", "--quiet-hours", "x", "--clear-notes");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /notes and quiet-hours writes cannot share one invocation/);
  r = await cli(repo, "role", "feature", "--quiet-hours", "x", "--instructions-file", "y");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /instructions and quiet-hours writes cannot share one invocation/);
  assert.equal(config().quietHoursPerRole, undefined, "no write from the refused invocations");
});

test("role --cap/--clear-cap and --min-run-interval/--clear-min-run-interval write the role's holds", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role cap and interval");
  const config = () => readJson<TeamConfigFile>(path.join(repo, "tumwater.json"));

  // `--cap <usd>` writes maxDailyCostUsdPerRole.feature through the config core.
  let r = await cli(repo, "role", "feature", "--cap", "5");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: daily cap set to 5/);
  assert.equal(config().maxDailyCostUsdPerRole.feature, 5);

  // A leading-dot decimal — the `.5` shorthand both cap editors admit — lands as the same
  // number the editors store, not the literal string JSON.parse would otherwise read.
  r = await cli(repo, "role", "feature", "--cap", ".5");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: daily cap set to \.5/);
  assert.equal(config().maxDailyCostUsdPerRole.feature, 0.5);

  // The leading-zero and leading-dot-with-leading-zero spellings the cap editors also admit
  // (`05`, `00.5`) land as the same numbers via Number(), not literal strings.
  r = await cli(repo, "role", "feature", "--cap", "05");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: daily cap set to 05/);
  assert.equal(config().maxDailyCostUsdPerRole.feature, 5);
  r = await cli(repo, "role", "feature", "--cap", "00.5");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: daily cap set to 00\.5/);
  assert.equal(config().maxDailyCostUsdPerRole.feature, 0.5);

  // `--min-run-interval <seconds>` writes roles.feature.minRunIntervalSeconds.
  r = await cli(repo, "role", "feature", "--min-run-interval", "300");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: min run interval set to 300s/);
  assert.equal(config().roles.feature.minRunIntervalSeconds, 300);

  // The same plain-decimal shorthand its editors admit (`05`) lands as the number, too.
  r = await cli(repo, "role", "feature", "--min-run-interval", "05");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: min run interval set to 05s/);
  assert.equal(config().roles.feature.minRunIntervalSeconds, 5);

  // An instance id targets its base role: feature-2 writes the .feature keys.
  const configured = readJson<TeamConfigFile>(path.join(repo, "tumwater.json"));
  configured.roles = { ...configured.roles, feature: { ...configured.roles.feature, instances: 2 } };
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(configured, null, 2));
  r = await cli(repo, "role", "feature-2", "--cap", "5");
  assert.equal(r.code, 0);
  assert.equal(config().maxDailyCostUsdPerRole.feature, 5);
  r = await cli(repo, "role", "feature-2", "--min-run-interval", "300");
  assert.equal(r.code, 0);
  assert.equal(config().roles.feature.minRunIntervalSeconds, 300);

  // `0` is a real value (it disables the cap / allows back-to-back runs), so it sets, not clears.
  r = await cli(repo, "role", "feature", "--cap", "0");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: daily cap set to 0/);
  assert.equal(config().maxDailyCostUsdPerRole.feature, 0);
  r = await cli(repo, "role", "feature", "--min-run-interval", "0");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: min run interval set to 0s/);
  assert.equal(config().roles.feature.minRunIntervalSeconds, 0);

  // A clear removes the key; `--cap ""` and a whitespace-only value clear it too, and a
  // clear writes nothing when unset.
  r = await cli(repo, "role", "feature", "--clear-cap");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: daily cap cleared/);
  assert.equal(config().maxDailyCostUsdPerRole, undefined);
  const bytesAfterCapClear = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "feature", "--clear-cap");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: daily cap is not set in tumwater.json, so nothing was cleared/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), bytesAfterCapClear, "clearing an unset key writes nothing");
  r = await cli(repo, "role", "feature", "--min-run-interval", "");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: min run interval cleared/);
  assert.equal(config().roles.feature.minRunIntervalSeconds, undefined);
  r = await cli(repo, "role", "feature", "--clear-min-run-interval");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: min run interval is not set in tumwater.json, so nothing was cleared/);
  assert.equal(config().roles.feature.minRunIntervalSeconds, undefined);

  // A malformed cap fails with checkDailyBudgetUsd's message naming the key, leaving the
  // file unchanged; a malformed interval fails with validateConfig's message.
  const before = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  for (const bad of ["-1", "abc"]) {
    r = await cli(repo, "role", "feature", "--cap", bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /maxDailyCostUsdPerRole.feature/);
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, `file unchanged on ${bad}`);
  }

  // An exponent spelling like "1e2" is itself a JSON number (100), so it would silently write 100
  // past plainDecimalToJson and checkDailyBudgetUsd alike — exactly the misread the TUI Ctrl+B
  // budget editor and the GUI cap drawer now refuse, so the CLI refuses it too, naming the key and
  // leaving the file unchanged. Hex and negative spellings stay on the write path's own refusal.
  for (const bad of ["1e2", "0.5e2"]) {
    r = await cli(repo, "role", "feature", "--cap", bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /maxDailyCostUsdPerRole.feature/);
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, `file unchanged on ${bad}`);
  }
  for (const bad of ["-1", "2147484", "abc"]) {
    r = await cli(repo, "role", "feature", "--min-run-interval", bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /roles\.feature\.minRunIntervalSeconds/);
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, `file unchanged on ${bad}`);
  }

  // An exponent spelling like "1e2" is itself a JSON number (100), so it would silently write
  // 100 past plainDecimalToJson and validateConfig alike — exactly the misread the TUI Ctrl+S
  // editor and the GUI interval drawer now refuse, so the CLI refuses it too, naming the key and
  // leaving the file unchanged. Hex and negative spellings stay on the write path's own refusal.
  for (const bad of ["1e2", "0.5e2"]) {
    r = await cli(repo, "role", "feature", "--min-run-interval", bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /roles\.feature\.minRunIntervalSeconds/);
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, `file unchanged on ${bad}`);
  }

  // The director's cap is refused (it has none) but its min-run-interval is accepted.
  r = await cli(repo, "role", "director", "--cap", "5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the director has no daily cap/);
  r = await cli(repo, "role", "director", "--clear-cap");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the director has no daily cap/);
  r = await cli(repo, "role", "director", "--min-run-interval", "60");
  assert.equal(r.code, 0);
  assert.equal(config().roles.director.minRunIntervalSeconds, 60);

  // An unknown id is refused for both, writing nothing.
  r = await cli(repo, "role", "bogus", "--cap", "5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);
  r = await cli(repo, "role", "bogus", "--min-run-interval", "60");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);

  // Mutually exclusive or inapplicable flags are refused and write nothing.
  r = await cli(repo, "role", "feature", "--clear-cap", "--cap", "5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --clear-cap or --cap, not both/);
  r = await cli(repo, "role", "feature", "--clear-min-run-interval", "--min-run-interval", "60");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --clear-min-run-interval or --min-run-interval, not both/);
  r = await cli(repo, "role", "feature", "--cap", "5", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to a cap write/);
  r = await cli(repo, "role", "feature", "--min-run-interval", "60", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to a min-run-interval write/);
  r = await cli(repo, "role", "feature", "--cap", "5", "--min-run-interval", "60");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cap and min-run-interval writes cannot share one invocation/);
  r = await cli(repo, "role", "feature", "--cap", "5", "--clear-notes");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /notes and cap writes cannot share one invocation/);
  const afterRefusals = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  assert.equal(JSON.parse(afterRefusals).maxDailyCostUsdPerRole, undefined, "no cap write from the refused invocations");
});
