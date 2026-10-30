// The `tumwater role` writes that pick a role's model (see cli-operators.test.ts for the
// split): --provider/--model/--thinking and --backend, each set and cleared in tumwater.json.

import test from "node:test";
import { readJson } from "./helpers/json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import type { RoleKeys, TeamConfigFile } from "./fixtures/config-fixtures.js";

test("role --provider/--model/--thinking (and --clear-*) write the role's model triple", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role model triple");
  const config = () => readJson<TeamConfigFile>(path.join(repo, "tumwater.json"));

  // `--model <id>` writes roles.feature.model through the config core.
  let r = await cli(repo, "role", "feature", "--model", "anthropic/claude-sonnet-4");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: model set to anthropic\/claude-sonnet-4/);
  assert.equal(config().roles.feature.model, "anthropic/claude-sonnet-4");

  // The same model again is reported as already set and writes nothing.
  const beforeSame = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "feature", "--model", "anthropic/claude-sonnet-4");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: model is already anthropic\/claude-sonnet-4, so tumwater.json was not written/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), beforeSame);

  // A misspelled tier name refuses and leaves the file untouched (no legacy provider is set yet).
  const beforeTypo = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "feature", "--model", "strnog");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /roles\.feature\.model "strnog" is not a tier name .* did you mean `strong`/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), beforeTypo);

  // `--provider <id>` and `--thinking <level>` write the other two fields.
  r = await cli(repo, "role", "feature", "--provider", "openai");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: provider set to openai/);
  assert.equal(config().roles.feature.provider, "openai");
  r = await cli(repo, "role", "feature", "--thinking", "high");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: thinking set to high/);
  assert.equal(config().roles.feature.thinking, "high");

  // A tier name stores the string (a tier reference, valid for roles.<id>.model).
  r = await cli(repo, "role", "feature", "--model", "strong");
  assert.equal(r.code, 0);
  assert.equal(config().roles.feature.model, "strong");

  // An instance id targets its base role: feature-2 writes roles.feature.*.
  const configured = readJson<TeamConfigFile>(path.join(repo, "tumwater.json"));
  configured.roles = { ...configured.roles, feature: { ...configured.roles.feature, instances: 2 } };
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(configured, null, 2));
  r = await cli(repo, "role", "feature-2", "--model", "gpt-5");
  assert.equal(r.code, 0);
  assert.equal(config().roles.feature.model, "gpt-5");
  r = await cli(repo, "role", "feature-2", "--provider", "anthropic");
  assert.equal(r.code, 0);
  assert.equal(config().roles.feature.provider, "anthropic");
  r = await cli(repo, "role", "feature-2", "--thinking", "low");
  assert.equal(r.code, 0);
  assert.equal(config().roles.feature.thinking, "low");

  // Two model-triple writes cannot share one invocation, and write nothing.
  const beforeShare = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "feature", "--model", "anthropic/x", "--provider", "y");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /provider and model writes cannot share one invocation/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), beforeShare, "no write from a shared invocation");

  // A clear removes each key; `--X ""` and whitespace-only values clear too, and a clear
  // writes nothing when unset.
  for (const [flag, clearFlag, field] of [
    ["--model", "--clear-model", "model"],
    ["--provider", "--clear-provider", "provider"],
    ["--thinking", "--clear-thinking", "thinking"],
  ] as const) {
    r = await cli(repo, "role", "feature", clearFlag);
    assert.equal(r.code, 0, field);
    assert.match(r.stdout, new RegExp(`feature: ${field} cleared`));
    assert.equal(config().roles.feature[field], undefined, `${field} cleared`);
    const bytes = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
    r = await cli(repo, "role", "feature", clearFlag);
    assert.equal(r.code, 0, field);
    assert.match(r.stdout, new RegExp(`feature: ${field} is not set in tumwater.json, so nothing was cleared`));
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), bytes, `${field} clear of an unset key writes nothing`);
    r = await cli(repo, "role", "feature", flag, "");
    assert.equal(r.code, 0, field);
    assert.match(r.stdout, new RegExp(`feature: ${field} is not set in tumwater.json, so nothing was cleared`));
    r = await cli(repo, "role", "feature", flag, "   ");
    assert.equal(r.code, 0, field);
    assert.match(r.stdout, new RegExp(`feature: ${field} is not set in tumwater.json, so nothing was cleared`));
  }

  // A malformed thinking level fails with checkModelTripleField's message naming the key and
  // naming THINKING_LEVELS, leaving the file unchanged.
  const before = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "feature", "--thinking", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /roles\.feature\.thinking must be one of off, minimal, low, medium, high, xhigh, max \(got "bogus"\)/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, "file unchanged on bogus thinking");

  // An unknown id is refused for any of the three, writing nothing.
  r = await cli(repo, "role", "bogus", "--model", "gpt-5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);
  r = await cli(repo, "role", "bogus", "--provider", "openai");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);
  r = await cli(repo, "role", "bogus", "--thinking", "high");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);

  // --json is refused with any of the three writes.
  r = await cli(repo, "role", "feature", "--model", "gpt-5", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to a model write/);
  r = await cli(repo, "role", "feature", "--provider", "openai", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to a provider write/);
  r = await cli(repo, "role", "feature", "--thinking", "high", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to a thinking write/);

  // --clear-X alongside --X is refused.
  r = await cli(repo, "role", "feature", "--clear-model", "--model", "gpt-5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --clear-model or --model, not both/);
  r = await cli(repo, "role", "feature", "--clear-provider", "--provider", "openai");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --clear-provider or --provider, not both/);
  r = await cli(repo, "role", "feature", "--clear-thinking", "--thinking", "high");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --clear-thinking or --thinking, not both/);
  // A model-triple write combined with another role write is refused, naming both kinds.
  r = await cli(repo, "role", "feature", "--model", "gpt-5", "--cap", "5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cap and model writes cannot share one invocation/);
  // All the refusals above left the file unchanged (it still holds the cleared state).
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, "file unchanged after all refusals");

  // The director's model-triple writes are accepted (configForRole resolves roles.director.*).
  r = await cli(repo, "role", "director", "--model", "opus-4");
  assert.equal(r.code, 0);
  assert.equal(config().roles.director.model, "opus-4");
  r = await cli(repo, "role", "director", "--provider", "anthropic");
  assert.equal(r.code, 0);
  assert.equal(config().roles.director.provider, "anthropic");
  r = await cli(repo, "role", "director", "--thinking", "medium");
  assert.equal(r.code, 0);
  assert.equal(config().roles.director.thinking, "medium");
});

