// The `tumwater role` slice of the operator commands (see cli-operators.test.ts for the split):
// the read-only view, the notes and instructions writes, and the refusals every role write
// shares. The other role writes live in cli-operators-role-holds.test.ts,
// cli-operators-role-roster.test.ts and cli-operators-role-model.test.ts.

import test from "node:test";
import { readJson } from "./helpers/json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { roleNotesPath } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { queuedRolePromptCount } from "../src/inbox/inbox.js";
import { cli, CLI } from "./helpers/cli-harness.js";
import { spawnSync } from "node:child_process";
import type { TeamConfigFile } from "./fixtures/config-fixtures.js";

// --- role <id>: one role's standing prompt and resolved settings (read-only) ---
// Like backlog, the command gates on nothing: its collector degrades to empty answers on a
// missing read, so it works with the team stopped. The queue-survival assertion here is the
// end-to-end half of the preview seam's contract (test/role-view.test.ts and
// test/run-prompt.test.ts pin the unit halves): an inspection must never consume a queued
// prompt.

test("role prints one role's standing prompt, and a queued prompt survives inspection", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role inspection");

  let r = await cli(repo, "role", "feature");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /# tumwater role: feature/);
  assert.match(r.stdout, /Implement the SINGLE most valuable planned feature in PLANS\.md/); // the find text, verbatim
  assert.match(r.stdout, /## Next run's prompt/);

  // A queued per-role prompt appears inside the previewed next prompt AND survives — two
  // inspections in a row both show it, and the queue file count is unchanged.
  r = await cli(repo, "prompt", "--role", "feature", "check the scheduler first");
  assert.equal(r.code, 0);
  r = await cli(repo, "role", "feature");
  assert.match(r.stdout, /check the scheduler first/);
  r = await cli(repo, "role", "feature");
  assert.match(r.stdout, /check the scheduler first/);
  assert.equal(queuedRolePromptCount(repo, "feature"), 1);

  // --json prints the collector's own payload as one JSON document, not a re-parse of the
  // render — the same shape the Markdown branch consumed.
  r = await cli(repo, "role", "feature", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { id: string; nextPrompt: string; title: string };
  assert.equal(payload.id, "feature");
  assert.equal(payload.title, "feature implementer");
  assert.match(payload.nextPrompt, /check the scheduler first/);
});

test("role --clear-notes and --notes-file write the role's notes", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role notes");
  const notes = roleNotesPath(repo, "feature");
  const file = path.join(repo, "n.md");
  fs.writeFileSync(file, "use team.ts");

  let r = await cli(repo, "role", "feature", "--notes-file", file);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: notes saved/);
  assert.equal(fs.readFileSync(notes, "utf8"), "use team.ts");
  r = await cli(repo, "role", "feature");
  assert.match(r.stdout, /use team\.ts/);

  fs.writeFileSync(notes, "old");
  r = await cli(repo, "role", "--notes-file", file, "feature");
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(notes, "utf8"), "use team.ts");

  const big = path.join(repo, "big.md");
  fs.writeFileSync(big, "x".repeat(4097));
  r = await cli(repo, "role", "feature", "--notes-file", big);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /shorten it to at most 4096 bytes/);
  assert.equal(fs.readFileSync(notes, "utf8"), "use team.ts");

  r = await cli(repo, "role", "feature", "--clear-notes");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: notes cleared/);
  assert.equal(fs.readFileSync(notes, "utf8"), "");
  r = await cli(repo, "role", "feature", "--json");
  assert.equal((JSON.parse(r.stdout) as { notes: string | null }).notes, null);

  for (const [args, msg] of [
    [["feature", "--clear-notes", "--notes-file", "x"], /not both/],
    [["feature", "--clear-notes", "--json"], /--json does not apply/],
    [["director", "--clear-notes"], /director has no notes/],
    [["bogus", "--clear-notes"], /unknown role: bogus/],
  ] as const) {
    r = await cli(repo, "role", ...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, msg);
  }
});

