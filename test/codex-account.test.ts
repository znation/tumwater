// src/agent/codex/codex-account.ts: the codex specialization of the per-backend subscription
// account store (src/agent/subscription-account.ts, plans/codex-backend.md "Groundwork"). The
// reader's healing and the run observation's seconds→ms conversion live in the generic store
// and are pinned through the codex wrappers and by test/subscription-account.test.ts; the
// startup seed's billing decision — `codex login status` naming a ChatGPT login vs an API
// key — stays codex-only and is exercised here with a fake binary on PATH.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  observeCodexAccount,
  parseCodexLoginStatus,
  readCodexAccount,
  seedCodexAccount,
} from "../src/agent/codex/codex-account.js";
import { writeAccount, type SubscriptionAccount } from "../src/agent/subscription-account.js";
import { accountPath } from "../src/paths.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { defaultConfig } from "../src/config/config.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";

/** A config with a codex backend whose `bin` points at a fake `codex` script. */
function codexConfig(bin: string): TumwaterConfig {
  const config = defaultConfig() as TumwaterConfig;
  config.backend = "codex";
  config.backends = { codex: { bin } };
  return config;
}

/** A fake `codex` that prints `line` on any `login status` call and returns the given status. */
function fakeLogin(line: string, status = 0): string {
  const bin = path.join(tmpdir("codex-login-"), "codex");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${line}'\nexit ${status}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("parseCodexLoginStatus reads a ChatGPT login and an API key, else null", () => {
  assert.equal(parseCodexLoginStatus("Logged in using ChatGPT"), "subscription");
  assert.equal(parseCodexLoginStatus("Logged in using an API key"), "api");
  assert.equal(parseCodexLoginStatus("Not logged in"), null);
  assert.equal(parseCodexLoginStatus(""), null);
  assert.equal(parseCodexLoginStatus(null), null);
});

test("seedCodexAccount: a ChatGPT login seeds subscription billing", () => {
  const root = tmpdir();
  const seeded = seedCodexAccount(root, codexConfig(fakeLogin("Logged in using ChatGPT")), 123);
  assert.equal(seeded?.billing, "subscription");
  assert.equal(readCodexAccount(root, 123)?.billing, "subscription");
});

test("seedCodexAccount: an API-key login seeds API billing", () => {
  const root = tmpdir();
  const seeded = seedCodexAccount(root, codexConfig(fakeLogin("Logged in using an API key")), 123);
  assert.equal(seeded?.billing, "api");
  assert.equal(readCodexAccount(root, 123)?.billing, "api");
});

test("seedCodexAccount: a not-logged-in or failing probe seeds nothing", () => {
  const root = tmpdir();
  assert.equal(seedCodexAccount(root, codexConfig(fakeLogin("Not logged in")), 123), null);
  assert.equal(readCodexAccount(root, 123), null, "no file written");
  assert.equal(seedCodexAccount(root, codexConfig(fakeLogin("Logged in using ChatGPT", 1)), 123), null, "nonzero exit");
  assert.equal(readCodexAccount(root, 123), null);
});

test("seedCodexAccount: an existing account file is left alone", () => {
  const root = tmpdir();
  const existing: SubscriptionAccount = { billing: "subscription", observedAt: 1, windows: {} };
  writeAccount(root, "codex", existing);
  // The fake would say API, but an existing file is never overwritten by the seed.
  const seeded = seedCodexAccount(root, codexConfig(fakeLogin("Logged in using an API key")), 999);
  assert.equal(seeded?.billing, "subscription", "an existing file is returned unchanged");
  assert.equal(readCodexAccount(root, 999)?.billing, "subscription", "the existing billing wins");
  assert.equal(fs.readFileSync(accountPath(root, "codex"), "utf8").includes("subscription"), true);
});

test("seedCodexAccount re-probes a stale api answer so the refusal is not sticky", () => {
  const root = tmpdir();
  const stale: SubscriptionAccount = { billing: "api", observedAt: 1, windows: {} };
  writeAccount(root, "codex", stale);
  // The file once saw an API key; the operator has since fixed the login (the refusal's named
  // remedy, `codex login --device-auth`), so the seed must re-probe and clear the refusal
  // rather than returning the stale api answer forever.
  const seeded = seedCodexAccount(root, codexConfig(fakeLogin("Logged in using ChatGPT")), 999);
  assert.equal(seeded?.billing, "subscription", "the re-probe clears the stale api answer");
  assert.equal(readCodexAccount(root, 999)?.billing, "subscription");
});

test("seedCodexAccount: a stale api answer whose re-probe still sees api stays api", () => {
  const root = tmpdir();
  const stale: SubscriptionAccount = { billing: "api", observedAt: 1, windows: {} };
  writeAccount(root, "codex", stale);
  const seeded = seedCodexAccount(root, codexConfig(fakeLogin("Logged in using an API key")), 999);
  assert.equal(seeded?.billing, "api", "an API-key login still refuses");
});

test("seedCodexAccount: a stale api answer whose re-probe cannot decide keeps refusing", () => {
  const root = tmpdir();
  const stale: SubscriptionAccount = { billing: "api", observedAt: 1, windows: {} };
  writeAccount(root, "codex", stale);
  // A re-probe that cannot decide must not fail open: returning null would let the gate pass
  // while the stale api file remains. It keeps the api answer so the refusal holds.
  const seeded = seedCodexAccount(root, codexConfig(fakeLogin("Not logged in")), 999);
  assert.equal(seeded?.billing, "api", "an indeterminate re-probe keeps the api refusal");
  assert.equal(readCodexAccount(root, 999)?.billing, "api", "the api file stays in place");
});

test("seedCodexAccount: a failed account write returns null instead of throwing", () => {
  const root = tmpdir();
  // A directory where the account file path itself lives blocks the write.
  fs.mkdirSync(accountPath(root, "codex"), { recursive: true });
  const seeded = seedCodexAccount(root, codexConfig(fakeLogin("Logged in using ChatGPT")), 123);
  assert.equal(seeded, null);
});

test("observeCodexAccount folds a run's billing and windows under the codex id", () => {
  const root = tmpdir();
  const run = {
    billing: "subscription" as const,
    rateWindows: [{ type: "seven_day", status: "rejected", utilization: 0.72, resetsAt: 1000 }],
  };
  observeCodexAccount(root, run, 1000);
  const account = readCodexAccount(root, 1000);
  assert.equal(account?.billing, "subscription");
  assert.equal(account?.windows.seven_day?.status, "rejected");
  assert.equal(account?.windows.seven_day?.utilization, 0.72);
});

test("seedCodexAccount probes under the team config dir's CODEX_HOME", () => {
  const root = tmpdir();
  const capture = path.join(root, "env-capture");
  const bin = path.join(root, "fake-codex");
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s' "$CODEX_HOME" > "${capture}"\nprintf '%s\\n' 'Logged in using ChatGPT'\n`,
  );
  fs.chmodSync(bin, 0o755);
  const config = codexConfig(bin);
  config.backends = { codex: { bin, configDir: "~/team-codex" } };
  const seeded = seedCodexAccount(root, config, 321);
  assert.equal(seeded?.billing, "subscription", "the in-dir login seeds a subscription");
  assert.equal(fs.readFileSync(capture, "utf8"), path.join(os.homedir(), "team-codex"));
});