test("role --backend writes and clears the backend override", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role backend override");
  const config = () => readJson<TeamConfigFile & { roles: Record<string, RoleKeys> }>(path.join(repo, "tumwater.json"));

  // `--backend <id>` writes roles.qa.backend through the config core; a role with no model
  // override accepts a backend alone (checkEntryBackend's pair rule needs a non-tier model).
  let r = await cli(repo, "role", "qa", "--backend", "claude");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /qa: backend set to claude/);
  assert.equal(config().roles.qa!.backend, "claude");

  // An instance id targets its base role: feature-2 writes roles.feature.backend.
  const configured = readJson<TeamConfigFile>(path.join(repo, "tumwater.json"));
  configured.roles = { ...configured.roles, feature: { ...configured.roles.feature, instances: 2 } };
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(configured, null, 2));
  r = await cli(repo, "role", "feature-2", "--backend", "codex");
  assert.equal(r.code, 0);
  assert.equal(config().roles.feature.backend, "codex");

  // A backend that cannot pair with the role's model is refused by checkEntryBackend, leaving
  // the file unchanged.
  r = await cli(repo, "role", "feature", "--model", "anthropic/claude-sonnet-4");
  assert.equal(r.code, 0);
  const beforeBadPair = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "feature", "--backend", "claude");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /roles\.feature\.model "anthropic\/claude-sonnet-4" has a "\/" but roles\.feature\.backend is "claude"/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), beforeBadPair, "file unchanged on a clashing backend model pair");

  // A bad backend id is refused with the backend-list message and writes nothing.
  const beforeBad = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "qa", "--backend", "claud");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /roles\.qa\.backend must name a backend \(pi, claude, opencode, codex; got "claud"\)/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), beforeBad, "file unchanged on a bad backend id");

  // --backend with --clear-backend, or with --json, is refused.
  r = await cli(repo, "role", "qa", "--clear-backend", "--backend", "codex");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --clear-backend or --backend, not both/);
  r = await cli(repo, "role", "qa", "--backend", "codex", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to a backend write/);

  // A clear removes the key; clearing an unset key writes nothing.
  r = await cli(repo, "role", "qa", "--clear-backend");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /qa: backend cleared/);
  assert.equal(config().roles.qa!.backend, undefined);
  const bytes = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "qa", "--clear-backend");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /qa: backend is not set in tumwater.json, so nothing was cleared/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), bytes, "clear of an unset backend writes nothing");
});
