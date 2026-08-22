import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { configForRole, defaultConfig, loadConfig } from "../src/config.js";
import { piArgs } from "../src/pi.js";
import { pruneOldFiles, rotateIfLarge } from "../src/files.js";
import { statusPayload, startGui } from "../src/gui.js";
import { initProject } from "../src/init.js";
import { inboxSize } from "../src/inbox.js";
import { makeRepo, tmpdir } from "./util.js";

// --- Per-role model/effort overrides ---

test("configForRole applies role overrides over top-level pi settings", () => {
  const config = defaultConfig();
  config.provider = "top-provider";
  config.model = "top-model";
  config.roles.feature = { enabled: true, model: "strong-model", thinking: "high" };
  const feature = configForRole(config, "feature");
  assert.equal(feature.provider, "top-provider");
  assert.equal(feature.model, "strong-model");
  assert.equal(feature.thinking, "high");
  const clean = configForRole(config, "clean");
  assert.equal(clean.model, "top-model");
  assert.equal(clean.thinking, undefined);
  assert.deepEqual(configForRole(config, "nonexistent"), config);
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

// --- Log rotation and session pruning ---

test("rotateIfLarge rotates once over the cap and replaces the previous rotation", () => {
  const dir = tmpdir();
  const file = path.join(dir, "log.jsonl");
  fs.writeFileSync(file, "x".repeat(100));
  assert.equal(rotateIfLarge(file, 1000), false);
  assert.equal(rotateIfLarge(file, 50), true);
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.readFileSync(file + ".1", "utf8").length, 100);
  fs.writeFileSync(file, "y".repeat(80));
  assert.equal(rotateIfLarge(file, 50), true);
  assert.equal(fs.readFileSync(file + ".1", "utf8")[0], "y", "old rotation replaced");
  assert.equal(rotateIfLarge(path.join(dir, "missing"), 50), false);
});

test("pruneOldFiles removes only files older than the retention window", () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "role"), { recursive: true });
  const oldFile = path.join(dir, "role", "old.jsonl");
  const newFile = path.join(dir, "role", "new.jsonl");
  fs.writeFileSync(oldFile, "old");
  fs.writeFileSync(newFile, "new");
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);
  assert.equal(pruneOldFiles(dir, 7), 1);
  assert.ok(!fs.existsSync(oldFile));
  assert.ok(fs.existsSync(newFile));
  assert.equal(pruneOldFiles(path.join(dir, "nope"), 7), 0);
});

// --- Web GUI ---

test("gui serves the dashboard, status JSON, and accepts prompts", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui test project");
  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const page = await (await fetch(base + "/")).text();
    assert.match(page, /<title>tumwater<\/title>/);

    const status = (await (await fetch(base + "/api/status")).json()) as ReturnType<typeof statusPayload> & {
      running: boolean;
      loops: Array<{ role: string; phase: string }>;
    };
    assert.equal(status.running, false);
    assert.ok(status.loops.some((l) => l.role === "director"));

    const post = await fetch(base + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello from the browser" }),
    });
    assert.equal(post.status, 200);
    assert.equal(inboxSize(repo), 1);

    const bad = await fetch(base + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "  " }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(base + "/nope")).status, 404);
  } finally {
    server.close();
  }
});
