import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { allRoleIds } from "../src/roles/roles.js";
import { completionConfigKeys, completionScript, completionSpec } from "../src/cli/completion.js";
import { HELP, helpStanzas } from "../src/cli/help.js";
import { cli } from "./helpers/cli-harness.js";
import { parseConfigKey } from "../src/config/config-keys.js";
import { templateIds } from "../src/init/init-templates.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

const run = promisify(execFile);

test("completionSpec parses a synthetic help: subcommands from the usage part only", () => {
  const help = [
    "Usage:",
    "  tumwater alpha [--one] [get | set <k>]  Do alpha; mention --hidden here",
    "                                   continued with --cont",
    "  tumwater beta <x>                Beta",
    "  tumwater gamma  Clear that loop's notes",
    "  tumwater help [<command>]        Help",
    "",
  ].join("\n");
  const spec = completionSpec(help);
  assert.deepEqual(spec.commands, ["alpha", "beta", "gamma", "help"]);
  assert.deepEqual(spec.subcommands.alpha, ["get", "set"]);
  assert.deepEqual(spec.subcommands.beta, []);
  assert.deepEqual(spec.subcommands.gamma, []);
  assert.deepEqual(spec.subcommands.help, spec.commands);
  assert.deepEqual(spec.flags.alpha, ["--cont", "--help", "--hidden", "--one"]);
});

test("completionSpec over the real help", () => {
  const spec = completionSpec();
  assert.deepEqual(spec.commands, [...new Set(helpStanzas(HELP).map((s) => s.command))]);
  assert.ok(spec.commands.includes("completion"));
  assert.deepEqual(spec.subcommands.config, ["get", "set", "unset"]);
  assert.deepEqual(spec.subcommands.questions, ["answer"]);
  for (const f of ["--failures", "--since", "--role", "--json"]) assert.ok(spec.flags.report?.includes(f), f);
  for (const c of ["tui", "version", "role"]) assert.deepEqual(spec.subcommands[c], [], c);
  for (const c of spec.commands) assert.ok(spec.flags[c]?.includes("--help"), c);
});

async function complete(script: string, words: string[], cword: number, cwd?: string): Promise<string[]> {
  const quoted = words.map((w) => `'${w}'`).join(" ");
  const { stdout } = await run("bash", [
    "-c",
    `tumwater() { if [ "$2" = --config-keys ]; then printf 'maxDailyCostUsd\\nmaxDailyCostUsdPerRole.qa\\nroles.qa.model\\nroles.qa.enabled\\nmodel.strong\\n'; else printf 'feature\\nfeature-2\\nqa\\n'; fi; }\n${script}\nCOMP_WORDS=(${quoted}); COMP_CWORD=${cword}; _tumwater; printf '%s\\n' "\${COMPREPLY[@]}"`,
  ], { cwd });
  return stdout.split("\n").filter(Boolean);
}

test("the bash script parses and completes commands, subcommands, and flags", async () => {
  const script = completionScript("bash");
  await run("bash", ["-n", "-c", script]);
  assert.ok((await complete(script, ["tumwater", "con"], 1)).includes("config"));
  assert.deepEqual(await complete(script, ["tumwater", "config", "u"], 2), ["unset"]);
  assert.deepEqual(await complete(script, ["tumwater", "report", "--fa"], 2), ["--failures"]);
});

test("the zsh script wraps the bash script in bashcompinit", () => {
  const zsh = completionScript("zsh");
  assert.ok(zsh.startsWith("autoload -U +X bashcompinit && bashcompinit"));
  assert.ok(zsh.includes("complete -F _tumwater tumwater"));
});

test("the completion command works outside a repo and rejects other shells", async () => {
  const dir = tmpdir();
  const ok = await cli(dir, "completion", "bash");
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /complete -F _tumwater tumwater/);
  for (const args of [["completion", "fish"], ["completion"]]) {
    const bad = await cli(dir, ...args);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /bash or zsh/);
  }
  const topic = await cli(dir, "help", "completion");
  assert.match(topic.stdout, /tumwater completion <bash\|zsh>/);
});

test("the bash script completes loop ids after --role and for role/tick", async () => {
  const script = completionScript("bash");
  assert.deepEqual(await complete(script, ["tumwater", "logs", "--role", "fe"], 3), ["feature", "feature-2"]);
  assert.deepEqual(await complete(script, ["tumwater", "role", "q"], 2), ["qa"]);
  assert.deepEqual(await complete(script, ["tumwater", "tick", "q"], 2), ["qa"]);
});

