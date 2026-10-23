/** Building one OpenCode run's injected config (`OPENCODE_CONFIG_CONTENT`) (plans/opencode-
 * backend.md "The invocation") — pure JSON construction, with no subprocess. The config
 * applies after the operator's global and project files, so only managed config wins over it:
 * the gate-safe isolation switches (snapshots off, updates off, six denials), `enabled →
 * disabled: true` for every operator MCP server (config merges, so disabling is the only way
 * to remove one), an `instructions` entry mirroring claude's AGENTS.md handling, and tumwater's
 * write-guard plugin (write-guard-plugin/index.ts), which refuses a write outside the run's
 * worktree. No tool is disabled beyond the six gate-safe denials — denying `read` trips the
 * free-tier gate (finding 11). Part 5/7 wires this string into the run's environment.
 *
 * From part 3/4 tumwater no longer adds an MCP server of its own: run notes ride the
 * `tumwater-notes` command on PATH, so every operator MCP server is disabled alike — an
 * operator server named `tumwater` is disabled like any other (a later config replaces a
 * server object whole, design decision 8 and plans/opencode-backend.md "The invocation"). No
 * XDG/config files are read here except the operator's global opencode config, and that only
 * to enumerate its MCP server names (operatorMcpNames): a broken or missing file yields `[]`
 * here, and doctor reports it in part 7/7. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readTextOrNull } from "../../files/files.js";
import { isJsonObject } from "../../files/json-object.js";

/** The operator's global opencode config lives in `$XDG_CONFIG_HOME/opencode/` (or
 * `~/.config/opencode/`), in `config.json`, `opencode.json` or `opencode.jsonc`. */
const OPERATOR_CONFIG_FILES = ["config.json", "opencode.json", "opencode.jsonc"] as const;

/** The six gate-safe denials (plans/opencode-backend.md "The invocation", findings 11–12).
 * `read` is never denied — it trips the free-tier gate. `shell`, `glob`, `grep`, `edit` and
 * `write` stay allowed for parity with pi. */
const DENIED_PERMISSIONS = [
  { action: "execute", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "websearch", resource: "*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
  { action: "skill", resource: "*", effect: "deny" },
] as const;

/** True at `i` when a `//` line comment or a `/*`-style block comment starts there. */
function isCommentStart(src: string, i: number): boolean {
  return src[i] === "/" && (src[i + 1] === "/" || src[i + 1] === "*");
}

/** Advance `j` past any whitespace and comments, for a position that is never inside a string.
 * Returns the index of the next significant (non-comment, non-whitespace) character, or
 * `src.length` when the input ends in comments/whitespace. */
function skipWhitespaceAndComments(src: string, j: number): number {
  while (j < src.length) {
    const c = src[j];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      j += 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      while (j < src.length && src[j] !== "\n") j += 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      j += 2;
      while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j += 1;
      j += 2;
      continue;
    }
    break;
  }
  return j;
}

/** Strip comments and trailing commas from a JSONC string so a strict JSON parse succeeds.
 * Walks the string so a `//` or a block-comment opener, and `,}` / `,]`, inside a normal
 * double-quoted string value survive (escape sequences included); comments and trailing
 * commas are removed only outside strings, where they are legal JSONC but not JSON. A
 * trailing comma is dropped when the next significant character — past any whitespace AND
 * any comment — is a closing brace or bracket, so a comma then a comment then `}` strips
 * correctly. */
