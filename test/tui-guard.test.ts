import test from "node:test";
import assert from "node:assert/strict";
import { guardError, flashReject } from "../src/ui/tui/tui-guard.js";

// The one home of the try/catch every TUI editor or pane with a disk or marker write used to
// declare locally (and the rejection handler its async writes pass), so their guards cannot
// drift. guardError calls fn and, on a throw, flashes the reason on the session instead of
// letting it escape a keypress or sync handler and kill the TUI; flashReject returns the
// (err) => session.flashError(err) arrow the async writes pass as the `.then` rejection
// handler. The session is structural — any widget exposing `flashError(err: unknown)`.
function makeSession() {
  const flashed: unknown[] = [];
  return { flashed, session: { flashError: (err: unknown) => void flashed.push(err) } };
}

test("guardError runs fn and flashes nothing when it does not throw", () => {
  const { flashed, session } = makeSession();
  let ran = false;
  guardError(session, () => {
    ran = true;
  });
  assert.equal(ran, true);
  assert.deepEqual(flashed, []);
});

test("guardError catches a throw and flashes the reason instead of letting it escape", () => {
  const { flashed, session } = makeSession();
  const boom = new Error("disk write failed");
  assert.doesNotThrow(() =>
    guardError(session, () => {
      throw boom;
    }),
  );
  assert.deepEqual(flashed, [boom]);
});

test("guardError flashes whatever a keypress handler throws, string or non-Error", () => {
  const { flashed, session } = makeSession();
  assert.doesNotThrow(() =>
    guardError(session, () => {
      throw "a bare string reason";
    }),
  );
  assert.doesNotThrow(() =>
    guardError(session, () => {
      throw 42;
    }),
  );
  assert.deepEqual(flashed, ["a bare string reason", 42]);
});

test("guardError does not intercept a fn that completes normally with a value", () => {
  const { flashed, session } = makeSession();
  let out: number | undefined;
  guardError(session, () => {
    out = 7;
  });
  assert.equal(out, 7);
  assert.deepEqual(flashed, []);
});

test("flashReject returns a rejection handler that flashes the thrown reason", async () => {
  const { flashed, session } = makeSession();
  const onReject = flashReject(session);
  // The returned handler is what an async write passes as `.then(onOk, onReject)`: it flashes
  // the reason and must not itself throw, so a failed write cannot crash the TUI.
  const boom = new Error("marker write failed");
  // An async write's rejection reaches onReject as the rejection value; the handler flashes it
  // and returns normally, so the promise chain keeps settling.
  let settled = false;
  await Promise.reject(boom).catch(onReject).then(() => {
    settled = true;
  });
  assert.deepEqual(flashed, [boom]);
  assert.equal(settled, true);
});

test("flashReject flashes every rejection it is handed", () => {
  const { flashed, session } = makeSession();
  const onReject = flashReject(session);
  onReject(new Error("first"));
  onReject("second");
  assert.deepEqual(flashed, [new Error("first"), "second"]);
});
