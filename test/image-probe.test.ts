import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import zlib from "node:zlib";
import { tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { readyRepo } from "./fixtures/doctor-fixtures.js";
import { writeScript } from "./fakes/fake-commands.js";
import { assistantLine, errorLine } from "./fixtures/pi-events.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import { loadConfig } from "../src/config/config.js";
import { imageProbesPath } from "../src/paths.js";
import { childEnv } from "../src/process/process.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import {
  IMAGE_PROBE_TTL_MS,
  imageProbeEntryFresh,
  imageProbeKey,
  makeProbePng,
  readImageProbeCache,
  runImageProbe,
  writeImageProbeCache,
  type ImageProbeCache,
  type ImageProbeCacheEntry,
} from "../src/doctor/image-probe.js";

// The doctor's live image probe (plans/image-input.md "Doctor", part 2/5): the in-process PNG
// (valid signature/chunks/CRCs, and inflating IDAT reproduces the drawn digits), the probe
// runner against a fake pi on PATH (pass, wrong-twice fail, 4xx fail, 5xx could-not-verify),
// and the cache file (read/write, freshness). The check's integration (probeImages, cache
// reuse, --reprobe) lives in test/doctor-model-checks.test.ts.

/** A config from a ready repo carrying just the model default, so the probe resolves a pi
 * binary through the config the way a real doctor run would. */
function probeConfig(): TumwaterConfig {
  const root = readyRepo();
  writeConfig(root, { model: { default: "local/text" } });
  return loadConfig(root);
}

/** A fake pi on TUMWATER_PI_BIN running `body` under the shared shell shim. */
function fakePi(body: string): NodeJS.ProcessEnv {
  const dir = tmpdir("image-probe-bin-");
  writeScript(path.join(dir, "pi"), body);
  return childEnv({ TUMWATER_PI_BIN: path.join(dir, "pi") });
}

// ── PNG generation ─────────────────────────────────────────────────────────────────────────

/** Decode a PNG into {width, height, rows} and verify the whole file: fixed octet signature,
 * each chunk's length and CRC, and the IDAT inflating to the width/height IHDR declared. */
