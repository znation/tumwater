/** The doctor's live image-input probe (plans/image-input.md "Doctor", part 2/5): a claimed
 * image-input capability in pi's models.json is only a claim — doctor shows each claimed model
 * a real image and checks the answer. This module owns three things: the in-process PNG
 * generator (a random 4-digit code drawn with a built-in 5×7 bitmap, encoded with
 * `zlib.deflateSync` + `zlib.crc32` is newer than the `>=20.3` node floor, so the CRC-32 here is
 * hand-rolled), the probe runner (the resolved pi binary in a run's environment, bounded like
 * the doctor's other binary probes), and the `.tumwater/state/image-probes.json` cache the
 * doctor check reads back. No new dependency; runs entirely offline against the operator's pi. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import zlib from "node:zlib";
import type { TumwaterConfig } from "../config/config-schema.js";
import { PiStreamParser } from "../pi/pi-stream.js";
import { resolveAgentBin } from "../pi/pi-bin.js";
import { releaseChildHandles, signalTree } from "../process/process.js";
import { imageProbesPath } from "../paths.js";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";

/** How long a cached image-probe verdict stays valid while the claim is unchanged (7 days) —
 * a model's endpoint can change underneath a stale pass, so the answer is dated. */
export const IMAGE_PROBE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The probe's deadline (90 s): a local model may need to load, far beyond the quick credential
 * probes, but a doctor run is still a pre-flight — a hung backend must lose, not stall the
 * report. */
const PROBE_TIMEOUT_MS = 90_000;

/** Cap on the probe's captured stdout, the same guard as the auth probes: a doctor run must not
 * grow an unbounded buffer off a runaway log. */
const PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;

/** The three probe outcomes. Only `pass` and `fail` are cached; `could-not-verify` (a timeout,
 * spawn failure, 429, 5xx, or connection error) says nothing about capability, so it is never
 * cached. */
type ImageProbeVerdict = "pass" | "fail" | "could-not-verify";

/** One probe result: the verdict plus what the model said or the error, for the doctor line. */
export interface ImageProbeResult {
  verdict: ImageProbeVerdict;
  detail: string;
}

/** One cached verdict, keyed by agent/provider/model. `claim` is the image-input claim the
 * probe tested (`true` — only claimed models are probed), so a claim change invalidates the
 * entry; `at` is the probe's epoch-ms stamp and a verdict is fresh only within IMAGE_PROBE_TTL_MS
 * of it. */
export interface ImageProbeCacheEntry {
  verdict: "pass" | "fail";
  detail: string;
  at: number;
  claim: boolean;
}

/** The probe cache: the whole `image-probes.json` file as one object keyed by
 * `imageProbeKey(agent, provider, model)`. */
export type ImageProbeCache = Record<string, ImageProbeCacheEntry>;

/** The cache-file key for one seam — agent/provider/model, the natural identity of a fleet
 * model, joined on `/` (agent and provider never contain it and a model id is fully qualified,
 * so the key cannot collide with another seam's). */
export function imageProbeKey(
  agent: string | undefined,
  provider: string | undefined,
  model: string | undefined,
): string {
  return [agent ?? "", provider ?? "", model ?? ""].join("/");
}

/** Whether a cached entry still stands for the current claim: it exists, it recorded a real
 * verdict (never `could-not-verify`, which is never cached), it tested the image-input claim,
 * and it is younger than the TTL. */
export function imageProbeEntryFresh(
  entry: ImageProbeCacheEntry | undefined,
  now: number = Date.now(),
): boolean {
  return (
    entry !== undefined &&
    (entry.verdict === "pass" || entry.verdict === "fail") &&
    entry.claim &&
    now - entry.at <= IMAGE_PROBE_TTL_MS
  );
}

/** Read the probe cache, or an empty cache when the file is missing or torn (the harness's
 * no-data policy: a crashed writer never takes down a reader). */
export function readImageProbeCache(root: string): ImageProbeCache {
  return readJsonFile<ImageProbeCache>(imageProbesPath(root)) ?? {};
}

/** Write the probe cache atomically (tmp+rename) so a concurrent reader never sees a torn
 * file. */
export function writeImageProbeCache(root: string, cache: ImageProbeCache): void {
  writeJsonAtomic(imageProbesPath(root), cache);
}

// ── PNG generator ─────────────────────────────────────────────────────────────────────────

/** Each digit as 7 rows of 5 bits, '1' = drawn (black); the standard 5×7 seven-segment-ish
 * font, big enough for a vision model to read and small enough to stay a trivial payload. */
const DIGIT_BITMAP: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};

/** A hand-rolled CRC-32 (the PNG chunk checksum): `zlib.crc32` is newer than the `>=20.3` node
 * floor, so this bitwise table version is the one home of the polynomial. */