test("completion --roles prints the repo's loop ids, or the catalog on a broken config", async () => {
  const dir = tmpdir();
  await run("git", ["init", "-q", dir]);
  writeFileSync(join(dir, "tumwater.json"), JSON.stringify({ roles: { feature: { instances: 2 } } }));
  const ok = await cli(dir, "completion", "--roles");
  assert.equal(ok.code, 0);
  const ids = ok.stdout.split("\n").filter(Boolean);
  for (const id of ["feature", "feature-2", "director"]) assert.ok(ids.includes(id), id);
  writeFileSync(join(dir, "tumwater.json"), "{");
  const broken = await cli(dir, "completion", "--roles");
  assert.equal(broken.code, 0);
  assert.equal(broken.stderr, "");
  assert.deepEqual(broken.stdout.split("\n").filter(Boolean), allRoleIds());
  const bad = await cli(dir, "completion", "--roles", "bash");
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /bash or zsh/);
  assert.ok(completionSpec().flags.completion?.includes("--roles"));
});

test("the bash script completes config keys at word 3 only for config get|set|unset", async () => {
  const script = completionScript("bash");
  assert.deepEqual(await complete(script, ["tumwater", "config", "set", "maxDaily"], 3), ["maxDailyCostUsd", "maxDailyCostUsdPerRole.qa"]);
  assert.deepEqual(await complete(script, ["tumwater", "config", "get", "roles.q"], 3), ["roles.qa.model", "roles.qa.enabled"]);
  assert.deepEqual(await complete(script, ["tumwater", "config", "u"], 2), ["unset"]);
  assert.deepEqual(await complete(script, ["tumwater", "config", "set", "model", "x"], 4), []);
});

test("completion --config-keys prints parseable keys for this repo's roles, or the catalog on a broken config", async () => {
  const dir = tmpdir();
  await run("git", ["init", "-q", dir]);
  writeFileSync(
    join(dir, "tumwater.json"),
    JSON.stringify({ roles: { feature: { instances: 2 } }, customRoles: [{ name: "docs-bot", task: "keep docs fresh" }] }),
  );
  const ok = await cli(dir, "completion", "--config-keys");
  assert.equal(ok.code, 0);
  const keys = ok.stdout.split("\n").filter(Boolean);
  for (const k of ["maxDailyCostUsd", "model.strong", "agents.claude.bin", "quietHoursPerRole.feature", "roles.qa.model", "roles.docs-bot.enabled"])
    assert.ok(keys.includes(k), k);
  assert.ok(!keys.some((k) => k.startsWith("roles.feature-2.")));
  for (const k of keys) assert.notEqual(parseConfigKey(k).kind, "error", k);
  assert.deepEqual(completionConfigKeys(dir), keys);
  writeFileSync(join(dir, "tumwater.json"), "{");
  const broken = await cli(dir, "completion", "--config-keys");
  assert.equal(broken.code, 0);
  assert.equal(broken.stderr, "");
  assert.ok(broken.stdout.split("\n").includes("roles.feature.enabled"));
  const bad = await cli(dir, "completion", "--config-keys", "bash");
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /bash or zsh/);
  assert.ok(completionSpec().flags.completion?.includes("--config-keys"));
});

test("the bash script completes file names, template ids, and result classes after their flags", async () => {
  const script = completionScript("bash");
  const dir = tmpdir();
  writeFileSync(join(dir, "brief.md"), "");
  writeFileSync(join(dir, "notes.txt"), "");
  assert.deepEqual(await complete(script, ["tumwater", "plan", "--file", "br"], 3, dir), ["brief.md"]);
  assert.deepEqual(await complete(script, ["tumwater", "prompt", "--attach", "no"], 3, dir), ["notes.txt"]);
  assert.deepEqual(await complete(script, ["tumwater", "role", "qa", "--notes-file", "b"], 4, dir), ["brief.md"]);
  assert.deepEqual((await complete(script, ["tumwater", "init", "--template", ""], 3)).sort(), templateIds().sort());
  assert.deepEqual(await complete(script, ["tumwater", "history", "--result", "p"], 3), ["problems"]);
});
