// The opencode backend end to end (plans/opencode-backend.md "The invocation", "Sessions",
// §6): `runAgent` drives the registered opencode adapter against a PATH fake, runs the
// reconciling session export after each run, resumes by id through the same export check, and
// records the minted/resumed session id in the ledger. These tests set
// `config.agent = "opencode"` directly.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withCwd } from "./helpers/env.js";
import { runAgent } from "../src/agent/run-agent.js";
import { opencodeBackend } from "../src/agent/opencode/opencode-backend.js";
import { writeOpencodeCache } from "../src/agent/opencode/opencode-catalog.js";
import { readSessions, recordSession } from "../src/agent/session-ledger.js";
import { defaultConfig } from "../src/config/config.js";
import type { PiRunOptions } from "../src/agent/run-agent.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { withOpencodeReplay, fakeOpencodeReplay, readRunBlocks, type FakeOpencodeReplay } from "./fakes/fake-opencode.js";
import { opencodeCaptures } from "./fixtures/opencode-events.js";

/** A run against `dir` with opencode selected and a concrete model resolved — the shape every
 * opencode test starts from. The session dir lives under `dir/.tumwater` so the adapter's
 * shared-database root lookup finds this test's team root (the caller creates `.tumwater`). */
function opencodeRun(dir: string, over: Partial<PiRunOptions> = {}): PiRunOptions {
  return {
    cwd: fs.realpathSync(dir),
    prompt: "p",
    config: { ...defaultConfig(), agent: "opencode", model: "deepseek-v4.1-flash-free" },
    sessionDir: path.join(dir, ".tumwater", "sessions", "t"),
    sessionName: "t",
    rawLogFile: path.join(dir, ".tumwater", "log", "t.opencode.jsonl"),
    nativeLogFile: path.join(dir, ".tumwater", "log", "t.opencode.native.jsonl"),
    kind: "author",
    ...over,
  };
}

/** One block's argv split into its lines, and the value of `flag` (the next line), or
 * undefined when the flag is absent. */
function argValue(block: string, flag: string): string | undefined {
  const args = block.split("\n");
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

/** The canned export's token/ cost authoritative numbers (edit-run-export.json). */
const EXPORT_INPUT = 3223;
const EXPORT_OUTPUT = 433;
const EXPORT_CACHE_READ = 7680;

test("runAgent runs the opencode backend on a fake, exports after the run, and folds the stream", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  await withOpencodeReplay(opencodeCaptures.editRun, async (fake) => {
    const run = opencodeRun(dir);
    const result = await runAgent(run);
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.equal(result.finalText, "DONE");
    // The export is authoritative: the run's tokens equal the canned export's info.tokens and
    // its cost is 0, not the lossy streamed sums.
    assert.equal(result.outputTokens, EXPORT_OUTPUT);
    assert.equal(result.promptTokens, EXPORT_INPUT + EXPORT_CACHE_READ);
    assert.equal(result.costUsd, 0);

    // A minted --session and --title (the session name), and the prompt on stdin.
    const argv = readRunBlocks(fake.argvFile);
    assert.equal(argv.length, 1);
    const mintedId = argValue(argv[0]!, "--session")!;
    assert.match(mintedId, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, "a fresh run mints an opencode session id");
    assert.equal(argValue(argv[0]!, "--title"), "t", "--title is the session name");
    assert.equal(argValue(argv[0]!, "--model"), "opencode/deepseek-v4.1-flash-free");
    assert.ok(readRunBlocks(fake.stdinFile)[0]!.includes("p"), "stdin carries the prompt");

    // An opencode ledger record was appended before the spawn, with the argv's session id.
    const sessions = readSessions(run.sessionDir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.agent, "opencode");
    assert.equal(sessions[0]!.kind, "author");
    assert.equal(argValue(readRunBlocks(fake.argvFile)[0]!, "--session"), sessions[0]!.id);

    // The canonical stream reaches the raw log; native lines reach the native log.
    const raw = fs.readFileSync(run.rawLogFile, "utf8");
    assert.match(raw, /"type":"session"/);
    assert.match(raw, /"type":"run_cost","total":0/);
    assert.match(raw, /"type":"run_usage"/);
    const native = fs.readFileSync(run.nativeLogFile, "utf8");
    assert.match(native, /"type":"step_finish"/, "the native log holds opencode's own lines");
  });
});

