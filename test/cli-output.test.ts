import test from "node:test";
import assert from "node:assert/strict";
import { sayJsonOrRender } from "../src/cli/cli-output.js";
import { attempt } from "./exit-capture.js";

// cli/cli-output.ts's --json/human-text convention, driven in-process like
// test/cli-args.test.ts drives the parsers, so both output branches and the
// thunk-once guarantee are assertable without going through a child process.

test("sayJsonOrRender prints the payload as --json and hands it to the render otherwise", () => {
  const payload = { a: 1 };
  const json = attempt(() => sayJsonOrRender(["--json"], payload, (p) => `a=${p.a}`));
  assert.equal(json.exited, false);
  assert.equal(json.stdout, '{\n  "a": 1\n}\n');
  const human = attempt(() => sayJsonOrRender([], payload, (p) => `a=${p.a}`));
  assert.equal(human.exited, false);
  assert.equal(human.stdout, "a=1\n");
});

test("sayJsonOrRender runs a payload thunk exactly once, inside the branch that consumes it", () => {
  let calls = 0;
  let renders = 0;
  const thunk = () => (++calls, { a: 1 });
  const json = attempt(() => sayJsonOrRender(["--json"], thunk, () => (renders++, "human")));
  assert.equal(json.stdout, '{\n  "a": 1\n}\n');
  assert.equal(calls, 1);
  assert.equal(renders, 0); // The JSON branch never touches the renderer.
  calls = 0;
  const human = attempt(() => sayJsonOrRender([], thunk, (p) => `a=${p.a}`));
  assert.equal(human.stdout, "a=1\n");
  assert.equal(calls, 1); // Collected once for the render — never a discarded extra collection.
});