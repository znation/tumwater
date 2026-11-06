import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mainRedHealNote, mainRedHealPrompt, mainTipVerdict, queueCulpritHeal } from "../src/baseline/main-red.js";
import { createMainWatch } from "../src/baseline/main-watch.js";
import { enqueueRolePrompt, queuedRolePrompts } from "../src/inbox/inbox.js";
import { shortSha } from "../src/text/format.js";
import { roleInboxDir } from "../src/paths.js";
import { eventsOfType, mainRedHolds, warningMessages } from "./fixtures/log-fixtures.js";
import { errnoError, patchFsMethod } from "./helpers/fs-faults.js";
import { baselineFixture, fakeNpm } from "./fixtures/runner-fixtures.js";
import { headSha, mainSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { change, clockAt, culpritFixture, FAILING_OUTPUT } from "./fixtures/main-watch-fixtures.js";
import { defaultConfig } from "../src/config/config.js";

// The hourly cadence (part 2b/4): a test that must make a fresh head's full check actually run
// advances the injected clock past the seed run's checkedAt stamp (real Date.now, set after the
// clock started). 2h clears it comfortably.
const HOUR = 7_200_000;

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
    // Settle a green poll of the main watch: it clears the heal key (INV-AZ2) and drops the
    // waiting heal prompt, whose red commit the green tip contains (INV-AZ5).
    await watchAt(watch, root);
    assert.equal(queuedRolePrompts(root, "ci").length, 0, "green main drops the waiting prompt");

    fs.rmSync(green);
    newCommit();
    assert.ok(await mainRedHealNote(root, "coverage", wt));
    assert.equal(queuedRolePrompts(root, "ci").length, 1, "the set returning after green is healed again");
  } finally {
    restore();
  }
});

test("a heal prompt for a new failing set replaces the heal prompt waiting, and other prompts stay", async () => {
  const second = path.join(tmpdir(), "second");
  const script = `if [ -e ${second} ]; then echo '✖ replace-beta (1ms)'; else echo '✖ replace-alpha (1ms)'; fi; exit 1`;
  const { root, wt } = baselineFixture("coverage", script);
  const restore = fakeNpm(script);
  let n = 200;
  const newCommit = (): string => {
    fs.writeFileSync(path.join(root, "index.js"), `// ${++n}\n`);
    sh(root, "git", "add", "-A");
    sh(root, "git", "commit", "-q", "-m", `commit-${n}`);
    sh(wt, "git", "reset", "--hard", "main");
    return mainSha(root);
  };
  try {
    const first = newCommit();
    assert.ok(await mainRedHealNote(root, "coverage", wt));
    enqueueRolePrompt(root, "ci", "Look at the e2e tier when you get a chance.");

    fs.writeFileSync(second, "");
    const next = newCommit();
    assert.ok(await mainRedHealNote(root, "coverage", wt));
    assert.deepEqual(
      queuedRolePrompts(root, "ci"),
      ["Look at the e2e tier when you get a chance.", mainRedHealPrompt(next)],
      "the new red's prompt took the older one's place; the operator's prompt stayed",
    );
    const dropped = eventsOfType(root, "prompt_cancelled");
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]?.source, "ci");
    assert.ok(String(dropped[0]?.preview).includes(shortSha(first)), String(dropped[0]?.preview));
  } finally {
    restore();
  }
});

test("queueCulpritHeal replaces the heal prompt waiting, so a long red leaves ci one prompt", () => {
  const { root } = baselineFixture("coverage", "echo ok");
  for (const c of ["a", "b", "c"]) {
    const sha = c.repeat(40);
    queueCulpritHeal(root, sha, { culprit: sha, failingTests: [`culprit-${c}`] });
  }
  const queued = queuedRolePrompts(root, "ci");
  assert.equal(queued.length, 1, queued.join("\n"));
  assert.ok(queued[0]?.startsWith(mainRedHealPrompt("c".repeat(40))), queued.join("\n"));
});

