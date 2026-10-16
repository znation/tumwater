import test from "node:test";
import assert from "node:assert/strict";
import { HELP, HIDDEN_COMMAND_ALIASES, helpStanzas, helpTopic, helpTopicForArgs, suggestCommand } from "../src/cli/help.js";

/** Every command the full help lists — the set a `tumwater help <command>` topic must cover. */
const ALL_COMMANDS = [
  "init",
  "start",
  "tui",
  "gui",
  "status",
  "report",
  "doctor",
  "config",
  "logs",
  "notify",
  "history",
  "diff",
  "queue",
  "backlog",
  "bug",
  "plan",
  "questions",
  "brief",
  "role",
  "prompt",
  "reset-counters",
  "wake",
  "abort",
  "pause",
  "resume",
  "reclaim",
  "retire",
  "stop",
  "completion",
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

// The list above is the independent oracle; this keeps it in sync with HELP so a command added
// to the usage block without a list entry fails here instead of silently going unguarded.
test("ALL_COMMANDS names exactly the commands the full help lists", () => {
  const listed = [...new Set(helpStanzas().map((s) => s.command))].sort();
  assert.deepEqual([...ALL_COMMANDS].sort(), listed);
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
  assert.match(report, /report --failures \[--days N\] \[--since <duration>\] \[--role <id>\] \[--json\]/);
  assert.match(report, /report --failures --since <duration> \[--role <id>\] \[--json\]/);
  const prompt = helpTopic("prompt")!;
  assert.match(prompt, /prompt <text\.\.\.>/);
  assert.match(prompt, /prompt --list/);
  assert.match(prompt, /prompt --cancel <n>/);
  assert.match(prompt, /prompt --edit <n> --file <path>/);
  // logs accepts -f and its --follow alias (cli.ts's [-f, --follow] spec), so both usage
  // forms name both spellings.
  const logs = helpTopic("logs")!;
  assert.match(logs, /logs \[-f\/--follow\]/);
  assert.match(logs, /logs --role <id> \[-f\/--follow\]/);
  assert.match(helpTopic("notify")!, /^  tumwater notify --test/);
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
  assert.match(topic, /Zero lifetime runs\/commits\/tokens\/cost/);
  assert.match(topic, /today's budget spend is kept/);
  // The old overpromise must not come back.
  assert.doesNotMatch(topic, /Zero runs\/commits\/tokens\/cost/);
});

test("helpTopicForArgs answers a --help flag-only invocation with the command's topic", () => {
  assert.equal(helpTopicForArgs("status", ["--help"]), helpTopic("status"));
  assert.equal(helpTopicForArgs("status", ["-h"]), helpTopic("status"));
  // A valued flag's value token is plumbing, not prose: this invocation has no text.
  assert.equal(helpTopicForArgs("prompt", ["--role", "qa", "--help"]), helpTopic("prompt"));
  // bug admits no valued flags, so a flag-only --json rides beside --help.
  assert.equal(helpTopicForArgs("bug", ["--json", "--help"]), helpTopic("bug"));
  // --file's value is a path, plumbing like --role's.
  assert.equal(helpTopicForArgs("plan", ["--file", "x.md", "--help"]), helpTopic("plan"));
  assert.match(helpTopic("plan") ?? "", /plan --file <path>/);
});

test("helpTopicForArgs stands down for a free-form command carrying prose", () => {
  // The embedded --help is content: the command must read the text, not print a topic. prompt
  // has a help topic, so without the prose stand-down this would answer help instead.
  assert.equal(helpTopicForArgs("prompt", ["fix", "the", "--help", "output"]), null);
  assert.equal(helpTopicForArgs("bug", ["the", "TUI", "mishandles", "--help", "output"]), null);
  assert.equal(helpTopicForArgs("plan", ["Fix", "-v"]), null); // no help flag at all
});

test("helpTopicForArgs returns null when there is no help request or no topic", () => {
  assert.equal(helpTopicForArgs("status", []), null);
  assert.equal(helpTopicForArgs(undefined, ["--help"]), null); // bare `tumwater --help`
  assert.equal(helpTopicForArgs("--help", []), null); // the help command case handles it
  assert.equal(helpTopicForArgs("statu", ["--help"]), null); // no topic: dispatch names the typo
});

test("run is a hidden alias of start: same topic, no listing", () => {
  assert.deepEqual(HIDDEN_COMMAND_ALIASES, { run: "start", tick: "history" });
  assert.equal(helpTopic("run"), helpTopic("start"));
  assert.doesNotMatch(HELP, /tumwater run\b/);
  assert.equal(suggestCommand("run"), null);
});

test("help text uses plain terms: the merge queue tags and no retired words", () => {
  const queue = helpTopic("queue")!;
  assert.match(queue, /\[merging 2m · reviewing\]/);
  assert.match(queue, /\[approved, waiting to merge\]/);
  assert.match(queue, /merge queue empty/);
  assert.doesNotMatch(HELP, /\b(fleet|tick|landing|operator|notebook|drain)/i);
});
