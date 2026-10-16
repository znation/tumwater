import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  agentBinSourceLabel,
  agentMissingMessage,
  piMissingMessage,
  resolveAgentBin,
} from "../src/pi/pi-bin.js";

// Unit coverage for src/pi/pi-bin.ts's agent-binary resolution messages. The module exists so
// that cli.ts's fail-fast, doctor.ts's report, and src/agent/run-agent.ts's spawn errors describe
// the same missing-binary problem with the same words — its contract is that the wording cannot
// drift between the surfaces that quote it. cli.test.ts and doctor.test.ts pin the wording
// end-to-end through the CLI/doctor surfaces; these tests pin the shared source directly,
// including the "default" label whose case the other surfaces never reach (cli.ts and run-agent.ts
// short-circuit a default source before calling agentBinSourceLabel, and doctor returns early
// — so a regression there is invisible to every surface test).

test("agentBinSourceLabel names each resolution source the way operators see it quoted", () => {
  assert.equal(agentBinSourceLabel("env"), "TUMWATER_PI_BIN");
  assert.equal(agentBinSourceLabel("config"), "agentBin in tumwater.json");
  assert.equal(agentBinSourceLabel("default"), "the PATH default");
});

test("piMissingMessage for the default source is the plain pi-missing install message", () => {
  // Byte-identical to what cli.test.ts and doctor.test.ts expect the CLI to print: a default
  // resolution must never read as a configuration mistake.
  assert.equal(
    piMissingMessage({ bin: "pi", source: "default" }),
    "pi not found on PATH — install it (https://github.com/badlogic/pi-mono) or add its bin directory to your PATH",
  );
});

test("piMissingMessage for a configured source names the resolved value and where it came from", () => {
  // A wrong TUMWATER_PI_BIN or agentBin must never read as "pi is not installed" (BUGS.md
  // 2026-09-08 family): the message quotes the resolved value, its source, and keeps the
  // install hint — a wrong path and a missing install share the same remedy.
  const env = piMissingMessage({ bin: "/opt/pi/bin/pi", source: "env" });
  assert.match(env, /^pi not found — resolved "\/opt\/pi\/bin\/pi" from TUMWATER_PI_BIN is not an executable/);
  assert.match(env, /install it \(https:\/\/github\.com\/badlogic\/pi-mono\)/);
  assert.match(env, /point TUMWATER_PI_BIN at a working pi binary/);

  const config = piMissingMessage({ bin: "./my-pi", source: "config" });
  assert.match(config, /^pi not found — resolved "\.\/my-pi" from agentBin in tumwater\.json is not an executable/);
  assert.match(config, /point agentBin in tumwater\.json at a working pi binary/);
});

// plans/portability.md §5/7: the agent binary is TUMWATER_PI_BIN → agentBin → "pi". The
// resolver is precedence only (no filesystem calls — resolvability is the preflight sites'
// job); a path-shaped value is normalized against the process cwd AT RESOLUTION TIME, so
// the spawn — which runs with each tick's worktree as cwd — lands on the same file the run
// preflight and doctor checked.
test("resolveAgentBin: TUMWATER_PI_BIN beats agentBin beats the PATH default", () => {
  assert.deepEqual(resolveAgentBin({}), { bin: "pi", source: "default" });
  assert.deepEqual(resolveAgentBin({ agentBin: "/opt/pi/bin/pi" }), {
    bin: "/opt/pi/bin/pi",
    source: "config",
  });

  process.env.TUMWATER_PI_BIN = "/x/pi-override";
  try {
    assert.deepEqual(resolveAgentBin({ agentBin: "/opt/pi/bin/pi" }), {
      bin: "/x/pi-override",
      source: "env",
    });
    // A whitespace value falls through to config, so an empty export cannot wedge the fleet.
    process.env.TUMWATER_PI_BIN = "  ";
    assert.deepEqual(resolveAgentBin({ agentBin: "/opt/pi/bin/pi" }), {
      bin: "/opt/pi/bin/pi",
      source: "config",
    });
    process.env.TUMWATER_PI_BIN = "";
    assert.deepEqual(resolveAgentBin({ agentBin: "/opt/pi/bin/pi" }), {
      bin: "/opt/pi/bin/pi",
      source: "config",
    });
  } finally {
    delete process.env.TUMWATER_PI_BIN;
  }
});

test("resolveAgentBin normalizes a path-shaped value against the process cwd; a bare name is left to PATH", () => {
  const rel = resolveAgentBin({ agentBin: "bin/pi" });
  assert.equal(rel.source, "config");
  assert.equal(rel.bin, path.resolve("bin/pi")); // absolute, so the worktree cwd cannot redirect it

  const envRel = resolveAgentBin({});
  process.env.TUMWATER_PI_BIN = "./scripts/pi";
  try {
    const r = resolveAgentBin({});
    assert.equal(r.source, "env");
    assert.equal(r.bin, path.resolve("scripts/pi"));
  } finally {
    delete process.env.TUMWATER_PI_BIN;
  }
  assert.equal(envRel.bin, "pi"); // sanity: no env leak into the default case

  assert.equal(resolveAgentBin({ agentBin: "pi-wrapper" }).bin, "pi-wrapper");
  assert.equal(resolveAgentBin({ agentBin: "pi-wrapper" }).source, "config");
});

// plans/agent-backends.md "Config": each backend reads its own `backends.<id>.bin`, while the
// legacy `agentBin` remains pi's alias and `TUMWATER_<ID>_BIN` outranks both.
test("resolveAgentBin reads each agent's own entry; agentBin stays pi's legacy alias", () => {
  assert.deepEqual(resolveAgentBin({ backends: { pi: { bin: "/opt/pi" } }, agentBin: "/legacy" }), {
    bin: "/opt/pi",
    source: "config",
  });
  assert.deepEqual(
    resolveAgentBin({ backends: { claude: { bin: "/opt/claude" } }, agentBin: "/legacy" }, "claude"),
    { bin: "/opt/claude", source: "config" },
  );
  // The default binary is the agent's own name, so an unconfigured claude does not resolve as pi.
  assert.deepEqual(resolveAgentBin({}, "claude"), { bin: "claude", source: "default" });
  process.env.TUMWATER_CLAUDE_BIN = "/env/claude";
  try {
    assert.deepEqual(resolveAgentBin({ backends: { claude: { bin: "/opt/claude" } } }, "claude"), {
      bin: "/env/claude",
      source: "env",
    });
  } finally {
    delete process.env.TUMWATER_CLAUDE_BIN;
  }
});

test("agentMissingMessage names the agent and its own source, not pi's", () => {
  assert.equal(
    agentMissingMessage({ bin: "claude", source: "default" }, "claude"),
    "claude not found on PATH — install it or add its bin directory to your PATH",
  );
  const configured = agentMissingMessage({ bin: "/opt/claude", source: "config" }, "claude");
  assert.match(configured, /^claude not found — resolved "\/opt\/claude" from backends\.claude\.bin in tumwater\.json/);
  assert.match(configured, /point backends\.claude\.bin in tumwater\.json at a working claude binary/);
  assert.match(
    agentMissingMessage({ bin: "/env/claude", source: "env" }, "claude"),
    /from TUMWATER_CLAUDE_BIN/,
  );
  // pi keeps its pinned wording through the shared function.
  assert.equal(
    agentMissingMessage({ bin: "pi", source: "default" }, "pi"),
    piMissingMessage({ bin: "pi", source: "default" }),
  );
});