test("a green main drops the waiting heal prompts for reds it contains and keeps the rest", async () => {
  // The pile-up a build without the replacement left behind (2026-11-01: 69 heal prompts for one
  // long red): ci's hand-off finding main green drops every heal prompt whose red commit the green
  // tip contains, keeps one naming a commit main does not contain, and keeps other prompts.
  const { root, wt } = baselineFixture("coverage", "exit 0");
  const restore = fakeNpm("exit 0");
  try {
    const seed = mainSha(root);
    fs.writeFileSync(path.join(root, "index.js"), "// green\n");
    sh(root, "git", "add", "-A");
    sh(root, "git", "commit", "-q", "-m", "green tip");
    const tip = mainSha(root);
    sh(wt, "git", "reset", "--hard", "main");
    const elsewhere = sh(root, "git", "commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "not on main");
    enqueueRolePrompt(root, "ci", mainRedHealPrompt(seed));
    enqueueRolePrompt(root, "ci", mainRedHealPrompt(tip, { culprit: seed, failingTests: ["drop-me"] }));
    enqueueRolePrompt(root, "ci", "Look at the e2e tier when you get a chance.");
    enqueueRolePrompt(root, "ci", mainRedHealPrompt(elsewhere));

    assert.equal(await mainRedHealNote(root, "coverage", wt), undefined, "main is green");
    assert.deepEqual(queuedRolePrompts(root, "ci"), [
      "Look at the e2e tier when you get a chance.",
      mainRedHealPrompt(elsewhere),
    ]);
    assert.equal(eventsOfType(root, "prompt_cancelled").length, 2);
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

test("a heal prompt that mainTipVerdict cannot queue still settles the red verdict and warns", async () => {
  // mainTipVerdict wraps its whole tip check in a try/catch that turns any throw into
  // "unavailable", so a regressed guard would blame the change under judgment for main's own
  // failure. The seed commit main is red (its declared check fails), and the same guard
  // warnMainRedOnce that the ci hand-off uses clears the heal key, so the verdict stays "red".
  const script = "echo '✖ tip-heal-delta (1ms)'; exit 1";
  const { root } = baselineFixture("coverage", script);
  const restore = fakeNpm(script);
  try {
    const inbox = roleInboxDir(root, "ci");
    const undo = patchFsMethod("writeFileSync", (orig) => (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith(inbox)) throw errnoError("ENOSPC");
      return orig(...args);
    });
    try {
      const verdict = await mainTipVerdict(root, "coverage", "main", defaultConfig());
      assert.equal(verdict.status, "red", JSON.stringify(verdict));
      if (verdict.status === "red") assert.equal(verdict.sha, mainSha(root));
    } finally {
      undo();
    }
    assert.equal(queuedRolePrompts(root, "ci").length, 0, "nothing was queued");
    const warnings = warningMessages(root).filter((m) => /could not queue the heal prompt for ci: .*ENOSPC/.test(m));
    assert.equal(warnings.length, 1, warningMessages(root).join("\n"));

    // A second red SHA on main: the failed enqueue cleared the heal key, so this verification
    // queues the heal prompt.
    fs.writeFileSync(path.join(root, "index.js"), "// red again\n");
    sh(root, "git", "add", "-A");
    sh(root, "git", "commit", "-q", "-m", "commit-2");
    const second = await mainTipVerdict(root, "coverage", "main", defaultConfig());
    assert.equal(second.status, "red", JSON.stringify(second));
    assert.equal(queuedRolePrompts(root, "ci").length, 1, "the next red verification queues the heal");
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

test("a bisected red opener is the culprit the heal prompt names", async () => {
  // Hourly full check part 3a/4: the watch bisects the opener by re-running only the failing
  // tests, and the onCulprit hand-off (queueCulpritHeal via the same culprit) queues the heal
  // prompt naming that bisected commit, not the newest tip.
  const { root } = culpritFixture();
  const file = path.join(tmpdir(), "rerun.sh");
  fs.writeFileSync(file, `[ -f bad.txt ] && { ${FAILING_OUTPUT}; exit 1; }; exit 0`);
  const config = { ...defaultConfig(), check: { command: "", rerunCommand: `sh ${file}` } };
  const clock = clockAt();
  const watch = createMainWatch(root, "main", (culprit) => {
    queueCulpritHeal(root, culprit.tip, { culprit: culprit.commit, failingTests: culprit.failingTests });
  }, clock.now);
  const watchAt = async (): Promise<void> => {
    watch.poll(headSha(root), false, config);
    await watch.idle();
  };
  await watchAt(); // seed: green, cached
  const broken = change(root, "bad.txt", "b"); // the commit that opens the red
  change(root, "extra.txt", "x"); // a later commit on top, its tree still red
  clock.advance(HOUR);
  await watchAt();
  const prompt = queuedRolePrompts(root, "ci")[0] ?? "";
  assert.ok(prompt.includes(shortSha(broken)), prompt);
  assert.ok(prompt.includes("Failing: first"), prompt);
});

test("mainRedHealPrompt hands the healer the command that re-runs only the failing tests", () => {
  const prompt = mainRedHealPrompt("0123456789abcdef", {
    culprit: "fedcba9876543210",
    failingTests: ["t1"],
    rerun: "npm run test:rerun -- 'a.test#t1'",
  });
  assert.ok(
    prompt.includes(
      "Failing: t1. Run only the failing tests, to reproduce them and again to prove the fix, with: npm run test:rerun -- 'a.test#t1'",
    ),
    prompt,
  );
});
