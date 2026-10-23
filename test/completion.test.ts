import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { allRoleIds } from "../src/roles/roles.js";
import { DOCTOR_CHECK_NAMES } from "../src/doctor/doctor-check-names.js";
import { completionConfigKeys, completionScript, completionSpec } from "../src/cli/completion.js";
import { HELP, helpStanzas } from "../src/cli/help.js";
import { cli } from "./helpers/cli-harness.js";
import { MODEL_TIERS } from "../src/config/config-schema.js";
import { parseConfigKey } from "../src/config/config-keys.js";
import { HISTORY_RESULT_FLAG_NAMES } from "../src/history/history-data.js";
import { templateIds } from "../src/init/init-templates.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { logEvent } from "../src/events/events.js";

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
    `tumwater() { if [ "$2" = --models ]; then printf 'hf/m-a:deepinfra\\nhf/m-b\\n'; elif [ "$2" = --config-keys ]; then printf 'maxDailyCostUsd\\nmaxDailyCostUsdPerRole.qa\\nroles.qa.model\\nroles.qa.enabled\\nmodel.strong\\n'; elif [ "$2" = --config-value ]; then case "$3" in *enabled) printf 'false\\ntrue\\n';; *thinking) printf 'off\\nmedium\\n';; *backend) printf 'pi\\nclaude\\nopencode\\ncodex\\n';; esac; else printf 'feature\\nfeature-2\\nqa\\n'; fi; }\n${script}\nCOMP_WORDS=(${quoted}); COMP_CWORD=${cword}; _tumwater; printf '%s\\n' "\${COMPREPLY[@]}"`,
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
  // A wrong word count says so instead of naming a word as if it were a bad shell.
  const bare = await cli(dir, "completion");
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /tumwater: completion needs a shell: bash, zsh, or fish/);
  assert.doesNotMatch(bare.stderr, /got/);
  const extra = await cli(dir, "completion", "bash", "extra");
  assert.equal(extra.code, 1);
  assert.match(extra.stderr, /\(got 2 words: bash extra\)/);
  assert.doesNotMatch(extra.stderr, /did you mean/);
  const fish = await cli(dir, "completion", "fish");
  assert.equal(fish.code, 0);
  assert.match(fish.stdout, /complete -c tumwater/);
  assert.doesNotMatch(fish.stdout, /COMPREPLY|compgen|complete -F/);
  const topic = await cli(dir, "help", "completion");
  assert.match(topic.stdout, /tumwater completion <bash\|zsh\|fish>/);
});

test("the bash script completes role ids after --role and for role/history/revert", async () => {
  const script = completionScript("bash");
  assert.deepEqual(await complete(script, ["tumwater", "logs", "--role", "fe"], 3), ["feature", "feature-2"]);
  assert.deepEqual(await complete(script, ["tumwater", "logs", "--transcript", "fe"], 3), ["feature", "feature-2"]);
  assert.deepEqual(await complete(script, ["tumwater", "history", "--transcript", "fe"], 3), []);
  assert.deepEqual(await complete(script, ["tumwater", "role", "q"], 2), ["qa"]);
  assert.deepEqual(await complete(script, ["tumwater", "history", "q"], 2), ["qa"]);
  assert.deepEqual(await complete(script, ["tumwater", "revert", "q"], 2), ["qa"]);
  assert.deepEqual(await complete(script, ["tumwater", "revert", "qa", "q"], 3), []);
});

test("completion --models prints the selectors recent runs started on, and nothing without a log", async () => {
  const repo = makeRepo();
  const ts = Date.now() - 60_000;
  const start = (run: number, model?: string) =>
    logEvent(repo, { ts: ts + run, source: "qa", type: "run_start", run, ...(model ? { model } : {}) });
  const end = (run: number) => logEvent(repo, { ts: ts + run + 10, source: "qa", type: "run_end", run, result: "ok", tokens: 1, costUsd: 0 });
  start(1, "m-b");
  end(1);
  start(2, "m-a");
  end(2);
  start(3, "m-b");
  end(3);
  start(4);
  const ok = await cli(repo, "completion", "--models");
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, "m-a\nm-b\n");
  const bare = tmpdir();
  await run("git", ["init", "-q", bare]);
  const none = await cli(bare, "completion", "--models");
  assert.equal(none.code, 0);
  assert.equal(none.stdout, "");
  assert.equal(none.stderr, "");
  assert.ok(completionSpec().flags.completion?.includes("--models"));
  const bad = await cli(repo, "completion", "--models", "bash");
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /bash, zsh, or fish/);
});

