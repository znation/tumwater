// The claude isolation environment (plans/agent-backends.md "The claude invocation", findings
// 2 and 4; PLANS.md "Agent backends, part 3b/7"): the host session's variables are scrubbed,
// the operator-intent allowlist survives, and the fixed isolation values are set.
import test from "node:test";
import assert from "node:assert/strict";
import { claudeEnv, type ClaudeEnvOptions } from "../src/agent/claude/claude-env.js";

function env(base: NodeJS.ProcessEnv = {}, opts: Partial<ClaudeEnvOptions> = {}): NodeJS.ProcessEnv {
  return claudeEnv(base, { quietTimeoutSeconds: 1800, ...opts });
}

test("claudeEnv scrubs the host Claude Code session and drops its proxy", () => {
  const out = env({
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "sid",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_AGENT_SDK_VERSION: "1.2.3",
    CLAUDE_PID: "4242",
    CLAUDE_EFFORT: "high",
    ANTHROPIC_BASE_URL: "http://host-proxy.invalid",
    PATH: "/usr/bin",
  });
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "ANTHROPIC_BASE_URL",
  ]) {
    assert.equal(out[key], undefined, `${key} is dropped`);
  }
  assert.equal(out.PATH, "/usr/bin");
});

test("claudeEnv keeps the operator-intent allowlist", () => {
  const out = env({
    CLAUDECODE: "1",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "token",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
    ANTHROPIC_BASE_URL: "http://host-proxy.invalid",
  });
  assert.equal(out.CLAUDE_CODE_USE_BEDROCK, "1");
  assert.equal(out.CLAUDE_CODE_USE_VERTEX, "1");
  assert.equal(out.CLAUDE_CODE_USE_FOUNDRY, "1");
  assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, "token");
  assert.equal(out.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "8000");
});

test("claudeEnv drops ANTHROPIC_BASE_URL only when CLAUDECODE was set", () => {
  const kept = env({ ANTHROPIC_BASE_URL: "http://operator-proxy.invalid" });
  assert.equal(kept.ANTHROPIC_BASE_URL, "http://operator-proxy.invalid");
  const dropped = env({ CLAUDECODE: "1", ANTHROPIC_BASE_URL: "http://host-proxy.invalid" });
  assert.equal(dropped.ANTHROPIC_BASE_URL, undefined);
});

test("claudeEnv sets the isolation values and derives BASH_MAX_TIMEOUT_MS", () => {
  const out = env({}, { quietTimeoutSeconds: 900 });
  assert.equal(out.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(out.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.equal(out.BASH_DEFAULT_TIMEOUT_MS, "600000");
  assert.equal(out.BASH_MAX_TIMEOUT_MS, String(900 * 1000 - 60_000));
  assert.equal(out.DISABLE_AUTOUPDATER, "1");
  assert.equal(out.DISABLE_TELEMETRY, "1");
  assert.equal(out.DISABLE_ERROR_REPORTING, "1");
});

test("claudeEnv preserves the layered run-marker/notebook/preload environment", () => {
  const out = env({
    TUMWATER_RUN: "123-abc",
    TUMWATER_NOTES_PATH: "/tmp/notes.md",
    NODE_OPTIONS: "--import=data:text/javascript,void 0",
  });
  assert.equal(out.TUMWATER_RUN, "123-abc");
  assert.equal(out.TUMWATER_NOTES_PATH, "/tmp/notes.md");
  assert.equal(out.NODE_OPTIONS, "--import=data:text/javascript,void 0");
});

test("claudeEnv floors BASH_MAX_TIMEOUT_MS above zero for a short quiet window", () => {
  const out = env({}, { quietTimeoutSeconds: 5 });
  assert.equal(out.BASH_MAX_TIMEOUT_MS, "1000");
  const boundary = env({}, { quietTimeoutSeconds: 60 });
  assert.equal(boundary.BASH_MAX_TIMEOUT_MS, "1000");
});

test("claudeEnv leaves BASH_MAX_TIMEOUT_MS unset when the quiet kill is disabled", () => {
  const out = env({}, { quietTimeoutSeconds: 0 });
  assert.equal(out.BASH_MAX_TIMEOUT_MS, undefined);
  assert.equal(out.BASH_DEFAULT_TIMEOUT_MS, "600000");
});

test("claudeEnv never mutates its base", () => {
  const base: NodeJS.ProcessEnv = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "sid", PATH: "/usr/bin" };
  env(base);
  assert.equal(base.CLAUDECODE, "1");
  assert.equal(base.CLAUDE_CODE_SESSION_ID, "sid");
});
