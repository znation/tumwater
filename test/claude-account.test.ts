// --- src/agent/claude/claude-account.ts: the claude account state (plans/agent-backends.md
// part 6a). The file is a cache the orchestrator writes from each run's billing/rate-window
// report; these tests pin the reader's healing (absent/malformed/past-reset), the run
// observation's seconds→ms conversion, and the startup seed's billing decision.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  claudeWindowEntries,
  observeClaudeAccount,
  readClaudeAccount,
  seedClaudeAccount,
  writeClaudeAccount,
  type ClaudeAccount,
} from "../src/agent/claude/claude-account.js";
import { claudeAccountPath } from "../src/paths.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { defaultConfig } from "../src/config/config.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";

function account(over: Partial<ClaudeAccount> = {}): ClaudeAccount {
  return { billing: "subscription", observedAt: 1_000, windows: {}, ...over };
}

/** Run `fn` with the billing-decision env vars cleared, restoring them after. */
function withoutBillingEnv(fn: () => void): void {
  const keys = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) delete process.env[k];
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("readClaudeAccount: absent and malformed files read as no account", () => {
  const root = tmpdir();
  assert.equal(readClaudeAccount(root), null, "no file");
  fs.mkdirSync(path.dirname(claudeAccountPath(root)), { recursive: true });
  fs.writeFileSync(claudeAccountPath(root), "{not json");
  assert.equal(readClaudeAccount(root), null, "malformed json");
  fs.writeFileSync(claudeAccountPath(root), JSON.stringify({ billing: "subscription" }));
  assert.equal(readClaudeAccount(root), null, "no observedAt reads as absent");
  fs.writeFileSync(claudeAccountPath(root), JSON.stringify({ billing: "nonsense", observedAt: 1 }));
  assert.equal(readClaudeAccount(root), null, "unknown billing reads as absent");
});

test("readClaudeAccount: a window past its resetsAt reads back as reset", () => {
  const root = tmpdir();
  writeClaudeAccount(root, account({
    observedAt: 2_000,
    windows: {
      five_hour: { status: "rejected", resetsAt: 1_500, observedAt: 2_000 },
      seven_day: { status: "allowed", resetsAt: 9_000, observedAt: 2_000 },
    },
  }));

  const read = readClaudeAccount(root, 5_000);
  assert.equal(read?.windows.five_hour?.status, "reset");
  assert.equal(read?.windows.seven_day?.status, "allowed", "a future window keeps its status");
});

test("readClaudeAccount drops a non-finite utilization instead of keeping Infinity", () => {
  // utilization is healed like the observedAt/resetsAt stamps: a hand-edited or torn file's
  // `1e999` parses to Infinity, which would render as `Infinity%` and make the
  // claudeWindowEntries comparator return NaN.
  const root = tmpdir();
  fs.mkdirSync(path.dirname(claudeAccountPath(root)), { recursive: true });
  fs.writeFileSync(
    claudeAccountPath(root),
    '{"billing":"subscription","observedAt":1000,"windows":{"five_hour":{"status":"allowed","utilization":1e999,"observedAt":1000}}}',
  );
  const read = readClaudeAccount(root, 1_000);
  assert.equal(read?.windows.five_hour?.status, "allowed", "the window survives");
  assert.equal(
    Object.hasOwn(read!.windows.five_hour!, "utilization"),
    false,
    "the non-finite fraction is dropped, not kept as Infinity",
  );
});

test("observeClaudeAccount drops a non-finite run utilization at the write choke point", () => {
  const root = tmpdir();
  const out = observeClaudeAccount(root, {
    billing: "subscription",
    rateWindows: [{ type: "five_hour", status: "allowed", utilization: Number.POSITIVE_INFINITY }],
  }, 1_000);
  assert.equal(out?.windows.five_hour?.status, "allowed");
  assert.equal(
    Object.hasOwn(out!.windows.five_hour!, "utilization"),
    false,
    "a non-finite fraction never enters the file",
  );
});

