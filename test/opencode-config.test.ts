// The injected opencode config and the operator global-config reader (plans/opencode-backend.md
// "The invocation", PLANS.md "OpenCode backend, part 3/7"): the gate-safe isolation switches
// and denials, the disabled operator servers under mcp.servers, the role-notes MCP server under
// mcp.servers.tumwater (part 5b/7), the CLAUDE.md/AGENTS.md matrix, and the jsonc reading —
// all without a spawned process.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { opencodeConfigContent, operatorMcpNames, type OpencodeConfigOptions } from "../src/agent/opencode/opencode-config.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

function opts(overrides: Partial<OpencodeConfigOptions> = {}): OpencodeConfigOptions {
  return { cwd: tmpdir(), operatorMcpNames: [], ...overrides };
}

test("opencodeConfigContent parses back with snapshots off, update disabled, the six denials, and no read denial", () => {
  const parsed = JSON.parse(opencodeConfigContent(opts())) as Record<string, unknown>;
  assert.equal(parsed.snapshots, false);
  assert.equal(parsed.update, "disable");
  const permissions = parsed.permissions as { action: string; resource: string; effect: string }[];
  const actions = permissions.map((p) => p.action).sort();
  // Gate-safe denials (finding 12, and the design's question/skill/webfetch/websearch).
  assert.deepEqual(actions, ["execute", "question", "skill", "subagent", "webfetch", "websearch"].sort());
  for (const p of permissions) {
    assert.equal(p.resource, "*");
    assert.equal(p.effect, "deny");
  }
  assert.ok(!permissions.some((p) => p.action === "read"), "read is never denied (finding 11)");
  assert.ok(!("tools" in parsed) && !("permission" in parsed), "only the gate-safe denials are set");
  assert.ok(!("mcp" in parsed), "no mcp key without operator servers");
});

test("opencodeConfigContent writes tool_output only when toolOutput is given (part 6f/7)", () => {
  const withCaps = JSON.parse(opencodeConfigContent(opts({ toolOutput: { maxLines: 400, maxBytes: 16000 } }))) as {
    tool_output?: { max_lines: number; max_bytes: number };
  };
  assert.deepEqual(withCaps.tool_output, { max_lines: 400, max_bytes: 16000 });
  // Without toolOutput the config carries no tool_output key at all.
  const without = JSON.parse(opencodeConfigContent(opts())) as { tool_output?: unknown };
  assert.ok(!("tool_output" in without), "no tool_output key without toolOutput");
});

test("opencodeConfigContent disables every operator server under mcp.servers", () => {
  const parsed = JSON.parse(opencodeConfigContent(opts({ operatorMcpNames: ["one", "two"] }))) as { mcp: { servers: Record<string, unknown> } };
  assert.deepEqual(parsed.mcp.servers.one, { disabled: true });
  assert.deepEqual(parsed.mcp.servers.two, { disabled: true });
});

test("opencodeConfigContent adds tumwater's role-notes server when notesServer is given", () => {
  const parsed = JSON.parse(
    opencodeConfigContent(opts({ operatorMcpNames: ["one"], notesServer: { command: ["node", "/x/role-notes-server.js"], notesPath: "/n/notes.md" } })),
  ) as { mcp: { servers: Record<string, unknown> } };
  assert.deepEqual(
    parsed.mcp.servers.tumwater,
    {
      type: "local",
      command: ["node", "/x/role-notes-server.js"],
      codemode: false,
      environment: { TUMWATER_NOTES_PATH: "/n/notes.md" },
    },
    "the tumwater server names the notes server as a direct tool with the notes path",
  );
  // Operator servers are still disabled alongside it.
  assert.deepEqual(parsed.mcp.servers.one, { disabled: true });
});

test("an operator server named tumwater is replaced by the notes server, not disabled", () => {
  const parsed = JSON.parse(
    opencodeConfigContent(opts({ operatorMcpNames: ["tumwater", "other"], notesServer: { command: ["node", "/x/role-notes-server.js"], notesPath: "/n/notes.md" } })),
  ) as { mcp: { servers: Record<string, unknown> } };
  assert.equal((parsed.mcp.servers.other as { disabled?: boolean }).disabled, true);
  assert.equal((parsed.mcp.servers.tumwater as { disabled?: boolean } | undefined)?.disabled, undefined, "not disabled");
  assert.ok(!("disabled" in (parsed.mcp.servers.tumwater as object)), "the notes server replaces the operator entry whole");
});

test("without notesServer an operator server named tumwater is disabled like any other", () => {
  const parsed = JSON.parse(opencodeConfigContent(opts({ operatorMcpNames: ["tumwater"] }))) as { mcp: { servers: Record<string, unknown> } };
  assert.deepEqual(parsed.mcp.servers.tumwater, { disabled: true });
});

