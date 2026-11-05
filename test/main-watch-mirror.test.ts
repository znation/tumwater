/** The main watch's full check runs in its own `_main-full` mirror, on its own in-flight pass
 * (Hourly full check, part 2c/4): a per-head diff-rules pass and a gate's main-tip verdict run
 * in the shared `_gate-main` mirror and never wait behind a slow full run. New heads, culprits
 * and the full-check cadence live in main-watch.test.ts; the red confirm, spells and the diff
 * rules have their own files (fixtures/main-watch-fixtures.ts). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMainWatch } from "../src/baseline/main-watch.js";
import { mainTipVerdict } from "../src/baseline/main-red.js";
import { defaultConfig } from "../src/config/config.js";
import { fullMainWorktreePath, gateMainWorktreePath } from "../src/paths.js";
import { baselineFixture } from "./fixtures/runner-fixtures.js";
import { headSha, tmpdir } from "./fixtures/repo-fixtures.js";
import { change, clockAt, FAILING_OUTPUT, watchAt } from "./fixtures/main-watch-fixtures.js";

const HOUR = 7_200_000; // 2h: clears the seed run's checkedAt (real Date.now, stamped after the clock starts)

/** Wait until `pred()` is true, or fail after roughly `timeoutMs`. */
async function until(pred: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("the full check runs in _main-full, a mirror the gate's main-tip verdict does not use", async () => {
  const { root } = baselineFixture("improve", "echo ok");
  const watch = createMainWatch(root, "main", undefined, clockAt().now);
  await watchAt(watch, root);
  // The full-check mirror is beside the gate's, a distinct worktree.
  assert.notEqual(fullMainWorktreePath(root), gateMainWorktreePath(root));
  assert.ok(fs.existsSync(path.join(fullMainWorktreePath(root), ".git")), "the full-check mirror was created");
  // The gate's main-tip verdict answers from the gate mirror and the cached seed green, not a run.
  const verdict = await mainTipVerdict(root, "improve", "main", defaultConfig());
  assert.equal(verdict.status, "green");
});

test("the full check's run happens in _main-full, and the gate's main-tip verdict is served from _gate-main", async () => {
  // The check fails (red) while `bad.txt` is tracked. Only the `_main-full` mirror's run writes
  // the `started`/`done` markers (and it waits for the release file between them, so the full
  // check stays in flight), so the markers prove which mirror the full check ran in: the gate's
  // `_gate-main` never does.
  const fullStart = path.join(tmpdir(), "full-start");
  const release = path.join(tmpdir(), "full-release");
  const script =
    `if [ -f bad.txt ]; then if [ "$(basename "$PWD")" = "_main-full" ]; then ` +
    `echo started >> ${fullStart}; while [ ! -f ${release} ]; do sleep 1; done; echo done >> ${fullStart}; fi; ` +
    `${FAILING_OUTPUT}; exit 1; fi; echo ok`;
  const { root } = baselineFixture("improve", script);
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAt(watch, root); // the seed commit (no bad.txt): green, checkedAt stamped
  change(root, "bad.txt", "b"); // a code head that turns main red: its full check is due
  clock.advance(HOUR); // past the interval
  watch.poll(headSha(root), false, defaultConfig()); // the rules pass and the full pass start independently
  await until(
    () => fs.existsSync(fullStart) && fs.readFileSync(fullStart, "utf8").includes("started"),
    "the full run to start in _main-full",
  );
  // The full check's run is parked in the `_main-full` mirror (`started`/`done` are written only
  // by that worktree's run). The gate's main-tip verdict is served from the shared `_gate-main`
  // mirror and must answer while the full run is still in flight: a separate mirror is not enough
  // if the full pass's in-flight run swallows the gate's check for the same SHA.
  let verdict: Awaited<ReturnType<typeof mainTipVerdict>> | undefined;
  try {
    void mainTipVerdict(root, "improve", "main", defaultConfig()).then((v) => {
      verdict = v;
    });
    await until(() => verdict !== undefined, "the gate's main-tip verdict");
    assert.equal(verdict?.status, "red", "the gate's main-tip verdict answers red at the tip");
    assert.ok(
      !fs.readFileSync(fullStart, "utf8").includes("done"),
      "the gate's verdict arrived before the slow full run finished",
    );
  } finally {
    fs.writeFileSync(release, "");
    await watch.idle();
  }
  assert.ok(fs.readFileSync(fullStart, "utf8").includes("done"), "the full run settled in the _main-full mirror");
});
