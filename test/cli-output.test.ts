import test from "node:test";
import assert from "node:assert/strict";
import { fail, say, sayJson, sayJsonLine, sayJsonOrRender } from "../src/cli/cli-output.js";
import { loadConfigSafe } from "../src/config/config.js";
import { attempt } from "./helpers/exit-capture.js";
import { tmpdir, writeConfig } from "./repo-fixtures.js";

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

test("fail strips terminal control characters from the CLI's error line", () => {
  // fail() is say()'s stderr twin: a bad config value reaches it through validateConfig's
  // message, so the same terminal boundary must strip controls here too.
  const out = attempt(() => fail("boom \u009b2J\u007f end"));
  assert.equal(out.exited, true);
  assert.equal(out.code, 1);
  assert.equal(out.stderr, "tumwater: boom 2J end\n");
});

test("a C1 control in tumwater.json reaches fail() as a validation message and is stripped", () => {
  const dir = tmpdir();
  writeConfig(dir, { notify: { embedded: "\u009b2J" } });
  const { error } = loadConfigSafe(dir);
  assert.ok(error, "a non-string notify is rejected");
  // JSON.stringify escapes C0 but not DEL/C1, so the raw byte survives into the message —
  // exactly the shape fail() must not write unsanitized to the operator's terminal.
  assert.ok(error.includes("\u009b"), "the raw C1 survives into the validation message");
  const out = attempt(() => fail(error));
  assert.equal(out.exited, true);
  assert.ok(!out.stderr.includes("\u009b"), "fail stripped the C1 before writing stderr");
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
