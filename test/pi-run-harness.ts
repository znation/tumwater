import { sleep } from "./wait.js";
import fs from "node:fs";
import path from "node:path";
import { runPi, type PiRunOptions, type PiRunResult } from "../src/pi.js";
import { defaultConfig } from "../src/config.js";
import { tmpdir } from "./repo-fixtures.js";
import { fakePi } from "./fake-pi.js";

/** The standard runPi fixture: a run against `dir` with the minimal prompt, a fresh
 * defaultConfig(), and throwaway session/raw-log paths — the shape every test starts from,
 * stated once so a new required runPi field lands in one place. `over` overrides any field
 * (config included), so a test states only what differs from this default; the returned
 * options object is passed to runPi or runPiVerified by the caller. */
export function runPiFixture(dir: string, over: Partial<PiRunOptions> = {}): PiRunOptions {
  return {
    cwd: dir,
    prompt: "p",
    config: defaultConfig(),
    sessionDir: path.join(dir, "sessions"),
    sessionName: "t",
    rawLogFile: path.join(dir, "raw.jsonl"),
    ...over,
  };
}

/** Run the fake pi through runPi with throwaway dirs and return the distilled result. */
export async function runFakePi(script: string) {
  const dir = tmpdir();
  const restore = fakePi(script);
  try {
    return await runPi(runPiFixture(dir));
  } finally {
    restore();
  }
}

// The suite runs under fleet load — review gates and main-baseline checks spawn full suites
// alongside — where spawning the fake pi or opening its log can transiently fail. Without a
// retry that environmental failure lands as a misleading raw-log content assertion in the
// tests that use this (a 2026-09-09 gate rejection of an unrelated GUI change was exactly
// this). A real log regression fails both attempts; only runs where pi produced nothing are
// retried.
export async function runPiVerified(opts: Parameters<typeof runPi>[0]): Promise<PiRunResult> {
  const first = await runPi(opts);
  if (first.ok || first.turns > 0) return first;
  fs.rmSync(opts.rawLogFile, { force: true }); // attempt one may have left a partial log
  await sleep(250); // let the resource pressure clear
  const second = await runPi(opts);
  if (second.ok || second.turns > 0) return second;
  throw new Error(
    `fake pi produced no output twice in a row — environmental (fleet load), not a log regression: ${first.errorMessage ?? "no error"}`,
  );
}
