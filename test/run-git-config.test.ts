import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { registerAgentBackend, type AgentBackend } from "../src/agent/agent-backend.js";
import { runAgent } from "../src/agent/agent-run.js";
import { globalGitConfigFiles } from "../src/agent/run-git-config.js";
import { defaultConfig } from "../src/config/config.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// Each agent run gets a private global git config (src/agent/run-git-config.ts). The incident it
// answers: the ci role ran a CI workflow's `git config --global user.name "tumwater ci"` step on
// the host, and every repository on the operator's machine then committed as tumwater ci.

test("globalGitConfigFiles names GIT_CONFIG_GLOBAL alone when set, else XDG then ~/.gitconfig", () => {
  assert.deepEqual(globalGitConfigFiles({ GIT_CONFIG_GLOBAL: "/x/outer", HOME: "/h" }), ["/x/outer"]);
  // git's own order: the XDG file is read first, so ~/.gitconfig wins a conflict.
  assert.deepEqual(globalGitConfigFiles({ HOME: "/h" }), ["/h/.config/git/config", "/h/.gitconfig"]);
  assert.deepEqual(globalGitConfigFiles({ HOME: "/h", XDG_CONFIG_HOME: "/xdg", GIT_CONFIG_GLOBAL: "" }), [
    "/xdg/git/config",
    "/h/.gitconfig",
  ]);
});

test("a run's `git config --global` write stays in the run; it reads the operator's config", async () => {
  const dir = tmpdir();
  // A HOME with a space and a double quote in its path pins the include's value quoting.
  const home = path.join(dir, 'op home "q"');
  fs.mkdirSync(home);
  const operatorConfig = "[user]\n\tname = Operator\n\temail = op@example.com\n";
  fs.writeFileSync(path.join(home, ".gitconfig"), operatorConfig);
  const xdg = path.join(dir, "xdg");
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_NOSYSTEM: "1" };
  delete env.GIT_CONFIG_GLOBAL;
  execFileSync("git", ["init", "-q", repo], { env });
  // What the ci role ran on 2026-11-03, between two reads of the identity a commit would use.
  const script =
    'git config user.name; git config --global user.name "tumwater ci"; ' +
    "git config --global user.email ci@tumwater.local; git config user.name";
  const fake: AgentBackend = {
    id: "fake-git-global",
    label: "fake",
    defaultBin: "fake",
    binEnv: "TUMWATER_FAKE_BIN",
    resolveBin: () => ({ bin: "/bin/sh", source: "config" }),
    invocation: () => ({ args: ["-c", script], env }),
    translator: () => ({ translate: (line) => [line] }),
    classifyExit: () => ({}),
  };
  registerAgentBackend(fake);
  const rawLogFile = path.join(dir, "raw.jsonl");
  await runAgent({
    cwd: repo,
    prompt: "p",
    config: { ...defaultConfig(), agent: "fake-git-global" },
    sessionDir: path.join(dir, "sessions"),
    sessionName: "t",
    rawLogFile,
    nativeLogFile: path.join(dir, "native.jsonl"),
    kind: "author",
  });
  const lines = fs.readFileSync(rawLogFile, "utf8").trim().split("\n").slice(1);
  // The run reads the operator's identity through the include, then its own write shadows it.
  assert.deepEqual(lines, ["Operator", "tumwater ci"]);
  assert.equal(fs.readFileSync(path.join(home, ".gitconfig"), "utf8"), operatorConfig);
  assert.equal(fs.existsSync(path.join(xdg, "git", "config")), false, "no XDG global config written");
  assert.equal(
    execFileSync("git", ["-C", repo, "config", "user.name"], { env, encoding: "utf8" }).trim(),
    "Operator",
    "after the run, the operator's repos still commit as the operator",
  );
});
