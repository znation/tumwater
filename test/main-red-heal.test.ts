import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mainRedHealNote, mainRedHealPrompt, queueCulpritHeal } from "../src/baseline/main-red.js";
import { createMainWatch } from "../src/baseline/main-watch.js";
import { queuedRolePrompts } from "../src/inbox/inbox.js";
import { shortSha } from "../src/text/format.js";
import { roleInboxDir } from "../src/paths.js";
import { mainRedHolds, warningMessages } from "./fixtures/log-fixtures.js";
import { errnoError, patchFsMethod } from "./helpers/fs-faults.js";
import { baselineFixture, fakeNpm } from "./fixtures/runner-fixtures.js";
import { headSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { defaultConfig } from "../src/config/config.js";

// The red-main healer's dedup state (src/baseline/main-red.ts) is module-level, so this file runs
// in its own process: lastHealKey and lastMainRedSha start fresh here.

async function watchAt(watch: ReturnType<typeof createMainWatch>, root: string): Promise<void> {
  watch.poll(headSha(root), false, defaultConfig());
  await watch.idle();
}

test("a failing set queues one heal prompt in any order, and queues another after main turns green", async () => {
  const flags = tmpdir();
  const green = path.join(flags, "green");
  const swap = path.join(flags, "swap");
  const script =
    `if [ -e ${green} ]; then exit 0; fi; ` +
    `if [ -e ${swap} ]; then echo '✖ heal-beta (1ms)'; echo '✖ heal-alpha (1ms)'; ` +
    `else echo '✖ heal-alpha (1ms)'; echo '✖ heal-beta (1ms)'; fi; exit 1`;
  const { root, wt } = baselineFixture("coverage", script);
  const restore = fakeNpm(script);
  const watch = createMainWatch(root, "main");
  let n = 0;
  // A code-file change, so a commit after a green main is checked rather than inheriting it.
  const newCommit = (): void => {
    fs.writeFileSync(path.join(root, "index.js"), `// ${++n}\n`);
    sh(root, "git", "add", "-A");
    sh(root, "git", "commit", "-q", "-m", `commit-${n}`);
    sh(wt, "git", "reset", "--hard", "main");
  };
  try {
    newCommit();
    assert.ok(await mainRedHealNote(root, "coverage", wt), "a red main yields a heal note");
    assert.equal(queuedRolePrompts(root, "ci").length, 1, "first red queues one prompt");

    fs.writeFileSync(swap, "");
    newCommit();
    assert.ok(await mainRedHealNote(root, "coverage", wt));
    assert.equal(mainRedHolds(root).length, 2, "the new red SHA still pages");
    assert.equal(queuedRolePrompts(root, "ci").length, 1, "same set in another order: no second prompt");

    fs.writeFileSync(green, "");
    fs.rmSync(swap);
    newCommit();
    // Settle a green poll of the main watch: it clears the heal key (INV-AZ2).
    await watchAt(watch, root);
    assert.equal(queuedRolePrompts(root, "ci").length, 1, "green main queues nothing");

    fs.rmSync(green);
    newCommit();
    assert.ok(await mainRedHealNote(root, "coverage", wt));
    assert.equal(queuedRolePrompts(root, "ci").length, 2, "the set returning after green is healed again");
  } finally {
    restore();
  }
});

test("a heal prompt that cannot be queued warns and is queued at the next red commit", async () => {
  const script = "echo '✖ heal-gamma (1ms)'; exit 1";
  const { root, wt } = baselineFixture("coverage", script);
  const restore = fakeNpm(script);
  let n = 100;
  const newCommit = (): void => {
    fs.writeFileSync(path.join(root, "index.js"), `// ${++n}\n`);
    sh(root, "git", "add", "-A");
    sh(root, "git", "commit", "-q", "-m", `commit-${n}`);
    sh(wt, "git", "reset", "--hard", "main");
  };
  try {
    newCommit();
    const inbox = roleInboxDir(root, "ci");
    const undo = patchFsMethod("writeFileSync", (orig) => (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith(inbox)) throw errnoError("ENOSPC");
      return orig(...args);
    });
    try {
      assert.ok(await mainRedHealNote(root, "coverage", wt), "the hand-off resolves despite the unqueueable prompt");
    } finally {
      undo();
    }
    assert.equal(queuedRolePrompts(root, "ci").length, 0);
    const warnings = warningMessages(root).filter((m) => /could not queue the heal prompt for ci: .*ENOSPC/.test(m));
    assert.equal(warnings.length, 1, warningMessages(root).join("\n"));

    newCommit();
    assert.ok(await mainRedHealNote(root, "coverage", wt));
    assert.equal(queuedRolePrompts(root, "ci").length, 1, "the next red commit queues the heal");
  } finally {
    restore();
  }
});

test("queueCulpritHeal never throws: a prompt that cannot be queued warns and the culprit goes unanswered", async () => {
  // The watch's onCulprit calls queueCulpritHeal from a callback whose caller discards the result,
  // so the remedy itself must not throw: an unwritable ci inbox is warned (the same guard
  // warnMainRedOnce uses), and the call returns.
  const { root } = baselineFixture("coverage", "echo ok");
  const inbox = roleInboxDir(root, "ci");
  const undo = patchFsMethod("writeFileSync", (orig) => (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith(inbox)) throw errnoError("ENOSPC");
    return orig(...args);
  });
  try {
    queueCulpritHeal(root, "a".repeat(40), { culprit: "b".repeat(40), failingTests: ["t1"] });
  } finally {
    undo();
  }
  assert.equal(queuedRolePrompts(root, "ci").length, 0, "nothing was queued");
  const warnings = warningMessages(root).filter((m) => /could not queue the heal prompt for ci: .*ENOSPC/.test(m));
  assert.equal(warnings.length, 1, warningMessages(root).join("\n"));
});

test("mainRedHealPrompt with a culprit names it and adds the failing and tail clauses only when it has them", () => {
  const sha = "0123456789abcdef";
  const culprit = "fedcba9876543210";
  const named = ` The watch named ${shortSha(culprit)} as the commit that turned it red.`;
  assert.equal(mainRedHealPrompt(sha, { culprit, failingTests: [] }), mainRedHealPrompt(sha) + named);

  const full = mainRedHealPrompt(sha, { culprit, failingTests: ["t1", "t2"], outputTail: ["line a", "line b"] });
  assert.ok(full.endsWith("Failing: t1; t2. Output tail: line a | line b"), full);
  assert.ok(!full.includes("\n"), "one line");

  const noTail = mainRedHealPrompt(sha, { culprit, failingTests: ["t1"], outputTail: [] });
  assert.ok(!noTail.includes("Output tail"), noTail);
  assert.ok(noTail.endsWith("Failing: t1."), noTail);
});
