// The opencode argv builder (plans/opencode-backend.md "The invocation", PLANS.md "OpenCode
// backend, part 3/7"): the design's flag order and set, the gateway model mapping, the variant
// suffix, the session name, the prompt-on-stdin pairing, and the reserved-flag rejection — all
// without a spawned process.
import test from "node:test";
import assert from "node:assert/strict";
import { opencodeArgs, HARNESS_OPENCODE_FLAGS, type OpencodeArgOptions } from "../src/agent/opencode/opencode-args.js";

function opts(overrides: Partial<OpencodeArgOptions> = {}): OpencodeArgOptions {
  return { model: "deepseek-v4.1-flash-free", sessionId: "sid-1", title: "my-run", prompt: "do it", ...overrides };
}

function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test("opencodeArgs builds the design's argv in order and pairs the prompt with stdin", () => {
  const { args, stdin } = opencodeArgs(opts());
  assert.deepEqual(args, [
    "run",
    "--standalone",
    "--format",
    "json",
    "--auto",
    "--model",
    "opencode/deepseek-v4.1-flash-free",
    "--session",
    "sid-1",
    "--title",
    "my-run",
  ]);
  assert.equal(stdin, "do it");
  assert.ok(!args.includes("do it"), "the prompt is not an argv element");
});

test("opencodeArgs appends a catalog variant with a # suffix", () => {
  const { args } = opencodeArgs(opts({ variant: "low" }));
  assert.equal(valueOf(args, "--model"), "opencode/deepseek-v4.1-flash-free#low");
});

test("opencodeArgs maps a gateway model to the opencode/ provider and passes a qualified id as is", () => {
  // No slash: on OpenCode's gateway, so it gets the opencode/ provider prefix.
  assert.equal(valueOf(opencodeArgs(opts({ model: "deepseek-v4.1-flash-free" })).args, "--model"), "opencode/deepseek-v4.1-flash-free");
  // A slash is provider-qualified and passes as is.
  assert.equal(valueOf(opencodeArgs(opts({ model: "anthropic/claude-sonnet-5-5" })).args, "--model"), "anthropic/claude-sonnet-5-5");
});

test("opencodeArgs passes the session name through --title", () => {
  assert.equal(valueOf(opencodeArgs(opts({ title: "a b c" })).args, "--title"), "a b c");
});

test("opencodeArgs rejects a passthrough arg that repeats a flag tumwater sets, in both forms", () => {
  // --flag value form.
  assert.throws(() => opencodeArgs(opts({ args: ["--model", "x"] })), /repeats a flag tumwater sets/);
  // --flag=value form: the flag is matched before splitting off the value.
  assert.throws(() => opencodeArgs(opts({ args: ["--model=x"] })), /repeats a flag tumwater sets/);
  assert.throws(() => opencodeArgs(opts({ args: ["-m", "x"] })), /repeats a flag tumwater sets/);
  assert.throws(() => opencodeArgs(opts({ args: ["--session=s"] })), /repeats a flag tumwater sets/);
  assert.throws(() => opencodeArgs(opts({ args: ["--format=json"] })), /repeats a flag tumwater sets/);
  // `--title` is set by the harness now (finding 6), so it is reserved and refused too.
  assert.throws(() => opencodeArgs(opts({ args: ["--title=x"] })), /repeats a flag tumwater sets/);
  // The `run` subcommand is reserved too, and the harness always emits it.
  assert.throws(() => opencodeArgs(opts({ args: ["run"] })), /repeats a flag tumwater sets/);
  // A non-reserved passthrough is appended untouched.
  assert.ok(opencodeArgs(opts({ args: ["--print-logs"] })).args.includes("--print-logs"));
  assert.ok(HARNESS_OPENCODE_FLAGS.has("--title"), "--title is in the reserved set");
});
