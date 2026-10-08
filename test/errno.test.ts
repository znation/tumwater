import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { errCode } from "../src/errno.js";
import { errnoError } from "./helpers/fs-faults.js";
import { tmpdir as makeTmpdir } from "./repo-fixtures.js";

// Unit seam for errno.ts — the one place the unsafe errno cast lives. Every catch site in the
// harness compares `errCode(err)` against a string code, so the function's undefined-yielding
// contract is load-bearing: a plain Error, a non-Error throw, a non-string `code`, and a
// missing throw altogether must all read as undefined rather than crashing or leaking the
// raw value. Before this file that contract (dist coverage line: the typeof guard's false
// branch) ran in no test — every caller path only ever fed it fabricated string-coded errors.

test("reads the errno code off a real fs throw", () => {
  const dir = makeTmpdir();
  try {
    fs.readFileSync(dir + "/definitely-missing-file");
    assert.fail("expected ENOENT");
  } catch (err) {
    assert.equal(errCode(err), "ENOENT");
  }
});

test("reads a second distinct errno code off a real fs throw", () => {
  const dir = makeTmpdir();
  fs.mkdirSync(dir + "/existing", { recursive: true });
  try {
    fs.mkdirSync(dir + "/existing");
    assert.fail("expected EEXIST");
  } catch (err) {
    assert.equal(errCode(err), "EEXIST");
  }
});

test("a plain Error without a code reads as undefined", () => {
  assert.equal(errCode(new Error("boom")), undefined);
});

test("a non-Error throw reads as undefined", () => {
  for (const thrown of ["boom", 42, null, undefined]) {
    assert.equal(errCode(thrown), undefined);
  }
});

test("any throw carrying a string code reads as that code, Error or not", () => {
  // The guard is typeof-based, not instanceof-based: a plain object shaped like an errno
  // error reads back as its code, which is what keeps the synthetic fault helpers working.
  assert.equal(errCode({ code: "ENOENT" }), "ENOENT");
});

test("a non-string code reads as undefined", () => {
  assert.equal(errCode(Object.assign(new Error("numeric"), { code: 42 })), undefined);
});

test("a synthetic errnoError from the fault-injection helpers reads back through errCode", () => {
  assert.equal(errCode(errnoError("EACCES", "permission denied")), "EACCES");
});
