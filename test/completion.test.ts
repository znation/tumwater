import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { completionScript, completionSpec } from "../src/cli/completion.js";
import { HELP, helpStanzas } from "../src/cli/help.js";
import { cli } from "./helpers/cli-harness.js";
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

async function complete(script: string, words: string[], cword: number): Promise<string[]> {
  const quoted = words.map((w) => `'${w}'`).join(" ");
  const { stdout } = await run("bash", [
    "-c",
    `${script}\nCOMP_WORDS=(${quoted}); COMP_CWORD=${cword}; _tumwater; printf '%s\\n' "\${COMPREPLY[@]}"`,
  ]);
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
