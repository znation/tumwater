import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  lockHashOf,
  parityBlockFor,
  readCiParity,
  recordParity,
  renderParityBlock,
} from "../src/run/ci-parity.js";
import { ciParityPath } from "../src/paths.js";
import { commitIn, mainSha, makeRepo, tmpdir, writeMalformedJson } from "./fixtures/repo-fixtures.js";
import { readJson } from "./helpers/json-read.js";

/** Unit coverage for src/run/ci-parity.ts — the `ci` observer's parity ledger (part 3/3).
 * Every `ci` run is a fresh session and a passing run that declares nothing-to-do leaves
 * nothing in the repo, so this runtime file is the only memory of which main tip and lock
 * hash the last green run covered; its read path must degrade to "no data" rather than fail
 * a run, and its render decides the run's whole cost (current → one model run, stale → the
 * full suite). */

const NOW = 1_800_000_000_000;
const TIP = "0123456789abcdef0123456789abcdef01234567";
const HASH = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

test("recordParity writes an entry that readCiParity round-trips", () => {
  const root = tmpdir();
  assert.equal(readCiParity(root), null, "missing file reads as no data");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  recordParity(root, TIP, "passed", NOW);
  const entry = readCiParity(root);
  assert.ok(entry, "recorded entry reads back");
  assert.equal(entry!.tip, TIP);
  assert.equal(entry!.result, "passed");
  assert.equal(entry!.lastRunAt, NOW);
  assert.match(entry!.lockHash, /^[0-9a-f]{64}$/, "the lock hash is computed from the lock file");
  // The ledger lives under .tumwater/state, never tracked — the path builder is the guard.
  assert.equal(ciParityPath(root), `${root}/.tumwater/state/ci-parity.json`);
});

test("readCiParity treats missing, torn, and wrong-shaped files as no data", () => {
  const root = tmpdir();
  assert.equal(readCiParity(root), null, "missing file");
  fs.mkdirSync(`${root}/.tumwater/state`, { recursive: true });
  writeMalformedJson(ciParityPath(root));
  assert.equal(readCiParity(root), null, "torn JSON");
  fs.writeFileSync(ciParityPath(root), JSON.stringify(["array"]));
  assert.equal(readCiParity(root), null, "array is not a ledger object");
  fs.writeFileSync(ciParityPath(root), JSON.stringify({ parity: "nope" }));
  assert.equal(readCiParity(root), null, "parity is not an object");
  fs.writeFileSync(ciParityPath(root), JSON.stringify({ parity: { tip: TIP, lockHash: HASH } }));
  assert.equal(readCiParity(root), null, "missing result or lastRunAt is malformed");
});

test("recordParity replaces the previous record rather than appending", () => {
  const root = tmpdir();
  recordParity(root, TIP, "passed", NOW);
  recordParity(root, "f3edcba9876543210fedcba9876543210fedcba98", "failed", NOW + 1000);
  const entry = readCiParity(root);
  assert.equal(entry!.tip, "f3edcba9876543210fedcba9876543210fedcba98");
  assert.equal(entry!.result, "failed");
  assert.equal(entry!.lastRunAt, NOW + 1000);
});

test("lockHashOf changes when package-lock.json content changes", () => {
  const root = tmpdir();
  assert.equal(lockHashOf(root), "", "no lock file reads as an empty hash");
  const pkg = path.join(root, "package-lock.json");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(pkg, '{"lockfileVersion":3}\n');
  const first = lockHashOf(root);
  assert.match(first, /^[0-9a-f]{64}$/);
  fs.writeFileSync(pkg, '{"lockfileVersion":3, "deps":{}}\n');
  assert.notEqual(lockHashOf(root), first, "a changed lock file hashes differently");
});