test("the catalog supplies the thinking variant and the image-input answer (part 6d/7)", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  // A fixture cache: the free model gets effort levels [low, high] and image input; a model
  // with no entry is simply absent.
  writeOpencodeCache(dir, {
    fetchedAt: Date.now(),
    models: {
      "opencode/deepseek-v4.1-flash-free": { free: true, efforts: ["low", "high"], images: true },
    },
  });
  await withOpencodeReplay(opencodeCaptures.editRun, async (fake) => {
    // high is among the fixture's efforts, so the invocation rides it as #high.
    let run = opencodeRun(dir, {
      config: { ...defaultConfig(), agent: "opencode", model: "deepseek-v4.1-flash-free", thinking: "high" },
    });
    let result = await runAgent(run);
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.equal(argValue(readRunBlocks(fake.argvFile)[0]!, "--model"), "opencode/deepseek-v4.1-flash-free#high");

    // medium is not among the fixture's efforts, so no variant is passed.
    run = opencodeRun(dir, {
      config: { ...defaultConfig(), agent: "opencode", model: "deepseek-v4.1-flash-free", thinking: "medium" },
    });
    result = await runAgent(run);
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.equal(argValue(readRunBlocks(fake.argvFile)[1]!, "--model"), "opencode/deepseek-v4.1-flash-free");

    // The same cache answers imageInput, read from the process's cwd at that root.
    withCwd(fs.realpathSync(dir), () => {
      assert.equal(opencodeBackend.imageInput!("deepseek-v4.1-flash-free"), true, "a cataloged image model reads images");
      assert.equal(opencodeBackend.imageInput!("deepseek-v4.1-flash-unknown"), false, "a model missing from the cache is blind");
    });
  });
});

test("a continue resumes the recorded opencode id when the export knows it; resumable is true", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  await withOpencodeReplay(opencodeCaptures.editRun, async (fake) => {
    const run = opencodeRun(dir);
    const first = await runAgent(run);
    assert.equal(first.ok, true);
    const sessions = readSessions(run.sessionDir);
    const freshId = sessions[0]!.id;
    assert.ok(
      opencodeBackend.resumable!(run.sessionDir, { kind: "author", agent: "opencode", cwd: run.cwd }),
      "the fresh run's session is resumable",
    );
    const second = await runAgent({ ...run, continueSession: true });
    assert.equal(second.ok, true);
    const argv = readRunBlocks(fake.argvFile);
    assert.equal(argValue(argv[1]!, "--session"), freshId, "the continue reuses the recorded id");
    assert.equal(readSessions(run.sessionDir).length, 2);
  });
});

test("a continue with an id or cwd the export does not know mints a fresh session", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  const run = opencodeRun(dir);
  const otherCwd = fs.realpathSync(tmpdir());

  // A ledger record whose session the fake's export does not know.
  recordSession(run.sessionDir, { agent: "opencode", id: "ses_unknown0000000000000AB", kind: "author", name: "t", cwd: run.cwd, at: Date.now() });
  await withOpencodeReplay(opencodeCaptures.editRun, async (fake) => {
    assert.equal(
      opencodeBackend.resumable!(run.sessionDir, { kind: "author", agent: "opencode", cwd: run.cwd }),
      false,
      "an id the export does not know is not resumable",
    );
    const result = await runAgent({ ...run, continueSession: true });
    assert.equal(result.ok, true);
    const argv = readRunBlocks(fake.argvFile);
    const mintedId = argValue(argv[0]!, "--session")!;
    assert.match(mintedId, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, "a fresh id is minted");
    assert.notEqual(mintedId, "ses_unknown0000000000000AB");
  });

  // A record from another cwd is not resumable either, whatever the export knows.
  const dirB = tmpdir();
  fs.mkdirSync(path.join(dirB, ".tumwater"), { recursive: true });
  const runB = opencodeRun(dirB);
  await withOpencodeReplay(opencodeCaptures.editRun, async (fake) => {
    // Record the "other cwd" session in dirB's ledger, then run from dirB's own cwd.
    const runCwdB = fs.realpathSync(dirB);
    recordSession(runB.sessionDir, { agent: "opencode", id: "ses_othercwd_0000ABCDEFGH1234", kind: "author", name: "t", cwd: otherCwd, at: Date.now() });
    // The fake knows this id, yet the cwd differs, so no resume.
    fs.appendFileSync(fake.ledgerFile, "ses_othercwd_0000ABCDEFGH1234\n");
    assert.equal(
      opencodeBackend.resumable!(runB.sessionDir, { kind: "author", agent: "opencode", cwd: runCwdB }),
      false,
      "another cwd's record is not resumable",
    );
    const result = await runAgent({ ...runB, continueSession: true });
    assert.equal(result.ok, true);
    const argv = readRunBlocks(fake.argvFile);
    assert.match(argValue(argv[0]!, "--session")!, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, "a fresh id is minted");
  });
});

