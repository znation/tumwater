import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledExtensionPaths, piArgs } from "../src/pi/pi-args.js";
import { defaultConfig, loadConfig } from "../src/config/config.js";
import { configForRole } from "../src/config/config-views.js";
import { tmpdir } from "./repo-fixtures.js";

// The pi argv builder's tests, split out of pi.test.ts: how config (provider, model,
// thinking, user piArgs, per-role overrides), the bundled bounded-output extension, and
// session naming/continuation shape the command line runPi spawns with.

test("piArgs reflects config", () => {
  const config = defaultConfig();
  config.provider = "anthropic";
  config.model = "sonnet";
  config.thinking = "high";
  config.piArgs = ["--no-skills"];
  const args = piArgs({ config, sessionDir: "/tmp/s", sessionName: "n" });
  assert.deepEqual(args.slice(0, 3), ["--print", "--mode", "json"]);
  for (const expected of ["--provider", "anthropic", "--model", "sonnet", "--thinking", "high", "--no-skills"]) {
    assert.ok(args.includes(expected), `missing ${expected}`);
  }
});

// The bundled bounded-output extension rides on every pi run (PLANS.md "Bound tool output
// head+tail with a tumwater pi extension") — loaded before user piArgs so a user flag wins.

test("piArgs loads the bundled bounded-output extension before user piArgs", () => {
  const config = defaultConfig();
  config.piArgs = ["--no-skills"];
  const args = piArgs({ config, sessionDir: "/tmp/s", sessionName: "n" });
  const eIndex = args.indexOf("-e");
  assert.ok(eIndex !== -1, "-e flag present");
  const extPath = args[eIndex + 1]!;
  // Tests run compiled from dist/test/, so resolving the same relative URL the code uses
  // points at dist/src/pi-extension/bounded-output.js — existing after npm run build.
  const expected = fileURLToPath(new URL("../src/pi-extension/bounded-output.js", import.meta.url));
  assert.equal(extPath, expected);
  assert.ok(path.isAbsolute(extPath), "extension path is absolute");
  assert.ok(fs.existsSync(extPath), `extension exists in dist: ${extPath}`);
  assert.ok(eIndex < args.indexOf("--no-skills"), "user piArgs still come after the extension");
});

test("piArgs loads the context-budget extension right after bounded-output", () => {
  const args = piArgs({ config: defaultConfig(), sessionDir: "/tmp/s", sessionName: "n" });
  const exts = args.flatMap((a, i) => (a === "-e" ? [args[i + 1]!] : []));
  assert.deepEqual(exts, bundledExtensionPaths());
  assert.deepEqual(exts.map((e) => path.basename(e)), ["bounded-output.js", "context-budget.js"]);
  for (const e of exts) assert.ok(fs.existsSync(e), `extension exists in dist: ${e}`);
});

test("piArgs skips the extension for non-pi agents, keeps it for a configured pi path", () => {
  const base = { config: defaultConfig(), sessionDir: "/tmp/s", sessionName: "n" };
  assert.ok(!piArgs({ ...base, agentBin: "/usr/local/bin/other-agent" }).includes("-e"));
  assert.ok(piArgs({ ...base, agentBin: "/opt/tools/pi" }).includes("-e"));
});

test("piArgs omits unset options", () => {
  const args = piArgs({ config: defaultConfig(), sessionDir: "/tmp/s", sessionName: "n" });
  assert.ok(!args.includes("--provider"));
  assert.ok(!args.includes("--model"));
  assert.ok(!args.includes("--thinking"));
});

test("role overrides flow through to the pi argv and round-trip via config files", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "tumwater.json"),
    JSON.stringify({ model: "cheap", roles: { bugfix: { enabled: true, model: "expensive", provider: "anthropic" } } }),
  );
  const config = loadConfig(dir);
  const args = piArgs({ config: configForRole(config, "bugfix"), sessionDir: "/tmp/s", sessionName: "n" });
  assert.ok(args.includes("expensive"));
  assert.ok(args.includes("anthropic"));
  const cheap = piArgs({ config: configForRole(config, "clean"), sessionDir: "/tmp/s", sessionName: "n" });
  assert.ok(cheap.includes("cheap"));
  assert.ok(!cheap.includes("anthropic"));
});

test("piArgs starts fresh sessions with a name and resumes with --continue", () => {
  const base = { config: defaultConfig(), sessionDir: "/tmp/s", sessionName: "n1" };
  const fresh = piArgs(base);
  assert.ok(fresh.includes("-n"), "fresh runs are named");
  assert.ok(!fresh.includes("--continue"));
  const resumed = piArgs({ ...base, continueSession: true });
  assert.ok(resumed.includes("--continue"), "the within-tick retry resumes the session");
  assert.ok(!resumed.includes("-n"), "resumed runs keep their existing name");
});
