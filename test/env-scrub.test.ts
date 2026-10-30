// The shared scrub-and-set skeleton behind the three backend env builders (claude-env.ts,
// codex-env.ts, opencode-env.ts). Each per-backend test pins one backend's predicate through
// its own builder; this pins the skeleton's own contract in isolation — the copy half keeps
// only the `keep`-accepted keys on a FRESH env and never mutates the caller's base, and the
// `then` additions land on that fresh env — so a change to the shared rule (say, a kept key
// leaking onto base, or `then` writing before `keep` had finished copying) is caught here
// rather than once per backend.
import test from "node:test";
import assert from "node:assert/strict";
import { scrubEnv } from "../src/agent/env-scrub.js";

test("scrubEnv copies only the keep-accepted base keys onto a fresh env", () => {
  const base: NodeJS.ProcessEnv = { KEEP_ONE: "1", KEEP_TWO: "2", DROP: "3" };
  const out = scrubEnv(base, {
    keep: (key) => key.startsWith("KEEP"),
    then: () => {},
  });
  assert.deepEqual(Object.keys(out).sort(), ["KEEP_ONE", "KEEP_TWO"]);
  assert.equal(out.KEEP_ONE, "1");
  assert.equal(out.KEEP_TWO, "2");
  assert.equal(out.DROP, undefined);
});

test("scrubEnv returns a fresh object, never the caller's base", () => {
  const base: NodeJS.ProcessEnv = { A: "1" };
  const out = scrubEnv(base, { keep: () => true, then: () => {} });
  assert.notEqual(out, base, "the result is a new object, so mutating it cannot touch base");
});

test("scrubEnv does not mutate the caller's base", () => {
  // The invariant the per-backend tests each pin for their own builder, held here for the
  // shared skeleton: neither the keep-copy nor the `then` additions may write to base.
  const base: NodeJS.ProcessEnv = { A: "1", B: "2" };
  scrubEnv(base, {
    keep: () => true,
    then: (env) => {
      env.C = "3";
    },
  });
  assert.deepEqual(base, { A: "1", B: "2" });
  assert.equal((base as NodeJS.ProcessEnv).C, undefined);
});

test("then receives the fresh base-derived env, not base, and its additions land on it", () => {
  const base: NodeJS.ProcessEnv = { A: "1" };
  const out = scrubEnv(base, {
    keep: (key) => key === "A",
    then: (env) => {
      env.B = "2";
    },
  });
  assert.equal(out.A, "1", "kept base entries are present on the fresh env");
  assert.equal(out.B, "2", "the backend's own additions sit on the fresh env beside the kept ones");
  assert.equal((base as NodeJS.ProcessEnv).B, undefined, "then's additions never reach base");
});

test("then runs even when nothing is kept", () => {
  const base: NodeJS.ProcessEnv = { A: "1" };
  const out = scrubEnv(base, {
    keep: () => false,
    then: (env) => {
      env.ONLY = "set";
    },
  });
  assert.deepEqual(out, { ONLY: "set" });
});