function stripJsonc(src: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (c === "\\" && next !== undefined) {
        out += next;
        i += 2;
      } else {
        if (c === '"') inString = false;
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (isCommentStart(src, i)) {
      i = skipWhitespaceAndComments(src, i);
      continue;
    }
    if (c === ",") {
      // A trailing comma may be followed by whitespace and comments before the closing
      // brace/bracket (`,\n  // c\n }`); look past all of it to decide, without touching a
      // comma inside a string value.
      const j = skipWhitespaceAndComments(src, i + 1);
      if (src[j] === "}" || src[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Read the MCP server names in the operator's global opencode config. Each name is a server
 * the managed config must explicitly disable (config merges, so it cannot be removed). Reads
 * both config shapes: the keys of V2's `mcp.servers` plus V1-shaped `mcp.<name>` keys other
 * than `servers`. Returns `[]` for a missing file, an unreadable file, or one that does not
 * parse; doctor reports a broken one in part 7/7. `homeDir` is the operator's home directory;
 * the process's own `XDG_CONFIG_HOME` env, when set, wins over `~/.config` (the XDG default). */
export function operatorMcpNames(env: NodeJS.ProcessEnv, homeDir: string): string[] {
  const configHome = env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config");
  const dir = path.join(configHome, "opencode");
  for (const file of OPERATOR_CONFIG_FILES) {
    const text = readTextOrNull(path.join(dir, file));
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.endsWith(".jsonc") ? stripJsonc(text) : text);
    } catch {
      return [];
    }
    const mcp = (parsed as { mcp?: unknown } | null)?.mcp;
    if (!isJsonObject(mcp)) return [];
    const names = new Set<string>();
    const servers = mcp.servers;
    if (isJsonObject(servers)) {
      for (const key of Object.keys(servers)) names.add(key);
    }
    // V1-shaped `mcp.<name>` keys, other than the V2 `servers` grouping.
    for (const key of Object.keys(mcp)) {
      if (key !== "servers") names.add(key);
    }
    return [...names];
  }
  return [];
}

/** True when the worktree has a `CLAUDE.md` and no `AGENTS.md`: OpenCode reads `AGENTS.md`
 * only, so the managed config injects `CLAUDE.md` — but only when the repo has no `AGENTS.md`,
 * exactly the mirror of claude's `shouldAppendAgents`. */
function shouldInjectClaudeMd(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, "CLAUDE.md")) && !fs.existsSync(path.join(cwd, "AGENTS.md"));
}

/** One `mcp.servers` entry: a disabled operator server. From part 3/4 tumwater adds no MCP
 * server of its own (notes ride the `tumwater-notes` command), so every entry is a disable. */
interface McpServer {
  disabled: boolean;
}

/** The injected-config builder's inputs. `cwd` is read only to decide the `instructions`
 * entry. `operatorMcpNames` is the list of operator MCP servers to disable. */
export interface OpencodeConfigOptions {
  /** The worktree the run starts in; read only to decide the `instructions` entry. */
  cwd: string;
  /** Operator MCP server names, each disabled with `{ disabled: true }` under
   * `mcp.servers`. */
  operatorMcpNames: string[];
  /** The `tool_output` caps (plans/opencode-backend.md "Small-window parity with pi" item 2,
   * part 6f/7): pi's window-scaled read/bash budgets for the run's model, so OpenCode's tool
   * results stop entering the context at OpenCode's `tool_output` default (2,000 lines /
   * 51,200 bytes, finding 13) and come in at the same budget as a pi run's. When given,
   * `"tool_output": { "max_lines": …, "max_bytes": … }` is written into the injected config;
   * without it the output is byte-identical to part 5/7's. `maxBytes` is
   * `outputLimits(window).bash` (16,000 at 128k and above, scaled down below) and `maxLines`
   * is `maxBytes / 40`, the ~40 characters a line that pi's "12k chars ≈ 300 lines" read cap
   * implies (400 at 16,000 bytes). */
  toolOutput?: { maxLines: number; maxBytes: number };
}

/** The write-guard plugin's `plugins` entry: a `file://` URL of the directory holding its
 * compiled `index.js`, since OpenCode 2.x loads a configured plugin path only as a directory.
 * Resolved from this module, so a staged build (.tumwater/build/<sha>) loads its own copy. */
export function writeGuardPluginEntry(): string {
  const entry = fileURLToPath(new URL("./write-guard-plugin/index.js", import.meta.url));
  return pathToFileURL(path.dirname(entry)).href;
}

/** Build the injected opencode config JSON string. Never reads the worktree beyond the
 * CLAUDE.md/AGENTS.md probe. */
export function opencodeConfigContent(opts: OpencodeConfigOptions): string {
  const config: {
    snapshots: boolean;
    update: string;
    permissions: readonly { action: string; resource: string; effect: string }[];
    plugins: string[];
    mcp?: { servers: Record<string, McpServer> };
    instructions?: string[];
    tool_output?: { max_lines: number; max_bytes: number };
  } = {
    snapshots: false,
    update: "disable",
    permissions: DENIED_PERMISSIONS,
    plugins: [writeGuardPluginEntry()],
  };
  if (opts.toolOutput !== undefined) {
    config.tool_output = { max_lines: opts.toolOutput.maxLines, max_bytes: opts.toolOutput.maxBytes };
  }
  const servers: Record<string, McpServer> = {};
  for (const name of opts.operatorMcpNames) {
    // Every operator server is disabled alike: an operator server named `tumwater` gets no
    // special treatment now that tumwater ships no MCP server of its own (part 3/4).
    servers[name] = { disabled: true };
  }
  if (Object.keys(servers).length > 0) config.mcp = { servers };
  if (shouldInjectClaudeMd(opts.cwd)) config.instructions = ["CLAUDE.md"];
  return JSON.stringify(config);
}
