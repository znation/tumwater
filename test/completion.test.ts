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
  assert.deepEqual(spec.subcommands.completion, ["bash", "zsh", "fish"]);
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
  assert.deepEqual(await complete(script, ["tumwater", "completion", "z"], 2), ["zsh"]);
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
  for (const args of [["completion", "tcsh"], ["completion"]]) {
    const bad = await cli(dir, ...args);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /bash, zsh, or fish/);
  }
  // A far-off shell (`tcsh`) stays hint-free; a single near-miss (zs -> zsh) gets the same
  // typoSuffix `logs --type`/`history --result` give.
  const tcsh = await cli(dir, "completion", "tcsh");
  assert.ok(!tcsh.stderr.includes("did you mean"), tcsh.stderr);
  const typo = await cli(dir, "completion", "zs");
  assert.notEqual(typo.code, 0);
  assert.match(typo.stderr, /bash, zsh, or fish/);
  assert.match(typo.stderr, /did you mean `zsh`\?/);
  const fish = await cli(dir, "completion", "fish");
  assert.equal(fish.code, 0);
  assert.match(fish.stdout, /complete -c tumwater/);
  assert.doesNotMatch(fish.stdout, /COMPREPLY|compgen|complete -F/);
  const topic = await cli(dir, "help", "completion");
  assert.match(topic.stdout, /tumwater completion <bash\|zsh\|fish>/);
});

test("the bash script completes loop ids after --role and for role/history", async () => {
  const script = completionScript("bash");
  assert.deepEqual(await complete(script, ["tumwater", "logs", "--role", "fe"], 3), ["feature", "feature-2"]);
  assert.deepEqual(await complete(script, ["tumwater", "role", "q"], 2), ["qa"]);
  assert.deepEqual(await complete(script, ["tumwater", "history", "q"], 2), ["qa"]);
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
  assert.match(bad.stderr, /bash, zsh, or fish/);
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
  for (const k of ["maxDailyCostUsd", "model.strong", "backends.claude.bin", "quietHoursPerRole.feature", "roles.qa.model", "roles.docs-bot.enabled"])
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
  assert.match(bad.stderr, /bash, zsh, or fish/);
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

test("the bash script completes event-type codes after logs --type", async () => {
  const script = completionScript("bash");
  assert.deepEqual(await complete(script, ["tumwater", "logs", "--type", "merge_"], 3), ["merge_done", "merge_failed", "merge_queued"]);
  assert.deepEqual(await complete(script, ["tumwater", "logs", "--type", "run_"], 3), ["run_aborted", "run_deferred", "run_end", "run_start"]);
  assert.ok((await complete(script, ["tumwater", "logs", "--type", ""], 3)).length > 0);
});

test("the bash script completes pi thinking levels after --thinking", async () => {
  const script = completionScript("bash");
  assert.deepEqual(await complete(script, ["tumwater", "role", "qa", "--thinking", "h"], 4), ["high"]);
  assert.deepEqual(await complete(script, ["tumwater", "role", "qa", "--thinking", "x"], 4), ["xhigh"]);
  assert.ok((await complete(script, ["tumwater", "role", "qa", "--thinking", ""], 4)).length > 0);
});

const fishScriptLines = (): string[] => completionScript("fish").split("\n");

test("the fish script names every command, subcommand, and flag from the spec", () => {
  const lines = fishScriptLines();
  const spec = completionSpec();
  const useLine = lines.find((l) => l.includes("__fish_use_subcommand"));
  assert.ok(useLine);
  assert.deepEqual(/-a "([^"]*)"/.exec(useLine)?.[1]?.split(" "), spec.commands);
  for (const command of spec.commands) {
    const subs = spec.subcommands[command] ?? [];
    if (subs.length > 0)
      assert.ok(
        lines.some((l) => l.includes(`__fish_seen_subcommand_from ${command}; and test (__tumwater_argc) -eq 2`) && l.includes(`-a "${subs.join(" ")}"`)),
        command,
      );
    for (const flag of spec.flags[command] ?? [])
      assert.ok(lines.some((l) => l.includes(`__fish_seen_subcommand_from ${command}"`) && l.includes(` -l ${flag.slice(2)}`)), `${command} ${flag}`);
  }
});

test("the fish script completes values after --role, path flags, --template, and --result, and config keys at word 3", () => {
  const lines = fishScriptLines();
  const flagLines = (name: string) => lines.filter((l) => (l + " ").includes(` -l ${name} `));
  for (const l of flagLines("role")) assert.ok(l.includes("completion --roles"), l);
  for (const name of ["file", "attach", "notes-file", "instructions-file"]) {
    assert.ok(flagLines(name).length > 0, name);
    for (const l of flagLines(name)) assert.ok(l.includes("-r -F"), l);
  }
  assert.ok(flagLines("template").some((l) => templateIds().every((id) => l.includes(id))));
  assert.ok(flagLines("result").some((l) => l.includes("problems")));
  assert.ok(flagLines("type").some((l) => l.includes("merge_failed") && l.includes("run_start")));
  assert.ok(flagLines("thinking").some((l) => [...new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"])].every((w) => l.includes(w))));
  assert.ok(lines.some((l) => l.includes("__fish_seen_subcommand_from get set unset") && l.includes("completion --config-keys")));
});

const fishInstalled = await run("fish", ["--version"]).then(() => true, () => false);

test("the fish script parses under fish when fish is installed", { skip: !fishInstalled }, async () => {
  await run("fish", ["--no-execute", "-c", completionScript("fish")]);
});
