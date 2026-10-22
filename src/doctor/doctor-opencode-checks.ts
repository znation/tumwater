import os from "node:os";
import path from "node:path";
import { childEnv } from "../process/process.js";
import { boundedProbe } from "./probe.js";
import { opencodeBackend, opencodeSpillDir } from "../agent/opencode/opencode-backend.js";
import { opencodeModelKey, readOpencodeCache } from "../agent/opencode/opencode-catalog.js";
import { opencodeDbPath } from "../paths.js";
import { envPath, isDirectory, readTextOrNull, statOrNull, treeBytes } from "../files/files.js";
import { formatBytes } from "../text/format.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { failOutcome, okOutcome, warnOutcome, type CheckOutcome } from "./outcome.js";
import {
  AUTH_CHECK_MAX_OUTPUT_BYTES,
  AUTH_CHECK_TIMEOUT_MS,
  loadConfigForCheck,
  opencodeSeamsInUse,
  seamPairs,
} from "./doctor-model-checks.js";

/** The doctor's opencode credential and leak readiness check, split out of doctor-model-checks.ts
 * (whose shared seam/model framework and the pi, tier-models and image-input checks stay there):
 * checkOpencode and its helpers (opencodeProviderOf, opencodeAuthLists, jsonKeyPresent,
 * opencodeConfigLeaks). This is the doctor's only check that spawns the `opencode` CLI and reads
 * its catalog and the operator's global opencode config — a distinct concern from the
 * filesystem/git checks beside it, kept together so a change to how doctor reads opencode does
 * not touch the other model checks. The shared report contract (CheckOutcome) and the
 * seam/model framework (loadConfigForCheck, opencodeSeamsInUse, seamPairs, the AUTH_CHECK_*
 * budgets) come from doctor-model-checks.ts and outcome.ts, as the other doctor-* modules do. */


/** The provider of a non-gateway opencode model id (`opencode/<provider>/<model>`), or
 * undefined for a gateway id (a bare `opencode/<model>` or `<model>`, served by OpenCode's
 * own gateway with no credential). A model id with more than the `opencode/` namespace prefix
 * is provider-qualified and needs a credential OpenCode lists. */
function opencodeProviderOf(model: string): string | undefined {
  const parts = model.split("/");
  if (parts[0] === "opencode" && parts.length >= 3) return parts[1];
  if (parts[0] !== "opencode" && parts.length >= 2) return parts[0];
  return undefined;
}

/** Whether `opencode auth list --format json` (bounded) lists `provider` exactly. A probe that
 * cannot run, exits nonzero, or omits the provider reads as NOT listed — the safe direction,
 * since doctor is warning the operator to add the credential, never confirming one it did not
 * see. The list is matched EXACTLY, not as a raw substring: when the output parses as an array
 * (of names or of per-credential objects), a credential listed as `anthropic` must never vouch
 * for `anthropic-foo` twice over; when it cannot be parsed as JSON (a shape the CLI may change),
 * the text is matched word-bounded so a truncated or prose line still reads. */
async function opencodeAuthLists(
  config: TumwaterConfig,
  provider: string,
  pathEnv: string,
  timeoutMs: number,
): Promise<boolean> {
  const resolved = opencodeBackend.resolveBin(config);
  const result = await boundedProbe(
    resolved.bin,
    ["auth", "list", "--format", "json"],
    childEnv({ PATH: pathEnv }),
    timeoutMs,
    AUTH_CHECK_MAX_OUTPUT_BYTES,
  );
  if (result?.code !== 0) return false;
  const text = result.stdout;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.some((item) => {
        if (typeof item === "string") return item === provider;
        return (
          item !== null &&
          typeof item === "object" &&
          Object.values(item as Record<string, unknown>).some((v) => v === provider)
        );
      });
    }
  } catch {
    // Not an array-shaped JSON payload — fall through to the word-bounded text match.
  }
  const esc = provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${esc}([^A-Za-z0-9_-]|$)`).test(text);
}

/** Whether a JSON-ish key (optionally quoted, followed by a colon) appears in a config file's
 * text — a loose match that tolerates JSONC comments without parsing them. */
function jsonKeyPresent(text: string, key: string): boolean {
  return new RegExp(`["']?${key}["']?\\s*:`).test(text);
}

/** The operator's global opencode config files and AGENTS.md (plans/opencode-backend.md §7
 * "Leaks", part 7/7): the operator's own config and instructions still load into team runs,
 * so each MCP server (disabled for team runs) or plugin/agent/instructions entry or the
 * AGENTS.md file itself produces one warning naming the file and what leaks in: an MCP server
 * is switched off by the harness, while a plugin/agent/instructions entry or AGENTS.md is NOT
 * switched off and still loads. `configHome` is the config root to scan — the XDG config home
 * (when set) or `~/.config`, the SAME folder opencode's own operatorMcpNames reads, so the leak
 * scan matches the config a run actually loads. Config files
 * are JSON/C, so the keys are matched loosely (a word followed by a colon) rather than fully
 * parsed — enough to name what still loads before a run inherits it. */
