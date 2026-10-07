import test from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init/init.js";
import { inboxSize } from "../src/inbox/inbox.js";
import { postJson, startLocalGui } from "./gui-fixtures.js";
import { makeRepo } from "./repo-fixtures.js";

// The dashboard's --token gate, split out of gui.test.ts's server grab-bag: the open-by-default
// behavior, the 401 JSON every gated route answers with, the credential's accepted spellings,
// and the served page's own token plumbing.

test("gui without a token keeps every route open — today's behavior byte-for-byte", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui open project");
  const { server, base } = await startLocalGui(repo);
  try {
    assert.equal((await fetch(base + "/")).status, 200);
    assert.equal((await fetch(base + "/api/status")).status, 200);
  } finally {
    server.close();
  }
});

test("the token gate returns 401 JSON for missing, wrong, and empty credentials", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui token project");
  const { server, base } = await startLocalGui(repo, "s3cret");
  try {
    // Every route is gated — the page, a GET /api/*, and a POST /api/*.
    for (const route of ["/", "/api/status", "/api/prompt"]) {
      const missing = await fetch(base + route);
      assert.equal(missing.status, 401, `${route}: no credential`);
      assert.deepEqual(await missing.json(), { error: "token required" });

      const wrong = await fetch(base + route, { headers: { authorization: "Bearer nope" } });
      assert.equal(wrong.status, 401, `${route}: wrong credential`);
      assert.deepEqual(await wrong.json(), { error: "token required" });

      const empty = await fetch(base + route, { headers: { authorization: "Bearer " } });
      assert.equal(empty.status, 401, `${route}: empty credential`);
      assert.deepEqual(await empty.json(), { error: "token required" });
    }
  } finally {
    server.close();
  }
});

test("the token gate accepts the credential as a Bearer header or ?token=, then serves today's responses", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui token accept project");
  const { server, base } = await startLocalGui(repo, "s3cret");
  try {
    const page = await fetch(base + "/", { headers: { authorization: "Bearer s3cret" } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>tumwater<\/title>/);

    const status = await fetch(base + "/api/status?token=s3cret");
    assert.equal(status.status, 200);
    const payload = (await status.json()) as { running: boolean };
    assert.equal(payload.running, false);

    const post = await postJson(base, "/api/prompt?token=s3cret", { text: "hello fleet" });
    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), { ok: true });
    assert.equal(inboxSize(repo), 1, "the prompt actually landed behind the gate");
  } finally {
    server.close();
  }
});

test("the dashboard client sends the Bearer token and strips ?token= from the address bar", async () => {
  // The token plumbing lives in the served page's inline script; asserted against
  // GUI_PAGE, where it actually runs, alongside the existing inline-script assertions.
  const { GUI_PAGE } = await import("../src/ui/gui/gui-page.js");
  assert.match(
    GUI_PAGE,
    /new URLSearchParams\(location\.search\)\.get\("token"\)/,
    "token read once from the URL",
  );
  assert.match(
    GUI_PAGE,
    /headers\.set\("authorization", "Bearer " \+ guiToken\)/,
    "apiFetch attaches the Bearer header to every request",
  );
  assert.match(
    GUI_PAGE,
    /searchParams\.delete\("token"\)/,
    "?token= cleared from the address bar after load",
  );
});