test("opencodeConfigContent without notesServer never configures a tumwater MCP server (finding 21)", () => {
  const parsed = JSON.parse(opencodeConfigContent(opts({ operatorMcpNames: ["one"] }))) as { mcp?: { servers: Record<string, unknown> } };
  assert.ok(!parsed.mcp?.servers?.tumwater, "no tumwater MCP server is configured without notes");
});

test("opencodeConfigContent emits instructions only for CLAUDE.md alone", () => {
  const claudeOnly = tmpdir();
  fs.writeFileSync(path.join(claudeOnly, "CLAUDE.md"), "# c\n");
  assert.deepEqual((JSON.parse(opencodeConfigContent(opts({ cwd: claudeOnly }))) as { instructions?: unknown }).instructions, ["CLAUDE.md"]);

  const both = tmpdir();
  fs.writeFileSync(path.join(both, "CLAUDE.md"), "# c\n");
  fs.writeFileSync(path.join(both, "AGENTS.md"), "# a\n");
  assert.ok(!("instructions" in JSON.parse(opencodeConfigContent(opts({ cwd: both })))));

  const agentsOnly = tmpdir();
  fs.writeFileSync(path.join(agentsOnly, "AGENTS.md"), "# a\n");
  assert.ok(!("instructions" in JSON.parse(opencodeConfigContent(opts({ cwd: agentsOnly })))));

  assert.ok(!("instructions" in JSON.parse(opencodeConfigContent(opts({ cwd: tmpdir() })))));
});

test("operatorMcpNames reads both config shapes from a jsonc file with comments", () => {
  const home = tmpdir();
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  // V2 shape: mcp.servers.<name>, with a trailing comma and comments.
  const v2 = [
    "{",
    "  // operator's servers",
    '  "mcp": {',
    '    "servers": {',
    '      "one": { "type": "local", "command": ["one"] }, // trailing',
    '      "two": { "type": "local", "command": ["two"] },',
    "    },",
    "  },",
    "}",
  ].join("\n");
  fs.writeFileSync(path.join(configDir, "opencode.jsonc"), v2);
  assert.deepEqual(operatorMcpNames({}, home).sort(), ["one", "two"]);

  // V1 shape: mcp.<name> directly.
  const v1 = [
    "{",
    '  "mcp": {',
    '    "alpha": { "type": "local", "command": ["a"] }',
    "  }",
    "}",
  ].join("\n");
  fs.writeFileSync(path.join(configDir, "config.json"), v1);
  assert.deepEqual(operatorMcpNames({}, home), ["alpha"]);
});

test("operatorMcpNames prefers XDG_CONFIG_HOME when set", () => {
  const xdg = tmpdir();
  const configDir = path.join(xdg, "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ mcp: { servers: { x: { type: "local" } } } }));
  assert.deepEqual(operatorMcpNames({ XDG_CONFIG_HOME: xdg }, os.homedir()), ["x"]);
});

test("operatorMcpNames keeps // and trailing-comma shapes that sit inside a string value", () => {
  const home = tmpdir();
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  const jsonc = [
    "{",
    "  // operator servers",
    '  "mcp": {',
    '    "servers": {',
    '      "srv": { "type": "local", "command": ["echo", "https://a//b"], "note": "keep,} this" },',
    "    },",
    "  },",
    "}",
  ].join("\n");
  fs.writeFileSync(path.join(configDir, "opencode.jsonc"), jsonc);
  // A string-blind strip would eat `//b"` and the rest of that line (breaking the parse, [])
  // or mangle the `,}` inside the value; a string-aware one returns the server name.
  assert.deepEqual(operatorMcpNames({}, home), ["srv"]);
});

test("operatorMcpNames drops a trailing comma followed by a comment before the closing brace", () => {
  const home = tmpdir();
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  const jsonc = [
    "{",
    '  "mcp": {',
    '    "servers": {',
    '      "one": {},',
    "      // comment after the comma, before the closing brace",
    "    },",
    "  },",
    "}",
  ].join("\n");
  fs.writeFileSync(path.join(configDir, "opencode.jsonc"), jsonc);
  // A strip that only skips whitespace after the comma would keep `,` and fail the parse,
  // silently returning [] and leaving operator MCP servers enabled. It must skip the comment.
  assert.deepEqual(operatorMcpNames({}, home), ["one"]);
});

test("operatorMcpNames returns [] for missing and malformed files", () => {
  assert.deepEqual(operatorMcpNames({}, tmpdir()), []);

  const home = tmpdir();
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), "{ this is not json");
  assert.deepEqual(operatorMcpNames({}, home), []);
});