test("role --clear-instructions and --instructions-file write the role's instructions", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role instructions");
  const config = () => readJson<TeamConfigFile>(path.join(repo, "tumwater.json"));

  // Literal storage: a file whose whole content is `123` must stay the string "123" (the
  // JSON.stringify wrapper beats setConfigKey's JSON-parse fallback, which would re-type it).
  const file = path.join(repo, "inst.md");
  fs.writeFileSync(file, "123");
  let r = await cli(repo, "role", "feature", "--instructions-file", file);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: instructions saved \(3 chars\)/);
  assert.equal(config().roles.feature.instructions, "123");

  // The rendered view and --json carry the override.
  r = await cli(repo, "role", "feature", "--json");
  assert.equal(JSON.parse(r.stdout).instructions, "123");
  r = await cli(repo, "role", "feature");
  assert.match(r.stdout, /## Instructions override/);

  // `--instructions-file -` reads the text from stdin.
  const stdin = spawnSync(process.execPath, [CLI, "role", "feature", "--instructions-file", "-"], {
    cwd: repo, timeout: 20_000, input: "use src/team.ts\n", encoding: "utf8",
  });
  assert.equal(stdin.status, 0, stdin.stderr);
  assert.equal(config().roles.feature.instructions, "use src/team.ts\n");

  // Over the 4096-char cap the config validator refuses and leaves the file unchanged.
  const big = path.join(repo, "big.md");
  fs.writeFileSync(big, "x".repeat(4097));
  r = await cli(repo, "role", "feature", "--instructions-file", big);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /at most 4096/);
  assert.equal(config().roles.feature.instructions, "use src/team.ts\n");

  // An instance id targets its base role: feature-2 writes roles.feature.instructions.
  // (feature-2 is a known id only once the base role has instances configured.)
  const configured = readJson<TeamConfigFile>(path.join(repo, "tumwater.json"));
  configured.roles = { ...configured.roles, feature: { ...configured.roles.feature, instances: 2 } };
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(configured, null, 2));
  const base = path.join(repo, "base.md");
  fs.writeFileSync(base, "for base");
  r = await cli(repo, "role", "feature-2", "--instructions-file", base);
  assert.equal(r.code, 0);
  assert.equal(config().roles.feature.instructions, "for base");

  // Clearing removes the key (undefined, not an empty string).
  r = await cli(repo, "role", "feature", "--clear-instructions");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: instructions cleared/);
  assert.equal(config().roles.feature.instructions, undefined);
  r = await cli(repo, "role", "feature", "--json");
  assert.equal(JSON.parse(r.stdout).instructions, null);

  // Refusals.
  for (const [args, msg] of [
    [["feature", "--clear-instructions", "--instructions-file", "x"], /not both/],
    [["feature", "--clear-instructions", "--json"], /--json does not apply/],
    [["feature", "--clear-notes", "--instructions-file", "x"], /notes and instructions writes/],
    [["bogus", "--clear-instructions"], /unknown role: bogus/],
  ] as const) {
    r = await cli(repo, "role", ...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, msg);
  }

  // The director is allowed for instructions (its override reaches its own runs), unlike
  // the notes branch's director refusal.
  r = await cli(repo, "role", "director", "--clear-instructions");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /director: instructions cleared/);
});

test("role writes report a broken tumwater.json instead of crashing on it", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role broken config");

  // A tumwater.json that cannot be parsed makes every config-core write fail. The role write
  // branches' `if (!result.ok) fail(result.error)` path must surface the parse error — the same
  // wording `config set` gives — and leave the (already broken) file untouched rather than
  // crash or half-write. requireKnownRole falls back to defaultConfig on a failed load, so the
  // id still resolves and the write reaches the config core.
  const broken = "{ broken";
  fs.writeFileSync(path.join(repo, "tumwater.json"), broken);
  const instFile = path.join(repo, "inst.md");
  fs.writeFileSync(instFile, "keep me");
  // The model-triple and review-after-merge branches resolve the role against a built-in
  // default config on a failed load (`loadConfigSafe(root).config ?? defaultConfig()` /
  // `config?.review.afterMerge ?? []`), so a valid id still resolves and the write reaches the
  // config core, whose parse failure is what the operator is owed — the same `?? defaultConfig`
  // / `?? []` fallback the cap and instances branches take, covered here so a broken file
  // cannot crash these four branches either.
  for (const args of [
    ["feature", "--cap", "5"], // the shared six-hold set path (writeRoleConfigKey)
    ["feature", "--clear-cap"], // the shared six-hold unset path
    ["feature", "--enable"], // the enable/disable write
    ["feature", "--instructions-file", instFile], // the instructions set path
    ["feature", "--clear-instructions"], // the instructions unset path (its own `!result.ok` fail)
    // The model triple and review-after-merge branches fall back to defaultConfig on a
    // failed load (their own `?? defaultConfig()`/`?? []` arms, not the shared six-hold
    // path), so they must hit that fallback before the config core reports the parse error.
    ["feature", "--provider", "openai"], // provider branch's defaultConfig fallback
    ["feature", "--model", "gpt-5"], // model branch's defaultConfig fallback
    ["feature", "--thinking", "high"], // thinking branch's defaultConfig fallback
    ["feature", "--review-after-merge"], // review-after-merge branch's `?? []` fallback
  ] as const) {
    const r = await cli(repo, "role", ...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, /tumwater\.json is not valid JSON/, args.join(" "));
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), broken, "file untouched");
  }
});

test("a valued role write flag followed by another flag refuses with its own needs-a-value wording", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role flag-as-value");

  // `--model` immediately followed by another flag means the model value is missing, so the
  // refusal names --model and the flag token instead of a downstream, unrelated message.
  let r = await cli(repo, "role", "feature", "--model", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--model needs a value \(the next token "--json" is a flag, not a value\)/);
  r = await cli(repo, "role", "feature", "--model", "--provider", "y");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--model needs a value \(the next token "--provider" is a flag, not a value\)/);
  r = await cli(repo, "role", "feature", "--thinking", "--cap", "5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--thinking needs a value \(the next token "--cap" is a flag, not a value\)/);

  // A genuinely valued triple still works, and a genuinely shared (both-valued) one still
  // reports the share refusal, not the missing-value one.
  r = await cli(repo, "role", "feature", "--provider", "openai");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: provider set to openai/);
});

test("role validates its arguments like every other command", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role validation");

  // No id at all.
  let r = await cli(repo, "role");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater role needs a role id/);

  // Unknown role: the shared unknownRoleMessage wording, exit 1.
  r = await cli(repo, "role", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus \(valid ids: feature, bugfix/);

  // Unknown flags and stray positionals are rejected like every other command.
  r = await cli(repo, "role", "--rol", "feature");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --rol/);
  r = await cli(repo, "role", "feature", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: extra/);

  // Both spellings at once is a mistake, not a silent pick of one.
  r = await cli(repo, "role", "feature", "--role", "qa");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give the role id once/);

  // The --role spelling every other role-targeting command shares works too.
  r = await cli(repo, "role", "--role", "qa");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /# tumwater role: qa/);
});