test("observeClaudeAccount folds a run's billing and windows, converting resetsAt to ms", () => {
  const root = tmpdir();
  const out = observeClaudeAccount(root, {
    billing: "subscription",
    rateWindows: [
      { type: "five_hour", status: "allowed_warning", resetsAt: 1_700_000_000, utilization: 0.64 },
      { type: "seven_day", status: "allowed" },
    ],
  }, 42_000);

  assert.equal(out?.billing, "subscription");
  assert.equal(out?.observedAt, 42_000);
  const five = out?.windows.five_hour;
  assert.equal(five?.status, "allowed_warning");
  assert.equal(five?.resetsAt, 1_700_000_000_000, "unix seconds stored as epoch ms");
  assert.equal(five?.utilization, 0.64);
  assert.equal(five?.observedAt, 42_000);
  assert.equal(out?.windows.seven_day?.status, "allowed");

  // The file round-trips through the reader the same way.
  assert.deepEqual(readClaudeAccount(root, 42_000), out);
});

test("observeClaudeAccount leaves the file alone when a run reports no billing or windows", () => {
  const root = tmpdir();
  writeClaudeAccount(root, account({ billing: "api", observedAt: 7 }));

  const out = observeClaudeAccount(root, {}, 99_000);

  assert.equal(out?.billing, "api", "the stored answer survives");
  assert.equal(out?.observedAt, 7, "and is not restamped");
  assert.equal(readClaudeAccount(root, 99_000)?.billing, "api");
});

test("observeClaudeAccount updates only the reported window, keeping the other", () => {
  const root = tmpdir();
  writeClaudeAccount(root, account({
    windows: {
      five_hour: { status: "allowed", resetsAt: 9_000_000, observedAt: 1 },
      seven_day: { status: "rejected", resetsAt: 8_000_000, observedAt: 1 },
    },
  }));

  observeClaudeAccount(root, {
    billing: "subscription",
    rateWindows: [{ type: "five_hour", status: "rejected", resetsAt: 9_500_000 }],
  }, 5_000);

  const read = readClaudeAccount(root, 5_000);
  assert.equal(read?.windows.five_hour?.status, "rejected");
  assert.equal(read?.windows.seven_day?.status, "rejected", "the untouched window is kept");
});

test("observeClaudeAccount keeps a window whose type is a prototype key", () => {
  // `rateLimitType` is external claude input, and a plain `windows[type] = window` with the key
  // `__proto__` rewrites the map's prototype instead of adding an own entry: the window then
  // vanishes from every Object.entries/values reader, and JSON.stringify drops it from the file.
  const root = tmpdir();
  const out = observeClaudeAccount(root, {
    billing: "subscription",
    rateWindows: [{ type: "__proto__", status: "rejected", resetsAt: 9_000 }],
  }, 1_000);

  assert.equal(Object.hasOwn(out!.windows, "__proto__"), true, "the window is an own entry, not the map's prototype");
  assert.deepEqual(out!.windows["__proto__"], { status: "rejected", resetsAt: 9_000_000, observedAt: 1_000 });

  const read = readClaudeAccount(root, 1_000);
  assert.equal(Object.hasOwn(read!.windows, "__proto__"), true, "the reader keeps it too");
  assert.equal(read?.windows["__proto__"]?.status, "rejected");
});

test("writeClaudeAccount: a write that fails mid-way leaves the previous reading whole", (t) => {
  // The persisted billing/window cache is rewritten after every run that reports one. A plain
  // overwrite that dies partway (ENOSPC, EIO, a killed orchestrator) left a torn file, which
  // readClaudeAccount heals to null — silently "no subscription", so the window hold is ignored
  // until the next run re-observes. The write must leave the previous file untouched instead.
  const root = tmpdir();
  const before = account({ billing: "subscription", observedAt: 1_000, subscriptionType: "team" });
  writeClaudeAccount(root, before);

  const real = fs.writeFileSync as (file: fs.PathLike, data: string | Uint8Array) => void;
  t.mock.method(fs, "writeFileSync", ((file: fs.PathLike, data: string | Uint8Array) => {
    if (String(file).includes("claude-account.json")) {
      // The bytes land partially before the write dies — the torn file the reader would heal.
      real(file, String(data).slice(0, 5));
      throw new Error("ENOSPC: simulated mid-write failure");
    }
    return real(file, data);
  }) as typeof fs.writeFileSync);

  try {
    assert.throws(
      () => writeClaudeAccount(root, account({ billing: "api", observedAt: 2_000 })),
      /simulated mid-write failure/,
    );
  } finally {
    t.mock.restoreAll();
  }

  assert.deepEqual(readClaudeAccount(root, 2_000), before, "the previous reading survives a failed write");
});

