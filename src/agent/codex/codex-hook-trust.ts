/** How tumwater learns the write guard's trust from codex itself (plans/codex-write-guard.md
 * "Trust (parts 4–5)", findings 2–3): codex runs a session-flag PreToolUse hook only when its
 * `trusted_hash` matches the hash codex computed for the hook's definition, and that hash is
 * opaque — no simple digest of any command or JSON spelling matched (finding 3). So this module
 * asks codex's own `hooks/list` RPC for the hook's `key` and `currentHash`, and caches the
 * answer per build and codex version so a run's argv never spawns `app-server` again. The
 * answer is never hardcoded: the key (`/<session-flags>/config.toml:pre_tool_use:0:0` on
 * 0.163.0) and the hash both come from this lookup.
 *
 * The lookup spawns `app-server` in its own process group under the run's env and a bounded
 * deadline, kills the group whether it succeeds, times out, or fails, and makes no model
 * request and needs no login (an empty `CODEX_HOME` is enough — finding 3). Part 5/9 wires it
 * into a run before the codex adapter's synchronous invocation. */
import { spawn, spawnSync } from "node:child_process";
import { codexHookArg } from "./codex-write-guard.js";
import { readJsonFile, writeJsonAtomic } from "../../files/json-files.js";
import { releaseChildHandles, signalTree } from "../../process/process.js";
import { codexHookTrustPath } from "../../paths.js";
import { PACKAGE_JSON, packageVersion } from "../../version.js";

/** One hook trust answer: the codex key for the session-flag PreToolUse hook whose command
 * equals the guard's, and the `sha256:…` hash codex reports for that definition. */
interface CodexHookTrust {
  /** Codex's `hooks/list` key for the hook, e.g. `/<session-flags>/config.toml:pre_tool_use:0:0`
   * on 0.163.0 — read from codex, never hardcoded here. */
  key: string;
  /** The `sha256:…` hash codex computed for the hook's definition — read, never computed. */
  hash: string;
}

/** Everything the lookup needs to ask codex for the hook's trust: which binary to run, under
 * which environment and cwd, and the exact guard definition whose trust is being looked up
 * (its `command` is what identifies the hook in `hooks/list`; its `timeout` changes the hash,
 * so it is part of the cache key below). */
interface CodexHookLookupOptions {
  bin: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  definition: { matcher: string; command: string; timeout: number };
  /** Wall-clock bound for the whole lookup; the group is killed at it. Defaults to 15 s. */
  timeoutMs?: number;
}

/** The JSON-RPC request/notification sequence one lookup sends over `app-server`'s stdio: the
 * `initialize` handshake (carrying tumwater's own version), the `initialized` notification,
 * then `hooks/list` for the one cwd. The reply to `id: 2` carries the hooks. */
function hookListMessages(cwd: string): unknown[] {
  const version = packageVersion(PACKAGE_JSON).version;
  return [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "tumwater", version: version ?? "unknown" } },
    },
    { jsonrpc: "2.0", method: "initialized" },
    { jsonrpc: "2.0", id: 2, method: "hooks/list", params: { cwds: [cwd] } },
  ];
}

/** The first hook in `hooks/list`'s `result.data[*].hooks` with `source: "sessionFlags"`,
 * `eventName: "preToolUse"` and `command` exactly the guard definition's (finding 3), or null
 * when none matches. The key and hash are returned as codex reports them. */
function findTrust(
  result: unknown,
  definition: CodexHookLookupOptions["definition"],
): CodexHookTrust | null {
  if (typeof result !== "object" || result === null) return null;
  const data = (result as Record<string, unknown>).data;
  if (!Array.isArray(data)) return null;
  for (const group of data) {
    if (typeof group !== "object" || group === null) continue;
    const hooks = (group as Record<string, unknown>).hooks;
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      if (typeof hook !== "object" || hook === null) continue;
      const h = hook as Record<string, unknown>;
      if (h.source !== "sessionFlags" || h.eventName !== "preToolUse") continue;
      if (h.command !== definition.command) continue;
      if (typeof h.key === "string" && typeof h.currentHash === "string") {
        return { key: h.key, hash: h.currentHash };
      }
    }
  }
  return null;
}

/** A short name for a JSON-RPC `error` value, for the rejection message. */
function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return JSON.stringify(error);
}