function opencodeConfigLeaks(configHome: string): string[] {
  const dir = path.join(configHome, "opencode");
  const warns: string[] = [];
  for (const file of ["config.json", "opencode.json", "opencode.jsonc"]) {
    const text = readTextOrNull(path.join(dir, file));
    if (text === null) continue;
    const parts: string[] = [];
    let mcp = false;
    if (jsonKeyPresent(text, "mcp") && jsonKeyPresent(text, "servers")) {
      parts.push("an MCP server");
      mcp = true;
    }
    for (const key of ["plugin", "agent", "instructions"]) {
      if (jsonKeyPresent(text, key)) parts.push(`a ${key} entry`);
    }
    if (parts.length === 0) continue;
    const joined = parts.join(" and ");
    // Only the MCP server is disabled for team runs; everything else still loads.
    const verdict = mcp && parts.length === 1 ? " — disabled for team runs" : " — still loads into team runs";
    warns.push(`${path.join(dir, file)} carries ${joined}${verdict}`);
  }
  const agentsMd = path.join(dir, "AGENTS.md");
  if (statOrNull(agentsMd)?.isFile() === true) warns.push(`${agentsMd} still loads into team runs`);
  return warns;
}

/** OpenCode model, credential and leak readiness (plans/opencode-backend.md §7, part 7/7):
 * every model routed to opencode must be in the catalog cache — an unknown model fails, a
 * cached one reads "free" or its per-M prices and context window, and a thinking level with no
 * catalog effort is noted as dropped; a non-gateway provider (`opencode/<provider>/…`) must
 * have a credential `opencode auth list` lists, else warns; and the operator's global opencode
 * config and AGENTS.md must not leak an MCP server or a plugin/agent/instructions entry into
 * team runs, else warns naming the file and key. Reports the team's opencode database and spill
 * sizes as information. Stands down (ok) when no seam routes to opencode, so a pi-only team
 * spawns nothing and reads nothing. `pathEnv` and `home` are injectable so tests need no real
 * PATH or HOME. The version half of the opencode pre-flight is the sibling checkOpencodeVersion
 * in doctor-checks.ts. */
export async function checkOpencode(
  root: string,
  pathEnv: string = envPath(),
  home: string = os.homedir(),
  xdgConfigHome: string = process.env.XDG_CONFIG_HOME ?? "",
  timeoutMs: number = AUTH_CHECK_TIMEOUT_MS,
): Promise<CheckOutcome> {
  const config = loadConfigForCheck(root);
  if ("level" in config) return config;
  if (!opencodeSeamsInUse(config)) return okOutcome("no model jobs run on opencode");
  const models = seamPairs(config).filter((p) => p.agent === "opencode" && p.model !== undefined);
  const cache = readOpencodeCache(root);
  const fails: string[] = [];
  const warns: string[] = [];
  const notes: string[] = [];
  for (const pair of models) {
    const key = opencodeModelKey(pair.model!);
    const entry = cache.models[key];
    if (entry === undefined) {
      fails.push(`${pair.model} is not in the opencode catalog cache`);
      continue;
    }
    const price = entry.free ? "free" : `$${entry.inputPerM ?? 0}/$${entry.outputPerM ?? 0} per M`;
    const window = entry.context !== undefined ? `, ${entry.context.toLocaleString("en-US")}-token window` : "";
    notes.push(`${pair.model} — ${price}${window}`);
    // A model with no effort list at all supports no thinking level, so a requested level is
    // dropped just the same as one the list omits.
    if (
      pair.thinking !== undefined &&
      pair.thinking !== "" &&
      !entry.efforts?.includes(pair.thinking)
    ) {
      warns.push(`${pair.model} has no ${pair.thinking} effort — that thinking level is dropped`);
    }
    const provider = opencodeProviderOf(pair.model!);
    if (provider !== undefined && !(await opencodeAuthLists(config, provider, pathEnv, timeoutMs))) {
      warns.push(`${pair.model} is a non-gateway provider opencode does not list a credential for`);
    }
  }
  warns.push(...opencodeConfigLeaks(xdgConfigHome !== "" ? xdgConfigHome : path.join(home, ".config")));
  const db = statOrNull(opencodeDbPath(root));
  const spillDir = opencodeSpillDir(root);
  const spill = spillDir !== "" && isDirectory(spillDir) ? treeBytes(spillDir) : null;
  const sizeNotes = `db ${formatBytes(db?.size ?? 0)}${spill !== null ? `, spill ${formatBytes(spill)}` : ", no spill dir"}`;
  const found = [...fails, ...warns];
  const base =
    found.length === 0 ? `opencode ready — ${notes.join("; ")}; ${sizeNotes}` : found.join("; ");
  if (fails.length > 0) return failOutcome(base);
  return (warns.length > 0 ? warnOutcome : okOutcome)(base);
}
