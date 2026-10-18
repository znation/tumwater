import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledExtensionPaths, PI_KEPT_BUILTINS, piArgs } from "../src/pi/pi-args.js";
import { defaultConfig, loadConfig } from "../src/config/config.js";
import { configForRole } from "../src/config/config-views.js";
import { piBackend } from "../src/pi/pi-backend.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

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
  // The first -e is a kept pi built-in (builtin:…), so find the first bundled path instead.
  const extPath = bundledExtensionPaths()[0]!;
  const extOffset = args.indexOf(extPath);
  assert.ok(extOffset !== -1, "extension flag present");
  assert.equal(args[extOffset - 1], "-e");
  // Tests run compiled from dist/test/, so resolving the same relative URL the code uses
  // points at dist/src/pi-extension/bounded-output.js — existing after npm run build.
  const expected = fileURLToPath(new URL("../src/pi-extension/bounded-output.js", import.meta.url));
  assert.equal(extPath, expected);
  assert.ok(path.isAbsolute(extPath), "extension path is absolute");
  assert.ok(fs.existsSync(extPath), `extension exists in dist: ${extPath}`);
  assert.ok(extOffset < args.indexOf("--no-skills"), "user piArgs still come after the extension");
});

test("piArgs loads the context-shake extension right after bounded-output", () => {
  const args = piArgs({ config: defaultConfig(), sessionDir: "/tmp/s", sessionName: "n" });
  const exts = args.flatMap((a, i) => (a === "-e" ? [args[i + 1]!] : []));
  const bundledExts = [...PI_KEPT_BUILTINS.map((b) => `builtin:${b}`), ...bundledExtensionPaths()];
  assert.deepEqual(exts, bundledExts);
  assert.deepEqual(exts.slice(PI_KEPT_BUILTINS.length).map((e) => path.basename(e)), [
    "bounded-output.js",
    "context-shake.js",
    "context-budget.js",
    "strip-thinking.js",
    "trim-system-prompt.js",
  ]);
  for (const e of exts.slice(PI_KEPT_BUILTINS.length)) assert.ok(fs.existsSync(e), `extension exists in dist: ${e}`);
});

test("piArgs skips discovered extensions and re-enables only the kept pi built-ins", () => {
  const args = piArgs({ config: defaultConfig(), sessionDir: "/tmp/s", sessionName: "n" });
  assert.ok(args.includes("--no-extensions"), "--no-extensions present");
  const noExt = args.indexOf("--no-extensions");
  const firstBundled = args.indexOf(bundledExtensionPaths()[0]!);
  assert.ok(noExt < firstBundled, "--no-extensions precedes tumwater's own -e extensions");
  for (const builtin of PI_KEPT_BUILTINS) {
    const i = args.indexOf(`builtin:${builtin}`);
    assert.ok(i !== -1, `builtin:${builtin} present`);
    assert.ok(i > noExt && i < firstBundled, `builtin:${builtin} sits after --no-extensions and before the bundled -e paths`);
  }
});

test("piArgs no longer loads the role-notes extension (notes ride tumwater-notes)", () => {
  const args = piArgs({ config: defaultConfig(), sessionDir: "/tmp/s", sessionName: "n" });
  const exts = args.flatMap((a, i) => (a === "-e" ? [args[i + 1]!] : []));
  const last = exts[exts.length - 1]!;
  assert.equal(path.basename(last), "trim-system-prompt.js", "the other bundled extensions keep their order");
  assert.ok(!exts.some((e) => path.basename(e) === "role-notes.js"), "role-notes.js is no longer bundled");
});

test("piArgs skips the extension for non-pi agents, keeps it for a configured pi path", () => {
  const base = { config: defaultConfig(), sessionDir: "/tmp/s", sessionName: "n" };
  assert.ok(!piArgs({ ...base, agentBin: "/usr/local/bin/other-agent" }).includes("-e"));
  assert.ok(!piArgs({ ...base, agentBin: "/usr/local/bin/other-agent" }).includes("--no-extensions"));
  assert.ok(piArgs({ ...base, agentBin: "/opt/tools/pi" }).includes("-e"));
  assert.ok(piArgs({ ...base, agentBin: "/opt/tools/pi" }).includes("--no-extensions"));
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

// BUGS.md 2026-10-18: the prompt was pi's last argv element, so it sat in every pi's `ps` line
// and one agent's `pkill -f "npm run test"` SIGTERMed every pi run on the host whose prompt
// mentions the check. The pi backend now hands the prompt to the runner as stdin.
test("the pi invocation carries the prompt on stdin, never in argv, fresh or resumed", () => {
  const prompt = "run `npm run test` before replying\nSUMMARY: …";
  for (const continueSession of [false, true]) {
    const inv = piBackend.invocation({
      cwd: "/tmp/w",
      prompt,
      config: defaultConfig(),
      sessionDir: "/tmp/s",
      sessionName: "n1",
      continueSession,
      kind: "author",
      agentBin: "pi",
      runMarker: "m",
    });
    assert.equal(inv.stdin, prompt, "the runner writes the prompt to pi's stdin");
    assert.ok(!inv.args.some((a) => a.includes("npm run test")), `no argv element carries prompt text: ${inv.args.join(" ")}`);
    assert.deepEqual(inv.args, piArgs({ config: defaultConfig(), sessionDir: "/tmp/s", sessionName: "n1", continueSession, agentBin: "pi" }));
  }
});

test("a selector-string model alone yields --provider <provider> --model <id>", () => {
  // The new one-key form (plans/model-tiers.md): the selector parses apart and piArgs keeps
  // passing provider/model/thinking separately.
  // Through the resolver: a config carrying only the selector string, as a tumwater.json
  // would, resolves to the triple piArgs passes separately.
  const config = configForRole({ ...defaultConfig(), model: "huggingface/zai-org/GLM-5.3-Flash:together:low" }, "feature");
  const args = piArgs({ config, sessionDir: "/tmp/s", sessionName: "n" });
  const providerAt = args.indexOf("--provider");
  const modelAt = args.indexOf("--model");
  const thinkingAt = args.indexOf("--thinking");
  assert.ok(providerAt !== -1 && modelAt !== -1 && thinkingAt !== -1);
  assert.equal(args[providerAt + 1], "huggingface");
  assert.equal(args[modelAt + 1], "zai-org/GLM-5.3-Flash:together");
  assert.equal(args[thinkingAt + 1], "low");
});
