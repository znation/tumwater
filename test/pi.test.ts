import test from "node:test";
import assert from "node:assert/strict";
import { PiStreamParser, piArgs } from "../src/pi.js";
import { defaultConfig } from "../src/config.js";
import { assistantLine } from "./util.js";

test("parser keeps the last non-empty assistant text and sums usage", () => {
  const parser = new PiStreamParser();
  parser.feed(assistantLine("thinking about it", { tokens: 100, cost: 0.01 }) + "\n");
  parser.feed(assistantLine("final answer\nSUMMARY: do it", { tokens: 50, cost: 0.02 }) + "\n");
  assert.equal(parser.finalText, "final answer\nSUMMARY: do it");
  assert.equal(parser.totalTokens, 150);
  assert.ok(Math.abs(parser.costUsd - 0.03) < 1e-9);
  assert.equal(parser.stopReason, "stop");
});

test("parser handles chunked lines and ignores noise", () => {
  const parser = new PiStreamParser();
  const line = assistantLine("hello", { tokens: 5 });
  parser.feed(line.slice(0, 20));
  parser.feed(line.slice(20) + "\nnot json\n" + JSON.stringify({ type: "turn_start" }) + "\n");
  assert.equal(parser.finalText, "hello");
  assert.equal(parser.totalTokens, 5);
});

test("parser records error messages and clears them after a later success", () => {
  const parser = new PiStreamParser();
  parser.feed(
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." },
    }) + "\n",
  );
  assert.equal(parser.errorMessage, "Connection error.");
  assert.equal(parser.stopReason, "error");
  parser.feed(assistantLine("recovered") + "\n");
  assert.equal(parser.errorMessage, undefined);
  assert.equal(parser.stopReason, "stop");
});

test("parser ignores user message_end events", () => {
  const parser = new PiStreamParser();
  parser.feed(
    JSON.stringify({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "prompt" }] },
    }) + "\n",
  );
  assert.equal(parser.finalText, "");
});

test("piArgs reflects config", () => {
  const config = defaultConfig();
  config.provider = "anthropic";
  config.model = "sonnet";
  config.thinking = "high";
  config.piArgs = ["--no-skills"];
  const args = piArgs({ config, sessionDir: "/tmp/s", sessionName: "n" });
  assert.deepEqual(args.slice(0, 3), ["--print", "--mode", "json"]);
  for (const expected of ["--provider", "anthropic", "--model", "sonnet", "--thinking", "high", "--no-skills"]) {
    assert.ok(args.includes(expected), `missing ${expected}`);
  }
});

test("piArgs omits unset options", () => {
  const args = piArgs({ config: defaultConfig(), sessionDir: "/tmp/s", sessionName: "n" });
  assert.ok(!args.includes("--provider"));
  assert.ok(!args.includes("--model"));
  assert.ok(!args.includes("--thinking"));
});
