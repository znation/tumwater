import { sleep } from "./wait.js";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { runTui, type TuiSeams, type TuiStdin, type TuiStdout } from "../src/ui/tui.js";
import { readBuildInfo, type BuildInfo } from "../src/build-info.js";
import { makeRepo } from "./repo-fixtures.js";
import { initProject } from "../src/init.js";

// The TUI's self-reload wiring (runTui's watch onTrigger: latch the request, wake the main
// loop, tear the terminal down, then re-exec at most once) is the half of the redeploy story
// createReloadWatch's own tests cannot pin — they drive the watch with a test-local callback,
// so a TUI that re-execed twice or skipped its teardown would pass those. The watch only
// polls a self-hosted install, which a temp repo is not, so the test injects the watch's
// seams instead — the same treatment startGui's wiring got — plus a fake terminal, because
// the keypress loop needs raw mode a piped test process cannot enter.

/** A terminal stand-in: keypresses are emitted directly (already parsed, the way readline
 * delivers them), and every raw-mode toggle and teardown call is recorded for assertions. */
class FakeTerminal extends EventEmitter implements TuiStdin, TuiStdout {
  isTTY = true;
  rows = 40;
  columns = 120;
  rawModes: boolean[] = [];
  pauses = 0;
  writes: string[] = [];

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
  }
  pause(): void {
    this.pauses++;
  }
  /** Deliver one keypress the way readline does: a possibly-undefined string plus a Key. */
  keypress(key: Partial<readline.Key>): void {
    this.emit("keypress", undefined, { name: "", ...key } as readline.Key);
  }
  write(s: string): void {
    this.writes.push(s);
  }
  get asSeams(): Pick<TuiSeams, "stdin" | "stdout"> {
    return { stdin: this, stdout: this };
  }
}

function reloadWatchSeams(disk: () => BuildInfo | null, reexecs: { n: number }) {
  return {
    isSelfHostedImpl: async () => true,
    readDisk: disk,
    intervalMs: 5,
    reexec: () => {
      reexecs.n++;
    },
  };
}

test("the TUI tears down its terminal and re-execs exactly once when a newer build appears", async () => {
  const repo = makeRepo();
  await initProject(repo, "tui self-reload wiring");

  const startup = readBuildInfo();
  assert.ok(startup, "the suite runs from a stamped dist");
  let disk: BuildInfo | null = startup;
  const reexecs = { n: 0 };
  const term = new FakeTerminal();
  const done = runTui(repo, {
    ...term.asSeams,
    watch: reloadWatchSeams(() => disk, reexecs),
  });
  try {
    // A stamp naming the startup sha is not a newer build: several polls pass, raw mode is
    // on, and the loop is still rendering — no reload, no teardown.
    await sleep(60);
    assert.equal(reexecs.n, 0, "an unchanged dist stamp never reloads");
    assert.deepEqual(term.rawModes, [true], "raw mode was entered");
    assert.ok(term.writes.some((w) => w.length > 1), "the TUI rendered at least one frame");

    // A redeploy swaps dist/ under the running process: the watch wakes the main loop, which
    // tears the terminal down (raw mode off, stdin paused, newline written) and re-execs.
    // Firing latches: a stamp that changes again while the old process winds down must not
    // re-exec twice.
    disk = { ...startup, sha: `${startup.sha}-newer` };
    await done;
    assert.deepEqual(term.rawModes, [true, false], "raw mode was restored before the re-exec");
    assert.equal(term.pauses, 1, "stdin was paused");
    assert.equal(term.writes.at(-1), "\n", "the teardown newline was written");
    disk = { ...startup, sha: "third-sha" };
    await sleep(60);
    assert.equal(reexecs.n, 1, "the reload fires at most once per process, and the watch is stopped");
  } finally {
    // If an assert fired before the trigger, the loop is still waiting: Ctrl+C ends it the
    // way a user would.
    term.keypress({ ctrl: true, name: "c" });
    await done;
  }
});

test("Ctrl+C ends the TUI cleanly and never re-execs while the dist stamp is unchanged", async () => {
  const repo = makeRepo();
  await initProject(repo, "tui ctrl-c teardown");

  const startup = readBuildInfo();
  assert.ok(startup, "the suite runs from a stamped dist");
  const reexecs = { n: 0 };
  const term = new FakeTerminal();
  const done = runTui(repo, {
    ...term.asSeams,
    watch: reloadWatchSeams(() => startup, reexecs),
  });
  await sleep(60);
  term.keypress({ ctrl: true, name: "c" });
  await done;
  assert.equal(reexecs.n, 0, "a Ctrl+C teardown never re-execs");
  assert.deepEqual(term.rawModes, [true, false]);
  assert.equal(term.pauses, 1);
  assert.equal(term.writes.at(-1), "\n");
});

test("runTui without a terminal still refuses before any seam or watch is armed", async () => {
  const repo = makeRepo();
  // No TTY stand-ins and no TTY behind process.stdin in a test process: the guard fires
  // first — a runTui that armed the watch before the guard could re-exec into the same
  // non-TTY error forever.
  await assert.rejects(runTui(repo), /interactive terminal/);
});
