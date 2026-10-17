// The opencode isolation environment (plans/opencode-backend.md "The invocation", PLANS.md
// "OpenCode backend, part 3/7"): every inherited OPENCODE_* plus OPENCODE and AI_AGENT are
// scrubbed except the operator's API key, the managed set is fixed, no shell-timeout variable
// is set (finding 16), and no XDG_* variable is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { opencodeEnv, type OpencodeEnvOptions } from "../src/agent/opencode/opencode-env.js";

function opts(overrides: Partial<OpencodeEnvOptions> = {}): OpencodeEnvOptions {
  return { dbPath: "/db/opencode/opencode.db", configContent: "{}", ...overrides };
}

function env(base: NodeJS.ProcessEnv = {}, o: Partial<OpencodeEnvOptions> = {}): NodeJS.ProcessEnv {
  return opencodeEnv(base, opts(o));
}

test("opencodeEnv removes inherited OPENCODE_* except OPENCODE_API_KEY, plus OPENCODE and AI_AGENT", () => {
  const out = env({
    OPENCODE_SERVER_PASSWORD: "secret",
    OPENCODE_CONFIG: "/host/opencode.json",
    OPENCODE_CLIENT: "host-cli",
    OPENCODE_SESSION_ID: "host-session",
    OPENCODE: "1",
    AI_AGENT: "claude-code_abc",
    OPENCODE_API_KEY: "op-key",
    PATH: "/usr/bin",
  });
  for (const key of ["OPENCODE_SERVER_PASSWORD", "OPENCODE_CONFIG", "OPENCODE_CLIENT", "OPENCODE_SESSION_ID", "OPENCODE", "AI_AGENT"]) {
    assert.equal(out[key], undefined, `${key} is dropped`);
  }
  assert.equal(out.OPENCODE_API_KEY, "op-key");
  assert.equal(out.PATH, "/usr/bin");
});

test("opencodeEnv sets every managed variable", () => {
  const out = env({}, { dbPath: "/db/1.db", configContent: '{"snapshots":false}' });
  assert.equal(out.OPENCODE_DISABLE_CLAUDE_CODE, "1");
  assert.equal(out.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS, "1");
  assert.equal(out.OPENCODE_DISABLE_AUTOUPDATE, "1");
  assert.equal(out.OPENCODE_DISABLE_FILEWATCHER, "1");
  assert.equal(out.OPENCODE_DB, "/db/1.db");
  assert.equal(out.OPENCODE_CONFIG_CONTENT, '{"snapshots":false}');
});

test("opencodeEnv never sets a shell-timeout variable (finding 16)", () => {
  const out = env();
  const shellTimeout = Object.keys(out).filter((k) => k.toLowerCase().includes("timeout"));
  assert.deepEqual(shellTimeout, [], "no shell-timeout variable is introduced");
});

test("opencodeEnv preserves layered run-marker/preload env", () => {
  const out = env({ TUMWATER_RUN: "123", NODE_OPTIONS: "--import=data:text/javascript,void 0" });
  assert.equal(out.TUMWATER_RUN, "123");
  assert.equal(out.NODE_OPTIONS, "--import=data:text/javascript,void 0");
});

test("opencodeEnv passes an inherited XDG_CONFIG_HOME through untouched and adds none", () => {
  const out = env({ XDG_CONFIG_HOME: "/operator/.config" });
  assert.equal(out.XDG_CONFIG_HOME, "/operator/.config");
  // opencodeEnv only ever sets OPENCODE_* variables, so no XDG_* key is introduced.
  assert.deepEqual(Object.keys(out).filter((k) => k.startsWith("XDG_")), ["XDG_CONFIG_HOME"]);
});

test("opencodeEnv never mutates its base", () => {
  const base: NodeJS.ProcessEnv = { OPENCODE_SERVER_PASSWORD: "secret", PATH: "/usr/bin" };
  env(base);
  assert.equal(base.OPENCODE_SERVER_PASSWORD, "secret");
  assert.equal(base.PATH, "/usr/bin");
});