test("a failing export keeps the streamed tokens and warns opencode_usage_partial", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  await withOpencodeReplay(opencodeCaptures.editRun, { failExport: true }, async (fake) => {
    const warnings: string[] = [];
    const run = opencodeRun(dir);
    const result = await runAgent({ ...run, onAgentWarning: (w) => warnings.push(w) });
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.ok(warnings.includes("opencode_usage_partial"), "the partial-usage warning fires once");
    const exports = fs.readFileSync(fake.exportsFile, "utf8").trim();
    assert.match(exports, /^export /, "the export was attempted (and failed)");
    // The streamed (non-reconciled) numbers stand: output is not the export's 433.
    assert.notEqual(result.outputTokens, EXPORT_OUTPUT);
  });
});

test("a hang the quiet watchdog kills never runs the export and leaves the result unclassified", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  const fake: FakeOpencodeReplay = fakeOpencodeReplay(opencodeCaptures.editRun, { hang: true });
  try {
    const run = opencodeRun(dir, {
      config: { ...defaultConfig(), agent: "opencode", model: "deepseek-v4.1-flash-free", runTimeoutSeconds: 5, quietTimeoutSeconds: 1 },
    });
    const result = await runAgent(run);
    assert.equal(result.ok, false, "the killed run is a failure");
    assert.match(result.errorMessage ?? "", /killed as hung/);
    const exports = fs.existsSync(fake.exportsFile) ? fs.readFileSync(fake.exportsFile, "utf8") : "";
    assert.equal(exports, "", "a killed run never invokes the export");
    assert.equal(result.transientBackend, false, "no classifier overrides a killed run");
    assert.equal(result.configError, false);
  } finally {
    fake.restore();
  }
});

/** The `mcp.servers.tumwater` entry from the last run's recorded OPENCODE_CONFIG_CONTENT, or
 * undefined when the config names no such server. */
interface NotesServer {
  type: string;
  command: string[];
  codemode: boolean;
  environment: { TUMWATER_NOTES_PATH: string };
}
/** The `tool_output` caps from the last run's recorded OPENCODE_CONFIG_CONTENT, or undefined
 * when the config names none (part 6f/7). */
function toolOutputCaps(fake: FakeOpencodeReplay): { max_lines: number; max_bytes: number } | undefined {
  const env = fs.readFileSync(fake.envFile, "utf8");
  const line = env.split("\n").find((l) => l.startsWith("OPENCODE_CONFIG_CONTENT="));
  if (line === undefined) return undefined;
  const parsed = JSON.parse(line.slice("OPENCODE_CONFIG_CONTENT=".length)) as { tool_output?: { max_lines: number; max_bytes: number } };
  return parsed.tool_output;
}

function tumwaterServer(fake: FakeOpencodeReplay): NotesServer | undefined {
  const env = fs.readFileSync(fake.envFile, "utf8");
  const line = env.split("\n").find((l) => l.startsWith("OPENCODE_CONFIG_CONTENT="));
  if (line === undefined) return undefined;
  const parsed = JSON.parse(line.slice("OPENCODE_CONFIG_CONTENT=".length)) as { mcp?: { servers: Record<string, NotesServer> } };
  return parsed.mcp?.servers?.tumwater;
}

