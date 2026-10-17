// The OpenCode session-id minter (plans/opencode-backend.md "Sessions", finding 3): it
// reproduces Identifier.descending() — `ses_` + 12 hex digits (the low 48 bits of the NOT of
// ms×4096+counter) + 14 base-62 characters. A `ses_…` id in any other shape is refused with a
// free-tier 403 (finding 3), so the encode must match OpenCode exactly; the decode tests check
// it against the hexOpenCode minted in the live captures.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mintOpencodeSessionId } from "../src/agent/opencode/opencode-session-id.js";

const CAPTURES = fileURLToPath(new URL("../../test/fixtures/opencode-captures", import.meta.url));
const MOD_2_36 = 2 ** 36;

test("minted ids match the OpenCode shape ses_ + 12 hex + 14 base-62", () => {
  const id = mintOpencodeSessionId(1_700_000_000_000);
  assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

test("two ids minted in the same millisecond differ in their counter", () => {
  const zero = () => new Uint8Array(14);
  const a = mintOpencodeSessionId(1_700_000_000_000, zero);
  const b = mintOpencodeSessionId(1_700_000_000_000, zero);
  // Same ms and same random bytes, so only the hex (the counter) can differ.
  assert.notEqual(a.slice(4, 16), b.slice(4, 16));
});

test("a later millisecond sorts before an earlier one (descending)", () => {
  const zero = () => new Uint8Array(14);
  const earlier = mintOpencodeSessionId(1_700_000_000_000, zero);
  const later = mintOpencodeSessionId(1_700_000_001_000, zero);
  // hex = NOT of a larger current, so a later ms mints a smaller-that-sorts-earlier hex.
  assert.ok(later < earlier, "later id sorts before (less than) the earlier id");
});

test("the hex decodes to OpenCode's algorithm for the captured ids", () => {
  // Decode the low 48 bits: recovered = (ms × 4096 + counter), so counter = low 12 bits and
  // the millisecond is the shift. The 48 kept bits wrap ms×4096, so recovered ms = mint mod
  // 2^36 (the plan's modulus).
  const decodeMs = (hex: string): { ms: number; counter: number } => {
    const cur = (~BigInt(`0x${hex}`)) & 0xffffffffffffn;
    const counter = Number(cur % 4096n);
    return { ms: Number((cur - cur % 4096n) / 4096n), counter };
  };
  const fixture = (name: string) => fs.readFileSync(path.join(CAPTURES, `${name}.jsonl`), "utf8").split("\n", 1)[0] as string;

  for (const name of ["parallel-tools", "oversized-output", "background-shell"]) {
    const line = JSON.parse(fixture(name)) as { sessionID: string; timestamp: number };
    const hex = line.sessionID.slice(4, 16); // `ses_` + 12 hex digits
    const { ms, counter } = decodeMs(hex);
    assert.equal(counter, 1, `${name}: counter 1`);
    // The mint happened 0–10 s before the capture's first event timestamp, both taken modulo
    // 2^36 (the 48 kept bits hold ms × 4096 + the counter).
    const firstMod = line.timestamp % MOD_2_36;
    const delta = (firstMod - ms + MOD_2_36) % MOD_2_36;
    assert.ok(delta >= 0 && delta <= 10_000, `${name}: mint ${delta} ms before the first event (within 0–10 s)`);
  }
});
