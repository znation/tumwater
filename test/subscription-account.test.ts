// --- src/agent/subscription-account.ts: the per-backend subscription account store
// (plans/codex-backend.md "Groundwork: the subscription account is per backend", item 1).
// These pin the generic store: the per-backend file path, the isolation of one backend's
// readings from another's file, and the reader's healing (absent/malformed/past-reset) when
// driven through the claude backend, in the same cases claude-account.test.ts covers for the
// claude-named wrappers.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  observeAccount,
  readAccount,
  writeAccount,
  type SubscriptionAccount,
} from "../src/agent/subscription-account.js";
import { accountPath, claudeAccountPath } from "../src/paths.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

function account(over: Partial<SubscriptionAccount> = {}): SubscriptionAccount {
  return { billing: "subscription", observedAt: 1_000, windows: {}, ...over };
}

test("readAccount: a missing codex file reads null, and the file is per backend", () => {
  const root = tmpdir();
  assert.equal(readAccount(root, "codex"), null, "no codex file yet");
  // A claude file must not be read as the codex account: each backend owns its own file.
  writeAccount(root, "claude", account({ observedAt: 7_000 }));
  assert.equal(readAccount(root, "codex"), null, "claude's file is not codex's");
  assert.equal(fs.existsSync(accountPath(root, "codex")), false);
  assert.equal(fs.existsSync(claudeAccountPath(root)), true, "only claude's file was written");
});

test("readAccount: absent and torn files read as no account", () => {
  const root = tmpdir();
  assert.equal(readAccount(root, "codex"), null, "no file");
  writeFileDeep(accountPath(root, "codex"), "{not json");
  assert.equal(readAccount(root, "codex"), null, "malformed json");
  fs.writeFileSync(accountPath(root, "codex"), JSON.stringify({ billing: "subscription" }));
  assert.equal(readAccount(root, "codex"), null, "no observedAt reads as absent");
  fs.writeFileSync(accountPath(root, "codex"), JSON.stringify({ billing: "nonsense", observedAt: 1 }));
  assert.equal(readAccount(root, "codex"), null, "unknown billing reads as absent");
});

test("readAccount: a window past its resetsAt reads back as reset", () => {
  const root = tmpdir();
  writeAccount(root, "claude", account({
    observedAt: 2_000,
    windows: {
      five_hour: { status: "rejected", resetsAt: 1_500, observedAt: 2_000 },
      seven_day: { status: "allowed", resetsAt: 9_000, observedAt: 2_000 },
    },
  }));

  const read = readAccount(root, "claude", 5_000);
  assert.equal(read?.windows.five_hour?.status, "reset");
  assert.equal(read?.windows.seven_day?.status, "allowed", "a future window keeps its status");
});

test("readAccount: a reset window drops its overage flags, an open one keeps them", () => {
  const root = tmpdir();
  const over = { isUsingOverage: true, overageStatus: "allowed", observedAt: 2_000 };
  writeAccount(root, "claude", account({
    observedAt: 2_000,
    windows: {
      five_hour: { status: "rejected", resetsAt: 1_500, ...over },
      seven_day: { status: "rejected", resetsAt: 9_000, ...over },
    },
  }));

  const read = readAccount(root, "claude", 5_000);
  assert.deepEqual(read?.windows.five_hour, { status: "reset", resetsAt: 1_500, observedAt: 2_000 });
  assert.equal(read?.windows.seven_day?.isUsingOverage, true);
  assert.equal(read?.windows.seven_day?.overageStatus, "allowed");
});

test("readAccount keeps the plan, stored under claude's subscriptionType file key", () => {
  const root = tmpdir();
  // The claude file's historical shape keeps the `subscriptionType` key; the store exposes it
  // as the generic `plan` field and writes it back under the same key.
  writeFileDeep(accountPath(root, "claude"),
    '{"billing":"subscription","subscriptionType":"team","observedAt":1000,"windows":{}}',
  );
  assert.equal(readAccount(root, "claude")?.plan, "team");

  writeAccount(root, "claude", { billing: "subscription", plan: "team", observedAt: 2_000, windows: {} });
  const raw = JSON.parse(fs.readFileSync(accountPath(root, "claude"), "utf8")) as Record<string, unknown>;
  assert.equal(raw.subscriptionType, "team", "the file keeps the historical key");
  assert.equal(Object.hasOwn(raw, "plan"), false, "the generic name stays out of the file");
  assert.equal(readAccount(root, "claude")?.plan, "team", "it round-trips");
});

test("observeAccount(root, \"codex\", run) writes only the codex file", () => {
  const root = tmpdir();
  // A pre-existing claude account must be untouched when a codex run observes its window.
  writeAccount(root, "claude", account({ billing: "api", observedAt: 7_000 }));

  const out = observeAccount(root, "codex", {
    billing: "subscription",
    rateWindows: [{ type: "five_hour", status: "allowed", utilization: 0.4 }],
  }, 42_000);

  assert.equal(out?.billing, "subscription");
  assert.equal(out?.windows.five_hour?.status, "allowed");
  assert.equal(out?.windows.five_hour?.utilization, 0.4);
  assert.equal(fs.existsSync(accountPath(root, "codex")), true, "the codex file was written");
  // claude's file keeps its own answer, unwritten by the codex run.
  const claude = JSON.parse(fs.readFileSync(claudeAccountPath(root), "utf8")) as SubscriptionAccount;
  assert.equal(claude.billing, "api");
  assert.deepEqual(claude.windows, {}, "claude's file was not touched");
});

test("observeAccount converts resetsAt to ms and round-trips", () => {
  const root = tmpdir();
  const out = observeAccount(root, "codex", {
    billing: "subscription",
    rateWindows: [
      { type: "five_hour", status: "allowed_warning", resetsAt: 1_700_000_000, utilization: 0.64 },
      { type: "seven_day", status: "allowed" },
    ],
  }, 42_000);
  assert.equal(out?.windows.five_hour?.resetsAt, 1_700_000_000_000, "unix seconds stored as epoch ms");
  assert.deepEqual(readAccount(root, "codex", 42_000), out);
});
