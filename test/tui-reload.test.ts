import { sleep, waitFor } from "./wait.js";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runTui, type TuiSeams, type TuiStdin, type TuiStdout } from "../src/ui/tui.js";
import { readBuildInfo, type BuildInfo } from "../src/build/build-info.js";
import { DASHBOARD_CHILD_ENV } from "../src/self-reload.js";
import { makeRepo } from "./repo-fixtures.js";
import { initProject } from "../src/init/init.js";

// The TUI's self-reload wiring (runTui's watch onTrigger: latch the request, wake the main
// loop, tear the terminal down, then re-exec at most once) is the half of the redeploy story
// createReloadWatch's own tests cannot pin — they drive the watch with a test-local callback,
// so a TUI that re-execed twice or skipped its teardown would pass those. The watch only
// polls a self-hosted install, which a temp repo is not, so the test injects the watch's
// seams instead — the same treatment startGui's wiring got — plus a fake terminal, because
// the keypress loop needs raw mode a piped test process cannot enter.

/** A terminal stand-in: keys are delivered as raw terminal bytes (the way a keyboard
 * feeds ink's input parser), every raw-mode toggle is recorded, and the Readable.read
 * surface ink drains is a simple queue. */
class FakeTerminal extends EventEmitter implements TuiStdin, TuiStdout {
  isTTY = true;
  rows = 40;
  columns = 120;
  rawModes: boolean[] = [];
  writes: string[] = [];
  #queue: string[] = [];

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
  }
  setEncoding(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null {
    return this.#queue.length > 0 ? (this.#queue.shift() as string) : null;
  }
  /** Deliver one keypress as its raw terminal bytes: Ctrl+letter as its C0 code, named
   * keys as their escape sequences — ink's parser decodes them back into the same key. */
  keypress(key: { ctrl?: boolean; name?: string }): void {
    const raw = key.ctrl && key.name
      ? String.fromCharCode(key.name.charCodeAt(0) - 96)
      : key.name === "return"
        ? "\r"
        : "";
    this.#queue.push(raw);
    this.emit("readable");
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
    // tears the terminal down (raw mode restored off, cursor shown, newline written) and
    // re-execs. Firing latches: a stamp that changes again while the old process winds down
    // must not re-exec twice.
    disk = { ...startup, sha: `${startup.sha}-newer` };
    await done;
    await new Promise((r) => setImmediate(r)); // ink's raw-mode teardown is a microtask at unmount
    assert.deepEqual(term.rawModes, [true, false], "raw mode was restored before the re-exec");
    assert.equal(term.writes.at(-1), "\n", "the teardown newline was written");
    disk = { ...startup, sha: "third-sha" };
    await sleep(60);
    assert.equal(reexecs.n, 1, "the reload fires at most once per process, and the watch is stopped");
  } finally {
    // If an assert fired before the trigger, the loop is still waiting: Ctrl+D ends it the
    // way a user would.
    term.keypress({ ctrl: true, name: "d" });
    await done;
  }
});

test("Ctrl+D ends the TUI cleanly and never re-execs while the dist stamp is unchanged", async () => {
  const repo = makeRepo();
  await initProject(repo, "tui ctrl-d teardown");

  const startup = readBuildInfo();
  assert.ok(startup, "the suite runs from a stamped dist");
  const reexecs = { n: 0 };
  const term = new FakeTerminal();
  const done = runTui(repo, {
    ...term.asSeams,
    watch: reloadWatchSeams(() => startup, reexecs),
  });
  await sleep(60);
  term.keypress({ ctrl: true, name: "d" });
  await done;
  await new Promise((r) => setImmediate(r)); // ink's raw-mode teardown is a microtask at unmount
  assert.equal(reexecs.n, 0, "a Ctrl+D teardown never re-execs");
  assert.deepEqual(term.rawModes, [true, false]);
  assert.equal(term.writes.at(-1), "\n");
});

test("a reloaded TUI whose reload supervisor dies hands the terminal back and ends without re-exec", async () => {
  // The orphan wiring: a supervised child (the mark names its supervisor) whose supervisor
  // was SIGKILLed takes the quit teardown — raw mode restored, newline written — and returns,
  // never re-exec'ing: there is no supervisor left to respawn it.
  const repo = makeRepo();
  await initProject(repo, "tui supervisor-death teardown");

  const startup = readBuildInfo();
  assert.ok(startup, "the suite runs from a stamped dist");
  const reexecs = { n: 0 };
  let ppid = 4242;
  const term = new FakeTerminal();
  const done = runTui(repo, {
    ...term.asSeams,
    watch: reloadWatchSeams(() => startup, reexecs),
    supervisor: { env: { [DASHBOARD_CHILD_ENV]: "4242" }, ppid: () => ppid, intervalMs: 5 },
  });
  try {
    await sleep(60);
    assert.deepEqual(term.rawModes, [true], "under a live supervisor the TUI keeps running");
    ppid = 1; // the supervisor died outright and the child reparented
    // Bounded, not a bare await: a TUI that ignored its supervisor's death would wait for
    // keys forever, and this file with it — the finally's Ctrl+D ends it after the failure.
    let ended = false;
    void done.then(() => (ended = true));
    await waitFor(() => ended, "the TUI to end once its supervisor is gone", 10_000);
    await new Promise((r) => setImmediate(r)); // ink's raw-mode teardown is a microtask at unmount
    assert.deepEqual(term.rawModes, [true, false], "raw mode was restored");
    assert.equal(term.writes.at(-1), "\n", "the teardown newline was written");
    assert.equal(reexecs.n, 0, "an orphaned child never re-execs");
  } finally {
    term.keypress({ ctrl: true, name: "d" });
    await done;
  }
});

test("runTui without a terminal still refuses before any seam or watch is armed", async () => {
  const repo = makeRepo();
  // No TTY stand-ins and no TTY behind process.stdin in a test process: the guard fires
  // first — a runTui that armed the watch before the guard could re-exec into the same
  // non-TTY error forever.
  await assert.rejects(runTui(repo), /interactive terminal/);
});
