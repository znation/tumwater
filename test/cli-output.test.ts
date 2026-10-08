import test from "node:test";
import assert from "node:assert/strict";
import { say, sayJson, sayJsonLine, sayJsonOrRender } from "../src/cli/cli-output.js";
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

test("say strips terminal control characters from the CLI's operator-facing line", () => {
  // A hostile tick summary/error can reach say() through formatEvent; the boundary removes it.
  const out = attempt(() => say("tick #1 changed \u001b]52;c;AAAA\u0007 done"));
  assert.equal(out.stdout, "tick #1 changed ]52;c;AAAA done\n");
});

test("sayJson and sayJsonLine write raw JSON, bypassing say's sanitization", () => {
  // JSON is a data surface: JSON.stringify escapes C0 but not DEL/C1, and the --json bytes
  // must not change, so these helpers deliberately do not route through say().
  const pretty = attempt(() => sayJson({ s: "a\u007fb\u0085c" }));
  assert.ok(pretty.stdout.includes("\u007f"));
  assert.ok(pretty.stdout.includes("\u0085"));
  const line = attempt(() => sayJsonLine("a\u007fb"));
  assert.equal(line.stdout, '"a\u007fb"\n');
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
