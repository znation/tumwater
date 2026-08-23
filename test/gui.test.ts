import test from "node:test";
import assert from "node:assert/strict";
import { statusPayload, startGui } from "../src/gui.js";
import { initProject } from "../src/init.js";
import { inboxSize } from "../src/inbox.js";
import { makeRepo } from "./util.js";

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