const CRC32_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC32_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: 4-byte big-endian length, the 4-byte ASCII type, the data, and the CRC over
 * type+data. */
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** A PNG showing `code` black on white, drawn with the 5×7 bitmap scaled `scale`-fold (each
 * font cell becomes a `scale`×`scale` block) and one `scale`-wide gap between digits. Truecolor
 * (color type 2) so any reader handles it and the decode-check in the tests is trivial. Exported
 * for tests (and the doctor's own validity check of a generated image). */
export function makeProbePng(code: string, scale = 8): Buffer {
  const digits = [...code].map((d) => DIGIT_BITMAP[d] ?? DIGIT_BITMAP["0"]);
  const width = digits.length * 5 * scale + (digits.length - 1) * scale;
  const height = 7 * scale;
  // Truecolor RGB scanlines, each prefixed with filter byte 0 (none).
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      // Which font cell does this pixel fall in?
      const cell = Math.floor(x / (5 * scale + scale));
      const inCellX = x - cell * (5 * scale + scale);
      const cellDigit = digits[cell];
      const row = Math.floor(y / scale);
      const col = Math.floor(inCellX / scale);
      const bit =
        inCellX < 5 * scale && cellDigit !== undefined
          ? ((cellDigit[row] ?? "")[col] ?? "")
          : "";
      const on = bit === "1";
      const p = rowStart + 1 + x * 3;
      raw[p] = on ? 0 : 255;
      raw[p + 1] = on ? 0 : 255;
      raw[p + 2] = on ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A random 4-digit code for one probe attempt. */
function randomCode(): string {
  let out = "";
  for (let i = 0; i < 4; i++) out += String(randomInt(0, 10));
  return out;
}

// ── Probe runner ──────────────────────────────────────────────────────────────────────────

/** One bounded probe of the resolve pi binary: `null` when the spawn threw, the child errored,
 * the deadline passed, or stdout overran the cap — every case the caller reads as "could not
 * check". The child runs detached and at the deadline (or on overrun) its whole process group
 * is SIGKILLed and the promise settles, because `'close'` waits for the stdio pipes and a
 * grandchild holding them open would otherwise leave the promise pending past the deadline (the
 * same trap the doctor's other binary probes close). */
function boundedProbe(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string } | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // Detached so the deadline's signalTree reaches a grandchild too; stderr is ignored
      // rather than piped, since nothing reads it and a full stderr pipe would block the child.
      child = spawn(bin, args, { cwd: process.cwd(), detached: true, stdio: ["ignore", "pipe", "ignore"], env });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let bytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: { code: number | null; stdout: string } | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      releaseChildHandles(child);
      resolve(result);
    };
    const abort = (): void => {
      signalTree(child, "SIGKILL");
      settle(null);
    };
    timer = setTimeout(abort, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      bytes += chunk.length;
      if (bytes > PROBE_MAX_OUTPUT_BYTES) abort();
    });
    child.on("error", () => settle(null));
    child.on("close", (code) => settle({ code, stdout: out }));
  });
}

/** Parse the resolved probe's stdout (pi's `--mode json` event stream) the same way a real run
 * is parsed, so a live probe sees the same final text and error classification the harness
 * would. */
function parseProbeOutput(stdout: string): {
  finalText: string;
  configError: boolean;
  transientRateLimit: boolean;
  transientBackend: boolean;
} {
  const parser = new PiStreamParser();
  parser.feed(stdout);
  return {
    finalText: parser.finalText,
    configError: parser.configError,
    transientRateLimit: parser.transientRateLimit,
    transientBackend: parser.transientBackend,
  };
}

/** Probe one claimed pi seam with a real image (plans/image-input.md "Doctor"). Runs the
 * resolved pi binary in a run's environment (the caller passes `env`, typically
 * `childEnv({ PATH: pathEnv })` which inherits `PI_CODING_AGENT_DIR`, so the probe reads the
 * same models.json a real tick would):
 *
 *   `pi --print --mode json --no-session --no-tools --no-mcp --provider P --model M
 *        --thinking <level> @<png> "Reply with only the 4-digit number shown in the image."`
 *
 * Pass: the final assistant text contains the code. A wrong answer retries once with a fresh
 * code (a misread is not blindness); two wrong answers fail, and so does a 4xx. A timeout,
 * spawn failure, 429, 5xx, or connection error is `could-not-verify` — it says nothing about
 * capability and is never cached. `code` is a test seam (a real probe always draws a fresh
 * random code); `env` and `timeoutMs` are injectable so tests need no real pi. */
export async function runImageProbe(
  config: TumwaterConfig,
  seam: { provider?: string; model: string; thinking?: string },
  env: NodeJS.ProcessEnv,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  code?: string,
): Promise<ImageProbeResult> {
  const envBin = env.TUMWATER_PI_BIN?.trim();
  // Resolve from the run's own environment (env override → config), exactly as a real tick's
  // spawn would rather than only the harness process env — so tests can point a fake pi there.
  const bin = envBin
    ? envBin.includes("/")
      ? path.resolve(envBin)
      : envBin
    : resolveAgentBin(config).bin;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tumwater-image-probe-"));
  let lastDetail = "";
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const thisCode = code ?? randomCode();
      const png = makeProbePng(thisCode);
      const pngPath = path.join(dir, `probe-${attempt}.png`);
      fs.writeFileSync(pngPath, png);
      const args = ["--print", "--mode", "json", "--no-session", "--no-tools", "--no-mcp"];
      if (seam.provider) args.push("--provider", seam.provider);
      if (seam.model) args.push("--model", seam.model);
      if (seam.thinking) args.push("--thinking", seam.thinking);
      args.push(`@${pngPath}`, "Reply with only the 4-digit number shown in the image.");
      const result = await boundedProbe(bin, args, env, timeoutMs);
      if (result === null)
        return { verdict: "could-not-verify", detail: "the probe could not run or timed out" };
      const parsed = parseProbeOutput(result.stdout);
      if (parsed.configError)
        return { verdict: "fail", detail: "the provider rejected the request (4xx)" };
      if (parsed.transientRateLimit)
        return { verdict: "could-not-verify", detail: "the provider rate-limited the request (429)" };
      if (parsed.transientBackend)
        return { verdict: "could-not-verify", detail: "the provider backend failed (5xx or connection)" };
      const text = parsed.finalText;
      if (text.includes(thisCode)) return { verdict: "pass", detail: `answered "${text.trim()}"` };
      lastDetail = text.trim() ? `answered "${text.trim()}"` : "answered nothing";
    }
    return { verdict: "fail", detail: `two wrong answers (${lastDetail})` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