test("an authoring run with a notebook carries the notes path but no tumwater MCP server", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  const notes = path.join(dir, ".tumwater", "notes", "feature.md");
  await withOpencodeReplay(opencodeCaptures.editRun, async (fake) => {
    const run = opencodeRun(dir, { notesPath: notes });
    let result = await runAgent(run);
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.equal(tumwaterServer(fake), undefined, "a notes-carrying run configures no tumwater MCP server");
    assert.match(fs.readFileSync(fake.envFile, "utf8"), new RegExp(`TUMWATER_NOTES_PATH=${notes}`), "the notes path reaches the run");

    // A continue of that run keeps the notes path too (OpenCode's config is per process).
    result = await runAgent({ ...run, continueSession: true });
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.equal(tumwaterServer(fake), undefined, "the continue configures no tumwater server either");
    assert.match(fs.readFileSync(fake.envFile, "utf8"), new RegExp(`TUMWATER_NOTES_PATH=${notes}`), "the continue keeps the notes path");
  });

  // A run without a notebook names no tumwater server at all.
  await withOpencodeReplay(opencodeCaptures.editRun, async (fake) => {
    const run = opencodeRun(dir);
    const result = await runAgent(run);
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.equal(tumwaterServer(fake), undefined, "no notes path means no tumwater MCP server");
  });
});

test("the invocation caps tool output at pi's window-scaled limits (part 6f/7)", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  // A fixture cache carrying the free model's catalog window (65,536) and a model the cache
  // does not know, so both the scaled-down and the default 128k values are exercised.
  writeOpencodeCache(dir, {
    fetchedAt: Date.now(),
    models: {
      "opencode/deepseek-v4.1-flash-free": { free: true, context: 65536 },
    },
  });
  await withOpencodeReplay(opencodeCaptures.editRun, async (fake) => {
    // A 65,536-window model: outputLimits(65536).bash is 8000, and 8000/40 is 200 lines.
    let run = opencodeRun(dir);
    let result = await runAgent(run);
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.deepEqual(toolOutputCaps(fake), { max_lines: 200, max_bytes: 8000 });

    // A model with no catalog entry keeps the 128k values: 16000 bytes / 400 lines.
    run = opencodeRun(dir, {
      config: { ...defaultConfig(), agent: "opencode", model: "not-in-cache" },
    });
    result = await runAgent(run);
    assert.equal(result.ok, true, `${result.errorMessage}`);
    assert.deepEqual(toolOutputCaps(fake), { max_lines: 400, max_bytes: 16000 });
  });
});

test("an opencode run finds the notes shim dir first on its PATH", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  await withOpencodeReplay(opencodeCaptures.editRun, async (fake) => {
    const result = await runAgent(opencodeRun(dir));
    assert.equal(result.ok, true, `${result.errorMessage}`);
    const env = fs.readFileSync(fake.envFile, "utf8");
    const pathLine = env.split("\n").find((l) => l.startsWith("PATH="))?.slice("PATH=".length);
    assert.ok(pathLine !== undefined, `the fake recorded a PATH: ${env}`);
    const binDir = path.join(dir, ".tumwater", "bin");
    assert.ok(
      pathLine!.startsWith(`${binDir}${path.delimiter}`),
      `the notes shim dir is first on PATH: ${pathLine}`,
    );
  });
});

test("invocation creates the OPENCODE_DB parent directory on a fresh team root, since opencode will not", () => {
  const dir = tmpdir("opencode-db-parent");
  fs.mkdirSync(path.join(dir, ".tumwater"), { recursive: true });
  const dbDir = path.join(dir, ".tumwater", "opencode");
  assert.equal(fs.existsSync(dbDir), false);
  const spec = {
    ...opencodeRun(dir),
    agentBin: "/nonexistent/opencode",
    runMarker: "m",
  };
  const inv = opencodeBackend.invocation(spec);
  assert.equal(inv.env.OPENCODE_DB, path.join(dbDir, "opencode.db"));
  assert.equal(fs.statSync(dbDir).isDirectory(), true);
});