test("seedClaudeAccount: ANTHROPIC_API_KEY means API billing", () => {
  const root = tmpdir();
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test";
  try {
    const seeded = seedClaudeAccount(root, defaultConfig() as TumwaterConfig, 123);
    assert.equal(seeded?.billing, "api");
    assert.equal(seeded?.observedAt, 123);
    assert.deepEqual(seeded?.windows, {});
    assert.equal(readClaudeAccount(root, 123)?.billing, "api");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("seedClaudeAccount: an existing account file is left alone", () => {
  withoutBillingEnv(() => {
    const root = tmpdir();
    writeClaudeAccount(root, account({ billing: "api", observedAt: 5 }));
    const seeded = seedClaudeAccount(root, defaultConfig() as TumwaterConfig, 999);
    assert.equal(seeded?.billing, "api");
    assert.equal(seeded?.observedAt, 5, "not re-seeded or restamped");
  });
});

test("seedClaudeAccount: a claude.ai login seeds subscription billing", () => {
  withoutBillingEnv(() => {
    const root = tmpdir();
    const bin = path.join(root, "fake-claude");
    fs.writeFileSync(
      bin,
      '#!/bin/sh\nprintf \'%s\' \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team"}\'\n',
    );
    fs.chmodSync(bin, 0o755);
    const config = defaultConfig() as TumwaterConfig;
    config.agent = "claude";
    config.agents = { claude: { bin } };

    const seeded = seedClaudeAccount(root, config, 321);
    assert.equal(seeded?.billing, "subscription");
    assert.equal(seeded?.subscriptionType, "team");
    assert.equal(readClaudeAccount(root, 321)?.billing, "subscription");
  });
});

test("claudeWindowEntries orders most constrained first by status severity", () => {
  const entries = claudeWindowEntries(account({
    windows: {
      seven_day: { status: "allowed", observedAt: 1 },
      reset: { status: "reset", observedAt: 1 },
      five_hour: { status: "rejected", resetsAt: 9_000, observedAt: 1 },
      warning: { status: "allowed_warning", observedAt: 1 },
    },
  }));
  assert.deepEqual(
    entries.map((e) => e.type),
    ["five_hour", "warning", "seven_day", "reset"],
    "rejected > allowed_warning > allowed > reset",
  );
  assert.equal(entries[0]?.resetsAt, 9_000, "the window entry keeps its own fields");
});

test("claudeWindowEntries breaks ties by utilization, then reset time, then type name", () => {
  // Same status (allowed_warning), differing utilization: higher utilization first, and a
  // missing reading sorts below any number.
  const byUtil = claudeWindowEntries(account({
    windows: {
      low: { status: "allowed_warning", utilization: 0.4, observedAt: 1 },
      high: { status: "allowed_warning", utilization: 0.9, observedAt: 1 },
      none: { status: "allowed_warning", observedAt: 1 },
    },
  }));
  assert.deepEqual(byUtil.map((e) => e.type), ["high", "low", "none"]);

  // Same status and utilization: the earlier reset sorts first.
  const byReset = claudeWindowEntries(account({
    windows: {
      later: { status: "rejected", utilization: 0.5, resetsAt: 9_000, observedAt: 1 },
      earlier: { status: "rejected", utilization: 0.5, resetsAt: 8_000, observedAt: 1 },
    },
  }));
  assert.deepEqual(byReset.map((e) => e.type), ["earlier", "later"]);

  // Identical readings: the type name decides, deterministically.
  const byName = claudeWindowEntries(account({
    windows: {
      zebra: { status: "allowed", utilization: 0.5, resetsAt: 9_000, observedAt: 1 },
      alpha: { status: "allowed", utilization: 0.5, resetsAt: 9_000, observedAt: 1 },
    },
  }));
  assert.deepEqual(byName.map((e) => e.type), ["alpha", "zebra"]);
});

test("claudeWindowEntries: empty account lists empty, prototype-key window listed as an entry", () => {
  assert.deepEqual(claudeWindowEntries(account()), []);
  // `setWindow` stores a `__proto__` rate-limit type as an own entry via defineProperty, so an
  // object literal cannot reproduce it — define it the same way the writer does.
  const proto = account();
  Object.defineProperty(proto.windows, "__proto__", {
    value: { status: "rejected", observedAt: 1 },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const entries = claudeWindowEntries(proto);
  assert.deepEqual(entries.map((e) => e.type), ["__proto__"], "a prototype-key window is an own entry");
});