/** Ask codex for the guard hook's trust. Spawns `<bin> -c <codexHookArg(definition)>
 * app-server` in `cwd` under `env`, in its own process group, sends the JSON-RPC sequence
 * above over stdio, and resolves with the trust from the first matching `hooks/list` hook.
 *
 * It rejects on a timeout (`timeoutMs`), on the child exiting before the reply, on a JSON-RPC
 * `error`, and on codex listing no session-flag PreToolUse hook with this command. The child's
 * process group is SIGKILLed whether the lookup settles by success, failure, or timeout, so no
 * `app-server` outlives the call. */
export function lookupCodexHookTrust(opts: CodexHookLookupOptions): Promise<CodexHookTrust> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return new Promise<CodexHookTrust>((resolve, reject) => {
    const child = spawn(opts.bin, ["-c", codexHookArg(opts.definition), "app-server"], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let buffer = "";
    const finish = (err: Error | null, trust?: CodexHookTrust) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signalTree(child, "SIGKILL");
      releaseChildHandles(child);
      if (err !== null) reject(err);
      else resolve(trust!);
    };
    const timer = setTimeout(() => {
      finish(new Error(`codex hook trust lookup timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
    const onLine = (line: string) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // A non-JSON-RPC line (a notice, a prompt) is not our reply.
      }
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as Record<string, unknown>;
      if (m.error !== undefined) {
        finish(new Error(`codex hooks/list errored: ${describeError(m.error)}`));
        return;
      }
      if (m.id !== 2) return;
      const trust = findTrust(m.result, opts.definition);
      if (trust !== null) finish(null, trust);
      else finish(new Error("codex listed no session-flag PreToolUse hook with this command"));
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() !== "") onLine(line);
        nl = buffer.indexOf("\n");
      }
    });
    child.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
    child.on("close", (code) => {
      if (!settled) {
        finish(
          new Error(`codex app-server exited (code ${code ?? "signal"}) before answering hooks/list`),
        );
      }
    });
    for (const message of hookListMessages(opts.cwd)) {
      try {
        child.stdin?.write(JSON.stringify(message) + "\n");
      } catch {
        // The pipe is gone (a failed spawn); the error handler settles the lookup.
      }
    }
  });
}

/** The trimmed output of `<bin> --version`, or "" when the probe fails or prints nothing. It
 * keys the trust cache, so a codex upgrade re-looks-up the guard's trust for the new build. */
function codexVersion(bin: string, env: NodeJS.ProcessEnv, cwd: string): string {
  try {
    const result = spawnSync(bin, ["--version"], {
      env,
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    if (result.status !== 0) return "";
    return (typeof result.stdout === "string" ? result.stdout : "").trim();
  } catch {
    return "";
  }
}

/** Whether a cached value is a usable `{key, hash}` entry. */
function isTrust(value: unknown): value is { key: string; hash: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { key?: unknown }).key === "string" &&
    typeof (value as { hash?: unknown }).hash === "string"
  );
}

/** Resolve the guard hook's trust, cached per codex version and hook definition in
 * `.tumwater/state/codex-hook-trust.json` so a run's argv never spawns `app-server` again.
 * Returns the trust, rejecting on a failed lookup.
 *
 * The cache key is the trimmed `<bin> --version` output plus `JSON.stringify(definition)`, so
 * a changed codex version, a changed hook command, or a changed `timeout` (which changes the
 * hash, finding 3) each re-look-up; each entry is `{key, hash, checkedAt}`. A hit resolves
 * without spawning `app-server`; a miss looks up and writes the entry atomically.
 *
 * `root` undefined (a hand run with no `.tumwater` root) looks up and caches nothing and never
 * creates a `.tumwater` directory — a hand run once minted a phantom `$TMPDIR/.tumwater` and
 * reddened every suite on the host (plans/codex-write-guard.md "Visibility"). */
export async function codexHookTrust(
  root: string | undefined,
  opts: CodexHookLookupOptions,
): Promise<CodexHookTrust> {
  if (root === undefined) return lookupCodexHookTrust(opts);
  const file = codexHookTrustPath(root);
  const version = codexVersion(opts.bin, opts.env, opts.cwd);
  const cacheKey = `${version}${JSON.stringify(opts.definition)}`;
  const cache = readJsonFile<Record<string, unknown>>(file);
  const hit = cache?.[cacheKey];
  if (isTrust(hit)) return { key: hit.key, hash: hit.hash };
  const trust = await lookupCodexHookTrust(opts);
  const next = { ...(cache ?? {}) };
  next[cacheKey] = { key: trust.key, hash: trust.hash, checkedAt: Date.now() };
  try {
    writeJsonAtomic(file, next);
  } catch {
    // A cache write failure must never fail the lookup whose result it is only persisting.
  }
  return trust;
}
