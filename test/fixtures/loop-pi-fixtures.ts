import fs from "node:fs";
import { LoopPi } from "../../src/loop/loop-pi.js";
import { defaultConfig } from "../../src/config/config.js";
import type { TumwaterConfig } from "../../src/config/config-schema.js";
import type { PiRunResult } from "../../src/pi/pi-run-result.js";
import { fakePi } from "../fakes/fake-pi.js";
import { assistantLine } from "./pi-events.js";

/** Shared scaffolding for the loop-pi test files (loop-pi.test.ts and its siblings):
 * a recording LoopPi host, a fake pi that shapes the first (and optionally second)
 * invocation, and argv readers. Kept here so the per-surface test files share one copy. */
export interface Recording {
  warns: string[];
  usage: PiRunResult[];
  /** The seam hold key (seamHoldKey of the run's config) each foldUsage call carried, in
   * parallel to `usage` — a claude run folds `claude`, not the role's pi provider. */
  foldProviders: (string | undefined)[];
  /** Runs folded through foldLandingUsage (landing/review/conflict) — kept apart so a test
   * can prove those never charge the tick's pre-edit prefix. */
  landingUsage: PiRunResult[];
  /** The seam hold key each foldLandingUsage call carried, parallel to `landingUsage`. */
  landingFoldProviders: (string | undefined)[];
  /** Wall-clock ms of each foldUsage call, parallel to `usage`. */
  foldTimes: number[];
  /** ms passed to the retry's injected sleep, in call order. */
  sleeps: number[];
  /** Wall-clock ms of each injected sleep call, parallel to `sleeps`. */
  sleepAts: number[];
  abortRunSignal(): void;
}

export function makeHost(
  root: string,
  config: TumwaterConfig = defaultConfig(),
  role = "feature",
): Recording & { loopPi: LoopPi; config: TumwaterConfig } {
  const warns: string[] = [];
  const usage: PiRunResult[] = [];
  const foldProviders: (string | undefined)[] = [];
  const landingUsage: PiRunResult[] = [];
  const landingFoldProviders: (string | undefined)[] = [];
  const foldTimes: number[] = [];
  const sleeps: number[] = [];
  const sleepAts: number[] = [];
  const ctl = new AbortController();
  const host = {
    root,
    role,
    config: () => config,
    signal: undefined as AbortSignal | undefined,
    runSignal: () => ctl.signal,
    warn: (message: string) => warns.push(message),
    foldUsage: (run: PiRunResult, provider?: string) => {
      usage.push(run);
      foldProviders.push(provider);
      foldTimes.push(Date.now());
    },
    foldLandingUsage: (run: PiRunResult, provider?: string) => {
      landingUsage.push(run);
      landingFoldProviders.push(provider);
    },
    tickNumber: () => 1,
    // The retry's wait, recorded instead of lived through: a hint-less 429 now defaults to
    // a real minute (BUGS.md 2026-09-25), and no rate-limit test may spend wall clock on it.
    sleep: async (ms: number) => {
      sleeps.push(ms);
      sleepAts.push(Date.now());
    },
    abortRunSignal: () => ctl.abort(),
  };
  const loopPi = new LoopPi(host as unknown as ConstructorParameters<typeof LoopPi>[0]);
  return { loopPi, warns, usage, foldProviders, landingUsage, landingFoldProviders, foldTimes, sleeps, sleepAts, abortRunSignal: ctl.abort.bind(ctl), config };
}

/** A fake pi that records each invocation's argv. `firstRun` runs only on the first
 * invocation (a transient failure of the world); every later invocation prints the success
 * line the retry should observe. */
export function recordingFakePi(
  argsFile: string,
  opts: { firstRun?: string; retryRun?: string } = {},
): () => void {
  const lines = [`printf '%s\\n' "$*" >> "${argsFile}"`];
  if (opts.firstRun) {
    lines.push(
      `if [ ! -f "${argsFile}.ran-once" ]; then touch "${argsFile}.ran-once"; ${opts.firstRun}; exit 0; fi`,
      ...(opts.retryRun
        ? [`if [ ! -f "${argsFile}.ran-twice" ]; then touch "${argsFile}.ran-twice"; ${opts.retryRun}; exit 0; fi`]
        : []),
      `printf '%s\\n' '${assistantLine("done\\nSUMMARY: tidied src")}'`,
    );
  }
  return fakePi(lines.join("\n"));
}

export function runArgs(argsFile: string): string[] {
  return fs.readFileSync(argsFile, "utf8").trimEnd().split("\n");
}

/** The value following `flag` in a recorded argv block, or undefined when the flag is absent. */
export function flagValue(argv: string, flag: string): string | undefined {
  const parts = argv.split("\n");
  const i = parts.indexOf(flag);
  return i === -1 ? undefined : parts[i + 1];
}