function decodePng(png: Buffer): { width: number; height: number; pixels: (x: number, y: number) => number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) assert.equal(png[i], sig[i], `signature byte ${i}`);
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (;;) {
    assert.ok(off + 8 <= png.length, "chunk header in bounds");
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    assert.ok(dataEnd + 4 <= png.length, "chunk data in bounds");
    // CRC over type+data.
    const expected = png.readUInt32BE(dataEnd);
    const typeData = png.subarray(dataStart, dataEnd);
    const crcInput = png.subarray(off + 4, dataEnd);
    const crc = (() => {
      let c = 0xffffffff;
      const table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let v = n;
        for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
        table[n] = v >>> 0;
      }
      for (let i = 0; i < crcInput.length; i++) c = (table[(c ^ (crcInput[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    })();
    assert.equal(crc, expected, `CRC of ${type}`);
    if (type === "IHDR") {
      width = typeData.readUInt32BE(0);
      height = typeData.readUInt32BE(4);
      assert.equal(typeData[8], 8, "bit depth 8");
      assert.equal(typeData[9], 2, "color type truecolor RGB");
    } else if (type === "IDAT") {
      idat.push(typeData);
    } else if (type === "IEND") {
      break;
    }
    off = dataEnd + 4;
  }
  assert.ok(width > 0 && height > 0, "IHDR carried dimensions");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, height * (1 + width * 3), "IDAT inflates to full scanlines");
  const pixel = (x: number, y: number): number => {
    const p = y * (1 + width * 3) + 1 + x * 3;
    return ((raw[p] ?? 0) * 256 * 256 + (raw[p + 1] ?? 0) * 256 + (raw[p + 2] ?? 0)); // 0 == black, 16777215 == white
  };
  return { width, height, pixels: pixel };
}

test("makeProbePng builds a valid PNG that paints the requested digits black on white", () => {
  const png = makeProbePng("1234", 8);
  const { width, height, pixels } = decodePng(png);
  // 4 digits of 5*8, 3 gaps of 8.
  assert.equal(width, 4 * 5 * 8 + 3 * 8);
  assert.equal(height, 7 * 8);
  // Digit '1' (cell 0) bitmap row 0 is "00100": column 2 drawn, column 0 blank.
  const cell = 0;
  const cellStart = cell * (5 * 8 + 8);
  assert.equal(pixels(cellStart + 2 * 8, 0), 0, "drawn bit is black");
  assert.equal(pixels(cellStart + 0 * 8, 0), 16777215, "blank bit is white");
  // Digit '2' (cell 1) row 0 is "01110": column 1 drawn, column 0 blank.
  const cell2 = 1;
  const cell2Start = cell2 * (5 * 8 + 8);
  assert.equal(pixels(cell2Start + 1 * 8, 0), 0);
  assert.equal(pixels(cell2Start + 0 * 8, 0), 16777215);
});

// ── Probe runner, against a fake pi ────────────────────────────────────────────────────────

test("runImageProbe passes when the model echoes the code, caching nothing of its own", async () => {
  const env = fakePi(`printf '%s\\n' '${assistantLine("the 4-digit number is 1234")}'`);
  const result = await runImageProbe(probeConfig(), { provider: "local", model: "vision" }, env, 5000, "1234");
  assert.equal(result.verdict, "pass");
  assert.match(result.detail, /1234/);
});

test("runImageProbe fails after two wrong answers, naming what the model said", async () => {
  const env = fakePi(`printf '%s\\n' '${assistantLine("I cannot read any image")}'`);
  const result = await runImageProbe(probeConfig(), { provider: "local", model: "vision" }, env, 5000, "1234");
  assert.equal(result.verdict, "fail");
  assert.match(result.detail, /two wrong answers/);
});

// Two wrong *numbers* — the model read a number, wrongly — are a flaky misread, not blindness:
// the verdict must be the never-cached could-not-verify so a doctor run re-probes instead of
// turning a capable seam text-only for a week (a refusal earns the cached fail via the test
// above).
test("runImageProbe treats two wrong numbers as a misread (could-not-verify), not blindness", async () => {
  const env = fakePi(`printf '%s\\n' '${assistantLine("The number is 5825.")}'`);
  const result = await runImageProbe(probeConfig(), { provider: "local", model: "vision" }, env, 5000, "1234");
  assert.equal(result.verdict, "could-not-verify");
  assert.match(result.detail, /two misreads/);
  assert.match(result.detail, /5825/);
});

test("runImageProbe fails a 4xx request outright", async () => {
  const env = fakePi(`printf '%s\\n' '${errorLine("400: model_not_supported")}'`);
  const result = await runImageProbe(probeConfig(), { provider: "local", model: "vision" }, env, 5000, "1234");
  assert.equal(result.verdict, "fail");
  assert.match(result.detail, /4xx/);
});

test("runImageProbe reports a 5xx/connection error as could-not-verify", async () => {
  const env = fakePi(`printf '%s\\n' '${errorLine("500 Internal Server Error")}'`);
  const result = await runImageProbe(probeConfig(), { provider: "local", model: "vision" }, env, 5000, "1234");
  assert.equal(result.verdict, "could-not-verify");
  assert.match(result.detail, /5xx or connection/);
});

// ── The cache file ────────────────────────────────────────────────────────────────────────

test("the probe cache round-trips and a verdict expires after the 7-day TTL", () => {
  const root = readyRepo();
  const key = imageProbeKey("pi", "local", "vision");
  const entry: ImageProbeCacheEntry = { verdict: "pass", detail: "ok", at: Date.now(), claim: true };
  writeImageProbeCache(root, { [key]: entry });
  const read: ImageProbeCache = readImageProbeCache(root);
  assert.deepEqual(read[key], entry);
  assert.equal(imageProbeEntryFresh(read[key]), true);
  assert.equal(
    imageProbeEntryFresh({ ...read[key], at: Date.now() - IMAGE_PROBE_TTL_MS - 1 }),
    false,
    "older than the TTL is stale",
  );
});

test("the probe cache drops a foreign entry and keeps the valid ones", () => {
  const root = readyRepo();
  const now = Date.now();
  const valid: ImageProbeCacheEntry = { verdict: "pass", detail: "ok", at: now, claim: true };
  writeFileDeep(imageProbesPath(root),
    JSON.stringify({
      "pi/a/valid": valid,
      "pi/a/null": null,
      "pi/a/number": 7,
      "pi/a/string": "fail",
      "pi/a/verdict": { verdict: "maybe", detail: "x", at: now, claim: true },
      "pi/a/at": { verdict: "fail", detail: "x", at: "soon", claim: true },
      "pi/a/claim": { verdict: "pass", detail: "x", at: now },
    }),
  );
  assert.deepEqual(readImageProbeCache(root), { "pi/a/valid": valid });
});
