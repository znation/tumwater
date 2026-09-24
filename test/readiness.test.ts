import { test } from "node:test";
import assert from "node:assert/strict";
import { agentBinSourceLabel, piMissingMessage } from "../src/readiness.js";

// Unit coverage for src/readiness.ts's agent-binary resolution messages. The module exists so
// that cli.ts's fail-fast, doctor.ts's report, and pi.ts's spawn errors describe the same
// missing-binary problem with the same words — its contract is that the wording cannot drift
// between the surfaces that quote it. cli.test.ts and doctor.test.ts pin the wording
// end-to-end through the CLI/doctor surfaces; these tests pin the shared source directly,
// including the "default" label whose case the other surfaces never reach (cli.ts and pi.ts
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
