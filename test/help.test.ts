import test from "node:test";
import assert from "node:assert/strict";
import { HELP, helpStanzas, helpTopic, suggestCommand } from "../src/help.js";

/** Every command the full help lists — the set a `tumwater help <command>` topic must cover. */
const ALL_COMMANDS = [
  "init",
  "run",
  "tui",
  "gui",
  "status",
  "report",
  "doctor",
  "config",
  "logs",
  "history",
  "diff",
  "backlog",
  "prompt",
  "reset-counters",
  "wake",
  "abort",
  "pause",
  "resume",
  "stop",
  "help",
  "version",
] as const;

test("every command listed in the full help resolves to a topic", () => {
  for (const command of ALL_COMMANDS) {
    const topic = helpTopic(command);
    assert.ok(topic !== null, `no help topic for ${command}`);
    assert.match(topic, new RegExp(`^  tumwater ${command}`), `${command} topic starts at its usage line`);
  }
});

test("helpStanzas keeps each stanza's description continuations and nothing else", () => {
  const stanzas = helpStanzas();
  const gui = stanzas.filter((s) => s.command === "gui");
  assert.equal(gui.length, 1);
  assert.match(gui[0]!.text, /Same dashboard in the browser/); // continuation attached
  assert.doesNotMatch(gui[0]!.text, /One-shot status table/); // neighbor stanza does not bleed in
  assert.doesNotMatch(gui[0]!.text, /persistent worktree/); // closing paragraph is not a stanza
});

test("multi-form commands yield every usage form in their topic", () => {
  const report = helpTopic("report")!;
  assert.match(report, /report \[--days N\]/);
  assert.match(report, /report --failures \[--days N\]/);
  const prompt = helpTopic("prompt")!;
  assert.match(prompt, /prompt <text\.\.\.>/);
  assert.match(prompt, /prompt --list/);
  assert.match(prompt, /prompt --cancel <n>/);
});

test("helpTopic returns null for an unknown command", () => {
  assert.equal(helpTopic("statu"), null);
  assert.equal(helpTopic("--json"), null);
});

test("suggestCommand names a listed command within two edits", () => {
  // One-edit typos and case differences suggest; everything else stays silent.
  assert.equal(suggestCommand("statis"), "status");
  assert.equal(suggestCommand("LOGS"), "logs");
  assert.equal(suggestCommand("repot"), "report");
  // Far from every command: no hint rather than a wrong one.
  assert.equal(suggestCommand("frobnicate"), null);
  assert.equal(suggestCommand(""), null);
  // The candidates come from the help text, not a second hand-kept list.
  assert.equal(suggestCommand("statis", HELP.replace(/status/g, "stetos")), "stetos");
});

test("topics end with the pointer back to the full list", () => {
  assert.match(helpTopic("tui")!, /See `tumwater help` for the full command list\./);
});

test("HELP still lists the per-command help form itself", () => {
  assert.match(HELP, /tumwater help \[<command>\]/);
});

// reset-counters deliberately keeps the daily budget window (dayStamp/dayCostUsd) so the
// daily spend cap cannot be reset past — the help must not promise it zeroes today's spend.
test("reset-counters help says what is zeroed and that today's budget spend is kept", () => {
  const topic = helpTopic("reset-counters")!;
  assert.match(topic, /Zero lifetime ticks\/commits\/tokens\/cost/);
  assert.match(topic, /today's budget spend is kept/);
  // The old overpromise must not come back.
  assert.doesNotMatch(topic, /Zero ticks\/commits\/tokens\/cost/);
});
