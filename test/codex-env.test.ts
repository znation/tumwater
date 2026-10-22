// The codex isolation environment (plans/codex-backend.md "The invocation" §3, findings 10, 13;
// PLANS.md "Codex backend, part 5/9"): host Codex/Claude session state and API keys are scrubbed,
// the run marker and notes PATH survive, and CODEX_HOME is set from a team home.
import test from "node:test";
import assert from "node:assert/strict";
import { codexEnv, type CodexEnvOptions } from "../src/agent/codex/codex-env.js";

function env(base: NodeJS.ProcessEnv = {}, opts: CodexEnvOptions = {}): NodeJS.ProcessEnv {
  return codexEnv(base, opts);
}

test("codexEnv scrubs host session state and API keys, keeping everything else", () => {
  const out = env({
    CODEX_THREAD_ID: "thread",
    CODEX_SANDBOX: "seatbelt",
    OPENAI_API_KEY: "sk-…",
    CODEX_API_KEY: "ck-…",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    TUMWATER_RUN: "123-abc",
    HF_TOKEN: "hf-…",
    PATH: "/usr/bin",
  });
  for (const key of [
    "CODEX_THREAD_ID",
    "CODEX_SANDBOX",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
  ]) {
    assert.equal(out[key], undefined, `${key} is dropped`);
  }
  assert.equal(out.TUMWATER_RUN, "123-abc");
  assert.equal(out.HF_TOKEN, "hf-…");
  assert.equal(out.PATH, "/usr/bin");
});

test("codexEnv sets CODEX_HOME when a home is given and leaves it unset otherwise", () => {
  const withHome = env({}, { home: "/team/codex" });
  assert.equal(withHome.CODEX_HOME, "/team/codex");
  const absent = env({});
  assert.equal(absent.CODEX_HOME, undefined);
  // A configured home overrides an inherited host home.
  const override = env({ CODEX_HOME: "/host/home" }, { home: "/team/codex" });
  assert.equal(override.CODEX_HOME, "/team/codex");
});

test("codexEnv never mutates its base", () => {
  const base: NodeJS.ProcessEnv = { CODEX_THREAD_ID: "t", OPENAI_API_KEY: "k", PATH: "/usr/bin" };
  env(base, { home: "/team/codex" });
  assert.equal(base.CODEX_THREAD_ID, "t");
  assert.equal(base.OPENAI_API_KEY, "k");
  assert.equal(base.CODEX_HOME, undefined);
});
