import test from "node:test";
import assert from "node:assert/strict";
import { cappedRequestTimeouts } from "../src/request-timeouts.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";

const cfg = (tick: number, quiet: number) =>
  ({ tickTimeoutSeconds: tick, quietTimeoutSeconds: quiet }) as TumwaterConfig;

test("cappedRequestTimeouts clamps budgets above the follow-up caps", () => {
  assert.deepEqual(cappedRequestTimeouts(cfg(3600, 600), 120, 60), {
    tickTimeoutSeconds: 120,
    quietTimeoutSeconds: 60,
  });
});

test("cappedRequestTimeouts keeps budgets already under the caps", () => {
  assert.deepEqual(cappedRequestTimeouts(cfg(30, 10), 120, 60), {
    tickTimeoutSeconds: 30,
    quietTimeoutSeconds: 10,
  });
});

test("cappedRequestTimeouts forces the quiet cap when the config quiet timeout is 0", () => {
  assert.equal(cappedRequestTimeouts(cfg(3600, 0), 120, 60).quietTimeoutSeconds, 60);
});