test("completion --roles prints the repo's role ids, or the catalog on a broken config", async () => {
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

test("config set completes a discrete-valued key's value vocabulary at word 4", async () => {
  const script = completionScript("bash");
  // A boolean .enabled completes true/false; a .thinking key the levels.
  assert.deepEqual(await complete(script, ["tumwater", "config", "set", "roles.qa.enabled", "t"], 4), ["true"]);
  assert.deepEqual(await complete(script, ["tumwater", "config", "set", "roles.qa.enabled", ""], 4), ["false", "true"]);
  assert.deepEqual(await complete(script, ["tumwater", "config", "set", "review.thinking", "me"], 4), ["medium"]);
  // A dot-less top-level key is whole-value too: `backend` and `thinking` are the discrete ones.
  assert.deepEqual(await complete(script, ["tumwater", "config", "set", "backend", "cl"], 4), ["claude"]);
  assert.deepEqual(await complete(script, ["tumwater", "config", "set", "thinking", "of"], 4), ["off"]);
  // A provider is a free-form pi provider name, not a backend id — completes nothing.
  assert.deepEqual(await complete(script, ["tumwater", "config", "set", "roles.qa.provider", "c"], 4), []);
  // A key with no discrete vocabulary, or a free-form top-level key, completes nothing.
  assert.deepEqual(await complete(script, ["tumwater", "config", "set", "roles.qa.minRunIntervalSeconds", "3"], 4), []);
  assert.deepEqual(await complete(script, ["tumwater", "config", "set", "model", "s"], 4), []);
});

test("completion --config-value prints a discrete key's vocabulary, nothing for a free-form key", async () => {
  const dir = tmpdir();
  const en = await cli(dir, "completion", "--config-value", "roles.qa.enabled");
  assert.equal(en.code, 0);
  assert.deepEqual(en.stdout.split("\n").filter(Boolean), ["true", "false"]);
  const think = await cli(dir, "completion", "--config-value", "review.thinking");
  assert.ok(think.stdout.split("\n").includes("off"));
  const back = await cli(dir, "completion", "--config-value", "roles.qa.backend");
  assert.ok(back.stdout.split("\n").includes("codex"));
  // A dot-less whole top-level key works the same: `backend` and `thinking` are discrete.
  const topBack = await cli(dir, "completion", "--config-value", "backend");
  assert.ok(topBack.stdout.split("\n").includes("codex"));
  const topThink = await cli(dir, "completion", "--config-value", "thinking");
  assert.ok(topThink.stdout.split("\n").includes("off"));
  // `provider` is a free-form pi provider name, not a backend id — prints nothing.
  const prov = await cli(dir, "completion", "--config-value", "roles.qa.provider");
  assert.equal(prov.stdout.trim(), "");
  const free = await cli(dir, "completion", "--config-value", "maxDailyCostUsd");
  assert.equal(free.code, 0);
  assert.equal(free.stdout.trim(), "");
  const nodot = await cli(dir, "completion", "--config-value", "model");
  assert.equal(nodot.stdout.trim(), "");
  assert.ok(completionSpec().flags.completion?.includes("--config-value"));
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
  for (const k of ["maxDailyCostUsd", "model.strong", "backends.claude.bin", "backends.codex.configDir", "backends.codex.windowReserve", "quietHoursPerRole.feature", "roles.qa.model", "roles.docs-bot.enabled", "bootstrap.untilPlansDone", "review.model"])
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
  assert.deepEqual(await complete(script, ["tumwater", "logs", "--type", "merge_"], 3), ["merge_cancelled", "merge_done", "merge_failed", "merge_queued"]);
  assert.deepEqual(await complete(script, ["tumwater", "logs", "--type", "run_"], 3), ["run_aborted", "run_deferred", "run_end", "run_start"]);
  assert.ok((await complete(script, ["tumwater", "logs", "--type", ""], 3)).length > 0);
});

test("the bash script completes summary groups after --by and tier names after role --model", async () => {
  const script = completionScript("bash");
  assert.deepEqual(await complete(script, ["tumwater", "history", "--by", "m"], 3), ["model"]);
  assert.deepEqual(await complete(script, ["tumwater", "history", "--by", ""], 3), ["role", "model"]);
  assert.deepEqual(await complete(script, ["tumwater", "role", "qa", "--model", "st"], 4), ["strong"]);
  assert.deepEqual(await complete(script, ["tumwater", "role", "qa", "--model", ""], 4), [...MODEL_TIERS]);
  assert.deepEqual(await complete(script, ["tumwater", "history", "--model", ""], 3), ["hf/m-a:deepinfra", "hf/m-b"]);
  assert.deepEqual(await complete(script, ["tumwater", "history", "--model", "hf/m-a"], 3), ["hf/m-a:deepinfra"]);
  assert.deepEqual(await complete(script, ["tumwater", "history", "--model", "hf/m-b,hf/m-a"], 3), ["hf/m-b,hf/m-a:deepinfra"]);
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
  for (const l of flagLines("role")) assert.ok(l.includes("__fish_complete_list , __tumwater_roles"), l);
  for (const name of ["file", "attach", "notes-file", "instructions-file"]) {
    assert.ok(flagLines(name).length > 0, name);
    for (const l of flagLines(name)) assert.ok(l.includes("-r -F"), l);
  }
  assert.ok(flagLines("template").some((l) => templateIds().every((id) => l.includes(id))));
  assert.ok(flagLines("result").some((l) => l.includes("__fish_complete_list , __tumwater_results")));
  assert.ok(flagLines("type").some((l) => l.includes("__fish_complete_list , __tumwater_types")));
  assert.ok(lines.some((l) => l.startsWith("function __tumwater_results") && l.includes("problems")));
  assert.ok(lines.some((l) => l.startsWith("function __tumwater_types") && l.includes("merge_failed") && l.includes("run_start")));
  assert.ok(flagLines("thinking").some((l) => [...new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"])].every((w) => l.includes(w))));
  assert.ok(flagLines("by").some((l) => l.includes("-a") && l.includes("role") && l.includes("model")));
  const modelLine = (cmd: string) => flagLines("model").find((l) => l.includes(`__fish_seen_subcommand_from ${cmd}`)) ?? "";
  assert.ok(["small", "default", "strong"].every((t) => modelLine("role").includes(t)));
  assert.ok(modelLine("history").includes("__fish_complete_list , __tumwater_models"));
  const transcriptFlag = (cmd: string) => flagLines("transcript").find((l) => l.includes(`__fish_seen_subcommand_from ${cmd}`)) ?? "";
  assert.ok(transcriptFlag("logs").includes("__fish_complete_list , __tumwater_roles"));
  assert.ok(transcriptFlag("history").includes("__fish_seen_subcommand_from history"));
  assert.ok(!transcriptFlag("history").includes("__tumwater_roles"));
  assert.ok(lines.some((l) => l.startsWith("function __tumwater_models") && l.includes("completion --models")));
  assert.ok(!modelLine("role").includes("completion --models"));
  assert.ok(lines.some((l) => l.includes("__fish_seen_subcommand_from get set unset") && l.includes("completion --config-keys")));
});

const fishInstalled = await run("fish", ["--version"]).then(() => true, () => false);

test("the fish script completes role ids as the first argument of role, history and revert", () => {
  assert.ok(completionScript("fish").includes("__fish_seen_subcommand_from role history revert; and test (__tumwater_argc) -eq 2"));
});

test("fish completes the item after the last comma of a --result list", { skip: !fishInstalled }, async () => {
  const { stdout } = await run("fish", ["-c", `${completionScript("fish")}\ncomplete -C 'tumwater history --result merged,p'`]);
  assert.equal(stdout.split("\n")[0]?.split("\t")[0], "merged,problems");
});

test("the bash script completes the item after the last comma of --role, --result and --type lists", async () => {
  const script = completionScript("bash");
  assert.deepEqual(await complete(script, ["tumwater", "history", "--role", "qa,fe"], 3), ["qa,feature", "qa,feature-2"]);
  assert.deepEqual(await complete(script, ["tumwater", "logs", "--role", "feature,feature-2,q"], 3), ["feature,feature-2,qa"]);
  assert.deepEqual(await complete(script, ["tumwater", "history", "--result", "merged,p"], 3), ["merged,problems"]);
  assert.deepEqual(await complete(script, ["tumwater", "logs", "--type", "run_start,merge_f"], 3), ["run_start,merge_failed"]);
  assert.deepEqual(await complete(script, ["tumwater", "history", "--role", "qa,"], 3), ["qa,feature", "qa,feature-2"]);
});

test("the bash script skips the items a comma list already holds", async () => {
  const script = completionScript("bash");
  assert.deepEqual(await complete(script, ["tumwater", "history", "--role", "feature,"], 3), ["feature,feature-2", "feature,qa"]);
  assert.deepEqual(await complete(script, ["tumwater", "logs", "--role", "feature,qa,feature-2,"], 3), []);
  const others = Object.values(HISTORY_RESULT_FLAG_NAMES).filter((n) => n !== "merged").map((n) => `merged,${n}`);
  assert.deepEqual((await complete(script, ["tumwater", "history", "--result", "merged,"], 3)).sort(), others.sort());
  const types = await complete(script, ["tumwater", "logs", "--type", "run_start,run_"], 3);
  assert.ok(!types.includes("run_start,run_start") && types.includes("run_start,run_end"));
  assert.deepEqual(await complete(script, ["tumwater", "history", "--model", "hf/m-b,"], 3), ["hf/m-b,hf/m-a:deepinfra"]);
});

test("the fish script filters comma-list sources through __tumwater_unlisted", () => {
  const lines = fishScriptLines();
  assert.ok(lines.some((l) => l.startsWith("function __tumwater_unlisted")));
  for (const name of ["roles", "results", "types", "models"])
    assert.ok(lines.some((l) => l.startsWith(`function __tumwater_${name};`) && l.includes("| __tumwater_unlisted")), name);
});

test("fish skips the items a --result list already holds", { skip: !fishInstalled }, async () => {
  const { stdout } = await run("fish", ["-c", `${completionScript("fish")}\ncomplete -C 'tumwater history --result merged,'`]);
  assert.ok(!stdout.includes("merged,merged"));
  assert.ok(stdout.includes("merged,problems"));
});

test("the fish script parses under fish when fish is installed", { skip: !fishInstalled }, async () => {
  await run("fish", ["--no-execute", "-c", completionScript("fish")]);
});

test("the bash script completes doctor check names, escaping spaces and apostrophes", async () => {
  const script = completionScript("bash");
  assert.deepEqual(await complete(script, ["tumwater", "doctor", "im"], 2), ["image\\ input"]);
  assert.deepEqual(await complete(script, ["tumwater", "doctor", "mai"], 2), ["maintenance\\ allowance", "main\\'s\\ check"]);
  assert.deepEqual(await complete(script, ["tumwater", "doctor", "image\\ in"], 2), ["image\\ input"]);
  assert.equal((await complete(script, ["tumwater", "doctor", ""], 2)).length, DOCTOR_CHECK_NAMES.length);
  assert.deepEqual(await complete(script, ["tumwater", "doctor", "repo", "or"], 3), ["orphans"]);
  assert.deepEqual(await complete(script, ["tumwater", "doctor", "--pr"], 2), ["--problems"]);
  assert.ok(!(await complete(script, ["tumwater", "status", ""], 2)).includes("image\\ input"));
  for (const name of DOCTOR_CHECK_NAMES) assert.match(name, /^[a-z0-9' -]+$/i);
});

test("the fish script completes doctor check names", () => {
  const lines = fishScriptLines();
  assert.ok(lines.some((l) => l.includes("__tumwater_doctor_checks") && l.includes(`"main's check"`) && l.includes(`"image input"`)));
  assert.ok(lines.some((l) => l.includes("__fish_seen_subcommand_from doctor") && l.includes(`-a "(__tumwater_doctor_checks)"`)));
});
