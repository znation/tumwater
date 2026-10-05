import test from "node:test";
import assert from "node:assert/strict";

// The root vitest.config.mjs is a tripwire, not a config: vitest reads it before collecting a
// single file, so throwing there stops `npx vitest run` before it can import the compiled tests
// and tear its worker down mid-test (BUGS.md 2026-10-05: ~725 abandoned run roots and orphaned
// test children from one conflict resolver's five runs). The file is plain Node with no imports,
// so importing it here runs exactly what vitest's config loader runs.

const GUARD = new URL("../../vitest.config.mjs", import.meta.url);

test("the root vitest config refuses to load and points at npm test, whole-suite and filtered", async () => {
  await assert.rejects(import(GUARD.href), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /^vitest is not this repo's test runner: tumwater's tests are node:test, run by `npm test`\./);
    assert.match(err.message, /npm test <file-name-substring>/);
    assert.match(err.message, /npm test '<file-substring>#<test-name-substring>'/);
    assert.match(err.message, /kill them mid-run, leaking temp dirs and child processes/);
    // vitest prints a load error's stack after its message, and agents read a run through
    // `| tail`: with frames, the last lines are vite's internals and the pointer scrolls away.
    assert.equal(err.stack, `Error: ${err.message}`, "a stackless error: the message is the whole printout");
    return true;
  });
});
