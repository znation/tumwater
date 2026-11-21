import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECK_DECLARATION_LEAD,
  CHECK_DECLARATION_RETRY_MS,
  checkDeclarationPrompt,
  requestCheckDeclaration,
} from "../src/prompt/check-declaration-request.js";
import { queuedPrompts } from "../src/inbox/inbox.js";
import { checkDeclarationStatePath } from "../src/paths.js";
import { defaultConfig } from "../src/config/config.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";

// The self-declared check request (src/prompt/check-declaration-request.ts): a project with no
// deterministic check gets one director prompt, retried at most once a day per main head. These
// pin the gate from the inputs and the real queue, with injected seams so no real model runs.

const T = 1_000_000_000_000;
const HOUR = 60 * 60 * 1000;

/** A fresh repo whose only check is the one its test passes in: `npm` writes a package.json
 * with a test script and the node_modules directory detection needs beside it. */
function repoWithNpmTest(): string {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e 0" } }));
  fs.mkdirSync(path.join(root, "node_modules"));
  return root;
}

/** A recording submit seam: counts calls, enqueues nothing. */
function recorder(): { calls: string[]; submit: (root: string, text: string) => string } {
  const calls: string[] = [];
  return { calls, submit: (_root, text) => (calls.push(text), "") };
}

test("a project with no declared check queues the director one declaration prompt, and not a second while it is queued", async () => {
  const root = makeRepo();
  const first = await requestCheckDeclaration(root, defaultConfig(), { mainHead: "a", now: T, hasPin: async () => false });
  assert.equal(first.requested, true, "the first call requests the declaration");
  const queued = queuedPrompts(root);
  assert.equal(queued.length, 1, "exactly one director prompt is enqueued");
  assert.ok(queued[0]!.startsWith(CHECK_DECLARATION_LEAD), "the queued prompt leads with the marker");
  const second = await requestCheckDeclaration(root, defaultConfig(), { mainHead: "a", now: T, hasPin: async () => false });
  assert.equal(second.requested, false, "a second call while the prompt is queued requests nothing");
  assert.equal(queuedPrompts(root).length, 1, "still exactly one in the queue");
});

test("a declared check, from check.command or an npm test script, requests nothing", async () => {
  const configured = makeRepo();
  const withCommand = { ...defaultConfig(), check: { command: "node -e 0" } };
  const cmdRes = await requestCheckDeclaration(configured, withCommand, { mainHead: "a", now: T, hasPin: async () => false });
  assert.equal(cmdRes.requested, false, "a configured check.command requests nothing");
  assert.equal(queuedPrompts(configured).length, 0);

  const npm = repoWithNpmTest();
  const npmRes = await requestCheckDeclaration(npm, defaultConfig(), { mainHead: "a", now: T, hasPin: async () => false });
  assert.equal(npmRes.requested, false, "a package.json test script requests nothing");
  assert.equal(queuedPrompts(npm).length, 0);
});

test("a busy director and a held director pin each submit nothing", async () => {
  const busyRoot = makeRepo();
  const busy = recorder();
  const busyRes = await requestCheckDeclaration(busyRoot, defaultConfig(), {
    directorBusy: true,
    mainHead: "a",
    now: T,
    hasPin: async () => false,
    submit: busy.submit,
  });
  assert.equal(busyRes.requested, false, "a director already running submits nothing");
  assert.equal(busy.calls.length, 0);

  const pinRoot = makeRepo();
  const pin = recorder();
  const pinRes = await requestCheckDeclaration(pinRoot, defaultConfig(), {
    mainHead: "a",
    now: T,
    hasPin: async () => true,
    submit: pin.submit,
  });
  assert.equal(pinRes.requested, false, "a held (unmerged) director pin submits nothing");
  assert.equal(pin.calls.length, 0);
});

test("the retry gate: an unchanged head or a recent attempt submits nothing, a moved head after a day submits once", async () => {
  const record = { at: T, head: "a" };
  const cases: Array<{ name: string; head: string; now: number; expect: boolean }> = [
    { name: "same head at T+25h submits nothing", head: "a", now: T + 25 * HOUR, expect: false },
    { name: "a moved head at T+1h submits nothing", head: "b", now: T + HOUR, expect: false },
    { name: "a moved head at T+25h submits one prompt", head: "b", now: T + 25 * HOUR, expect: true },
  ];
  for (const c of cases) {
    const root = makeRepo();
    fs.mkdirSync(path.dirname(checkDeclarationStatePath(root)), { recursive: true });
    fs.writeFileSync(checkDeclarationStatePath(root), JSON.stringify(record));
    const rec = recorder();
    const res = await requestCheckDeclaration(root, defaultConfig(), {
      mainHead: c.head,
      now: c.now,
      hasPin: async () => false,
      submit: rec.submit,
    });
    assert.equal(res.requested, c.expect, c.name);
    assert.equal(rec.calls.length, c.expect ? 1 : 0, c.name);
  }
});

test("an unparsable attempt record requests now", async () => {
  const root = makeRepo();
  fs.mkdirSync(path.dirname(checkDeclarationStatePath(root)), { recursive: true });
  fs.writeFileSync(checkDeclarationStatePath(root), "{ not json");
  const rec = recorder();
  const res = await requestCheckDeclaration(root, defaultConfig(), {
    mainHead: "a",
    now: T,
    hasPin: async () => false,
    submit: rec.submit,
  });
  assert.equal(res.requested, true, "an unreadable record means request now");
  assert.equal(rec.calls.length, 1, "exactly one prompt");
});

test("a submit that throws reports the error and writes no attempt record", async () => {
  const root = makeRepo();
  const res = await requestCheckDeclaration(root, defaultConfig(), {
    mainHead: "a",
    now: T,
    hasPin: async () => false,
    submit: () => {
      throw new Error("inbox is read-only");
    },
  });
  assert.equal(res.requested, false);
  assert.equal(res.error, "inbox is read-only", "the enqueue error is reported, not propagated");
  assert.equal(fs.existsSync(checkDeclarationStatePath(root)), false, "no attempt record is written");
});

test("a successful request records the attempt, so the same head is not re-requested the same day", async () => {
  const root = makeRepo();
  const first = await requestCheckDeclaration(root, defaultConfig(), {
    mainHead: "a",
    now: T,
    hasPin: async () => false,
    submit: () => "",
  });
  assert.equal(first.requested, true);
  const written = JSON.parse(fs.readFileSync(checkDeclarationStatePath(root), "utf8")) as { at: number; head: string };
  assert.deepEqual(written, { at: T, head: "a" }, "the record holds the attempt's time and main head");
  const again = await requestCheckDeclaration(root, defaultConfig(), {
    mainHead: "a",
    now: T + CHECK_DECLARATION_RETRY_MS - 1,
    hasPin: async () => false,
    submit: () => "",
  });
  assert.equal(again.requested, false, "one millisecond short of a day is still too soon");
});

test("the declaration prompt names the request file and the nothing-to-do line, not the config file", () => {
  const prompt = checkDeclarationPrompt();
  assert.ok(prompt.startsWith(CHECK_DECLARATION_LEAD), "the prompt leads with the marker");
  assert.ok(prompt.includes(".tumwater-config-request.json"), "the prompt names the request file");
  assert.ok(prompt.includes("TUMWATER_NOTHING_TO_DO"), "the prompt names the nothing-to-do line");
  assert.ok(!prompt.includes("tumwater.json"), "the prompt does not name the config file");
});