test("renderParityBlock declares current for the recorded green tip with a matching lock hash", () => {
  const block = renderParityBlock(
    { tip: TIP, lockHash: HASH, result: "passed", lastRunAt: NOW },
    TIP,
    HASH,
  );
  assert.match(block, /CI parity \(from this team's own record\):/);
  assert.match(block, /  current .*declare nothing-to-do without running the suite/);
  assert.match(block, /unmoved/);
  assert.match(block, new RegExp(shortId(TIP)));
  assert.match(block, new RegExp(shortId(HASH)));
});

test("renderParityBlock renders stale naming both shas and hashes when main moved", () => {
  const currentTip = "fedcba9876543210fedcba9876543210fedcba98";
  const block = renderParityBlock(
    { tip: TIP, lockHash: HASH, result: "passed", lastRunAt: NOW },
    currentTip,
    HASH,
  );
  assert.match(block, /  stale /);
  assert.match(block, /covered/);
  assert.match(block, new RegExp(shortId(TIP)));
  assert.match(block, new RegExp(shortId(currentTip)));
  assert.match(block, new RegExp(shortId(HASH)));
  assert.match(block, /Run the full suite and e2e/);
});

test("renderParityBlock renders stale when the lock hash changed", () => {
  const otherHash = "9999888877776666555544443333222211110000aaaabbbbccccddddeeeeffff";
  const block = renderParityBlock(
    { tip: TIP, lockHash: HASH, result: "passed", lastRunAt: NOW },
    TIP,
    otherHash,
  );
  assert.match(block, /  stale /);
  assert.match(block, new RegExp(shortId(HASH)));
  assert.match(block, new RegExp(shortId(otherHash)));
});

test("renderParityBlock renders stale when the last run failed even on the same tip", () => {
  const block = renderParityBlock(
    { tip: TIP, lockHash: HASH, result: "failed", lastRunAt: NOW },
    TIP,
    HASH,
  );
  assert.match(block, /  stale /);
  assert.match(block, /\(failed\)/);
});

test("parityBlockFor omits the block entirely when there is no record", () => {
  const root = makeRepo();
  assert.equal(parityBlockFor(root, undefined), undefined);
});

test("parityBlockFor renders current against an unmoved main tip", () => {
  const root = makeRepo();
  const tip = mainSha(root);
  recordParity(root, tip, "passed", NOW);
  const block = parityBlockFor(root, { baseBranch: "main" });
  assert.ok(block, "a recorded green tip yields a block");
  assert.match(block!, /current/);
});

test("parityBlockFor renders stale once main has moved", () => {
  const root = makeRepo();
  const tip = mainSha(root);
  recordParity(root, tip, "passed", NOW);
  commitIn(root, "move main");
  const block = parityBlockFor(root, { baseBranch: "main" });
  assert.ok(block, "main moved so the block is stale");
  assert.match(block!, /stale/);
  const persisted = readJson(ciParityPath(root)) as { parity: { tip: string } };
  assert.equal(persisted.parity.tip, tip, "the recorded tip is the covered one, before the move");
});

test("renderParityBlock declares current for a recorded abbreviated tip against the full head", () => {
  // A `ci` run reports the tip it covered as a short sha (extractCiResult accepts 7-64 chars);
  // the recorded `entry.tip` is therefore often an abbreviation of the 40-char head the render
  // resolves. The prefix match must read the short recorded tip as current.
  const shortTip = TIP.slice(0, 7);
  const block = renderParityBlock(
    { tip: shortTip, lockHash: HASH, result: "passed", lastRunAt: NOW },
    TIP,
    HASH,
  );
  assert.match(block, /  current .*declare nothing-to-do without running the suite/);
});

test("parityBlockFor renders current when the recorded tip is a short sha of the unmoved main head", () => {
  const root = makeRepo();
  const tip = mainSha(root);
  // The recorded tip is the abbreviated form a `CI:` line would have carried.
  recordParity(root, tip.slice(0, 7), "passed", NOW);
  const block = parityBlockFor(root, { baseBranch: "main" });
  assert.ok(block, "an abbreviated recorded tip still yields a block");
  assert.match(block!, /current/);

  // Once main moves, the old abbreviation is no longer a prefix of the new head, so the block
  // turns stale exactly as a full recorded tip would.
  commitIn(root, "move main");
  const stale = parityBlockFor(root, { baseBranch: "main" });
  assert.ok(stale, "main moved so the abbreviated tip is stale");
  assert.match(stale!, /stale/);
});

function shortId(id: string): string {
  return id.length > 7 ? id.slice(0, 7) : id;
}
