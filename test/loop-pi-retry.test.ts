import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { sessionDir } from "../src/paths.js";
import { defaultConfig } from "../src/config/config.js";
import { configForRole } from "../src/config/config-views.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { piRunResult, withPi } from "./fakes/fake-pi.js";
import { assistantLine, errorLine } from "./fixtures/pi-events.js";
import { makeHost, recordingFakePi, runArgs } from "./fixtures/loop-pi-fixtures.js";
import { LoopRunner } from "../src/loop/loop.js";
import { landingUsage } from "../src/merge/merge-slot.js";

// The shared transient-failure retry (src/loop/loop-pi.ts's runWithTransientRetry): the one
// bounded retry every pi run takes — the 429 branch with its Retry-After wait and cap, the
// timeout and stream-severed backend kinds, the pi-crash and idle-server-timeout kinds, and
// the backend-kind floor warning. Tested through a fake pi on PATH, so real spawning and
// parsing are in the loop. (The retry's policy end to end through a whole tick is pinned in
// loop-2.test.ts.)
test("a rate-limited run earns exactly one retry that waits out the Retry-After hint and continues the session", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    // The provider's 429 with its Retry-After hint, rendered as pi shows it.
    firstRun: `printf '%s\\n' '${errorLine('429 "Rate limit exceeded" — retry after 3s')}'`,
  });
  try {
    const { loopPi, warns, usage, foldTimes, sleeps, sleepAts } = makeHost(root);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-3-author");
    assert.equal(result.ok, true, "the retry succeeds");
    assert.match(result.finalText, /^done/);
    assert.equal(usage.length, 2, "BOTH attempts are folded into the tick's spend");
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /rate-limited the request \(429, retry after 3s\)/);

    const [firstArgs, retryArgs] = runArgs(args);
    assert.match(firstArgs!, /-n tumwater-feature-3-author/, "the first attempt starts fresh");
    assert.match(retryArgs!, /--continue/, "the retry resumes the first attempt's session");
    assert.ok(!(retryArgs!).includes('-n '), "the retry does not re-name the session");

    assert.deepEqual(sleeps, [3000], "the 3s hint is waited out before the retry");
    // The failed attempt folds BEFORE the wait and the retry, so the 429 it ended on reaches
    // the orchestrator's team-wide hold (LoopRunner.lastRateLimit) while the retry waits — not
    // after a retry that may run for an hour (BUGS.md 2026-09-21 "A 429 storm still has no
    // team-wide hold").
    assert.ok(foldTimes[0]! <= sleepAts[0]!, "the rate-limited attempt is folded before the wait starts");
  } finally {
    restore();
  }
});

test("a 429 run folds its seam hold key (the provider it ran on), not just the run", async () => {
  // PLANS.md "Mixed claude + pi fleets, part 2/4", gap 3: the rate-limit stamp must name the
  // backend that failed. Every run folds its seam hold key (seamHoldKey of the run's config)
  // — an `omlx` pi seam folds `omlx`, a claude seam would fold `claude` — so a storm is
  // blamed on the backend that actually failed, never the role's default provider.
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    firstRun: `printf '%s\\n' '${errorLine('429 "Rate limit exceeded" — retry after 3s')}'`,
  });
  try {
    const cfg = defaultConfig();
    cfg.agent = "pi";
    cfg.provider = "omlx";
    cfg.model = "qwen";
    const { loopPi, usage, foldProviders } = makeHost(root, cfg);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-3-author");
    assert.equal(result.ok, true, "the retry succeeds");
    assert.equal(usage.length, 2, "both attempts fold");
    assert.deepEqual(foldProviders, ["omlx", "omlx"], "both attempt folds name the omlx seam");
  } finally {
    restore();
  }
});

test("a 429 on a non-default reviewer seam folds that seam's hold key through foldLandingUsage", async () => {
  // The reviewer case: the gate's reviewer run folds through foldLandingUsage (authoring
  // false), and its config is the review seam — so the storm it ends on holds that seam's
  // key, not the pi author's default provider. (With a claude reviewer this is `claude`;
  // the omlx seam here proves the mechanism on the fake-pi backend.)
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    firstRun: `printf '%s\\n' '${errorLine('429 "Rate limit exceeded" — retry after 3s')}'`,
  });
  try {
    const cfg = defaultConfig();
    cfg.agent = "pi";
    cfg.provider = "omlx";
    cfg.model = "qwen";
    const { loopPi, landingUsage, landingFoldProviders } = makeHost(root, cfg);
    const result = await loopPi.runGatePi({
      cwd: root,
      kind: "gate",
      prompt: "review the change",
      config: configForRole(cfg, "feature"),
      sessionDir: sessionDir(root, "feature"),
      sessionName: "tumwater-review-feature-1",
      rawLogFile: path.join(root, "log.jsonl"),
      nativeLogFile: path.join(root, "native.jsonl"),
      label: "review",
    });
    assert.equal(result.ok, true, "the retry succeeds");
    assert.equal(landingUsage.length, 1, "the failed attempt folds through foldLandingUsage");
    assert.deepEqual(landingFoldProviders, ["omlx"], "the reviewer storm folds omlx");
  } finally {
    restore();
  }
});

test("a 429 on a claude reviewer's final run folds the review seam through foldLandingUsage", () => {
  // The reviewer's FINAL (retried) run is folded by merge-core.ts's reviewPinnedChange
  // through the landingUsage fold (src/merge/merge-slot.ts); loop-pi.ts folds only the
  // RETRIED first attempt. That final fold must stamp the REVIEW seam's hold key too — a
  // storm on a claude reviewer holds `claude`, never the pi author's default provider
  // (PLANS.md "Mixed claude + pi fleets, part 2/4", gap 3). The author's own provider is
  // omlx; the review seam is a claude model, so a correct landingUsage folds `claude`.
  const root = tmpdir();
  const cfg = defaultConfig();
  cfg.agent = "pi";
  cfg.provider = "omlx";
  cfg.model = "qwen";
  cfg.review = { ...cfg.review, provider: "claude", model: "claude-sonnet-5-5" };
  const author = new LoopRunner(root, "feature", cfg, "main");
  const { foldUsage } = landingUsage(author, root);
  foldUsage(piRunResult({ ok: false, transientRateLimit: true }));
  assert.equal(
    author.lastRateLimit?.provider,
    "claude",
    "the reviewer's 429 holds claude, not the pi author's omlx",
  );
});

test("a rate-limited run with no Retry-After hint waits the minute-scale refill pause, not 0", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    firstRun: `printf '%s\\n' '${errorLine('429 "Rate limit exceeded"')}'`,
  });
  try {
    const { loopPi, warns, usage, sleeps } = makeHost(root);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-4-author");
    assert.equal(result.ok, true);
    assert.equal(usage.length, 2);
    // The provider sent no hint, so the wait defaults to the team's own refill physics — the
    // minute-scale base hold (BUGS.md 2026-09-25: an immediate retry lands in the same
    // exhausted per-minute bucket and burns the tick's only retry) — and the warning says so.
    assert.deepEqual(sleeps, [60_000], "no hint means the minute-scale refill pause, not 0");
    assert.match(warns[0]!, /\(429, no hint — waiting 60s\) — retrying/);
  } finally {
    restore();
  }
});

test("a Retry-After hint of 0 counts as no hint and waits the minute-scale refill pause", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    // A provider can legitimately echo "Retry-After: 0" — which is no usable hint at all.
    firstRun: `printf '%s\\n' '${errorLine('429 "Rate limit exceeded" — retry after 0s')}'`,
  });
  try {
    const { loopPi, warns, sleeps } = makeHost(root);
    await loopPi.runRolePi(root, "work", "tumwater-feature-6-author");
    // A zero-second hint must not sneak the fixed 2026-09-25 bug back in through the side
    // door: a hint that asks for no wait is treated as no hint, so the refill pause applies.
    assert.deepEqual(sleeps, [60_000], "a 0-second hint waits the refill pause, not 0");
    assert.match(warns[0]!, /\(429, no hint — waiting 60s\) — retrying/);
  } finally {
    restore();
  }
});

test("a Retry-After hint larger than the cap is waited out only to the cap", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    firstRun: `printf '%s\\n' '${errorLine('429 "Rate limit exceeded" — retry after 300s')}'`,
  });
  try {
    const { loopPi, sleeps } = makeHost(root);
    await loopPi.runRolePi(root, "work", "tumwater-feature-5-author");
    assert.deepEqual(sleeps, [120_000], "one generous hint cannot eat the tick's own run budget");
  } finally {
    restore();
  }
});

test("runGatePi gives the reviewer the same 429 retry, folding only the failed attempt", async () => {
  // BUGS.md 2026-10-01: review.ts called bare runPi, so a 429 in the landing gate failed the
  // review on first contact — the gate's runs now take this wiring. The fold split: a RETRIED
  // first attempt is folded here (its spend is otherwise lost, and the fold stamps the
  // team-wide rate-limit hold before the wait), while the FINAL run is folded by the gate's
  // caller (landing-core's foldUsage of gate.run) — folding it twice would count the reviewer
  // twice.
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    firstRun: `printf '%s\\n' '${errorLine('429 "Rate limit exceeded" — retry after 3s')}'`,
  });
  try {
    const { loopPi, warns, usage, landingUsage, sleeps } = makeHost(root);
    const result = await loopPi.runGatePi({
      cwd: root,
      kind: "gate",
      prompt: "review the change",
      config: defaultConfig(),
      sessionDir: sessionDir(root, "feature"),
      sessionName: "tumwater-review-feature-1",
      rawLogFile: path.join(root, "log.jsonl"),
      nativeLogFile: path.join(root, "native.jsonl"),
      label: "review",
    });
    assert.equal(result.ok, true, "the retry succeeds");
    assert.equal(usage.length, 0, "a reviewer run never folds through the tick's authoring fold");
    assert.equal(landingUsage.length, 1, "the failed attempt folds through foldLandingUsage; the final run is the caller's");
    assert.match(warns[0]!, /rate-limited the request \(429, retry after 3s\)/);
    assert.deepEqual(sleeps, [3000], "the hint is waited out before the retry");
    const [firstArgs, retryArgs] = runArgs(args);
    assert.match(firstArgs!, /-n tumwater-review-feature-1/, "the gate's own session name is kept");
    assert.match(retryArgs!, /--continue/, "the retry resumes the review's session");
  } finally {
    restore();
  }
});

test("a backend-kind failure the retry does not cover warns once and earns no retry", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    // pi's fetch-level rendering of a dead provider endpoint — the connection kind of
    // BUGS.md 2026-09-29's silent storm.
    firstRun: `printf '%s\\n' '${errorLine("Connection error.")}'`,
  });
  try {
    const { loopPi, warns, usage } = makeHost(root);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-7-author");
    assert.equal(result.ok, false, "the run fails — a dead backend is not retried");
    assert.equal(result.transientBackend, true);
    assert.equal(result.backendKind, "connection");
    // The per-run floor (BUGS.md 2026-09-29): the episode is visible from the feed alone —
    // one warning naming the kind — where before it left only a per-tick error event.
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /provider backend failure \(connection error\)/);
    assert.equal(usage.length, 1, "one attempt, one foldUsage — no retry for this kind");
    assert.equal(runArgs(args).length, 1, "exactly one pi invocation");
  } finally {
    restore();
  }
});

test("a fallback-clone warning from pi surfaces as one loop warning", async () => {
  const root = tmpdir();
  // The run itself succeeds; only stderr carries the undefined-id warning pi emits before it
  // falls back to the provider default (BUGS.md 2026-10-06). The loop must surface it so a
  // silently mispriced id is visible from the feed alone.
  await withPi(
    [
      `printf '%s\\n' 'Warning: Model "x:deepinfra" not found for provider "huggingface". Using custom model id.' >&2`,
      `printf '%s\\n' '${assistantLine("done", { tokens: 5 })}'`,
    ].join("\n"),
    async () => {
      const { loopPi, warns, usage } = makeHost(root);
      const result = await loopPi.runRolePi(root, "work", "tumwater-feature-10-author");
      assert.equal(result.ok, true);
      assert.equal(warns.length, 1, "one warning for the one run");
      assert.match(warns[0]!, /could not resolve the model id exactly/);
      assert.match(warns[0]!, /not found for provider "huggingface"/);
      assert.equal(usage.length, 1, "the warning does not change the run's accounting");
    },
  );
});

test("a severed stream (terminated) warns and earns the one retry like the other transient kinds", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    // undici's bare word when the provider cuts the HTTP stream mid-run (BUGS.md 2026-09-30):
    // the session on disk is intact, so this is a transient of the world, not of the session.
    firstRun: `printf '%s\\n' '${errorLine("terminated")}'`,
  });
  try {
    const { loopPi, warns, usage } = makeHost(root);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-8-author");
    assert.equal(result.ok, true, "the retry succeeds — a fresh attempt on the intact session");
    assert.equal(runArgs(args).length, 2, "the severed-stream run is retried once");
    assert.equal(usage.length, 2, "both attempts fold — the failed one before the wait");
    assert.ok(
      warns.some((w) => w.includes('severed the in-flight stream (terminated)')),
      `the warning names the severing: ${warns.join(" | ")}`,
    );
  } finally {
    restore();
  }
});

test("a provider request timeout (Request timed out.) warns and earns the one retry after the refill pause", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    // The provider accepted the request and failed to answer it in time — the digest's #1
    // loss cause of 2026-09-30 (a combined 4.7 agent-hours discarded on first failure).
    // The session on disk is intact, so this is a transient of the world, not of the session.
    firstRun: `printf '%s\\n' '${errorLine("Request timed out.")}'`,
  });
  try {
    const { loopPi, warns, usage, sleeps } = makeHost(root);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-9-author");
    assert.equal(result.ok, true, "the retry succeeds — a fresh attempt on the intact session");
    assert.equal(runArgs(args).length, 2, "the request-timeout run is retried once");
    const [, retryLine] = runArgs(args);
    assert.match(retryLine!, /--continue/, "the retry resumes the first attempt's session");
    assert.equal(usage.length, 2, "both attempts fold — the failed one before the pause");
    assert.ok(
      warns.some((w) => w.includes('provider request timed out after accepting the connection')),
      `the warning names the timeout: ${warns.join(" | ")}`,
    );
    assert.ok(
      !warns.some((w) => w.includes('does not cover this kind')),
      `the retry now covers the timeout kind — no floor warning: ${warns.join(" | ")}`,
    );
    assert.deepEqual(
      sleeps,
      [60_000],
      "the retry waits the minute-scale refill pause an overloaded provider needs",
    );
  } finally {
    restore();
  }
});

test("a provider request timeout on pi's stderr earns the same retry and warning as the event spelling", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    // pi dying on the provider's own request timeout with the text only on stderr and no pi
    // event carrying it: the same failure the event-side test above drives, arriving the other
    // way. Both shapes must classify as the timeout backend kind and take the retry (BUGS.md
    // 2026-10-07).
    firstRun: `printf '%s\\n' 'Request timed out.' >&2\nexit 1`,
  });
  try {
    const { loopPi, warns, usage, sleeps } = makeHost(root);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-10-author");
    assert.equal(result.ok, true, "the retry succeeds — a fresh attempt on the intact session");
    assert.equal(runArgs(args).length, 2, "the stderr-arrived timeout is retried once");
    assert.match(runArgs(args)[1]!, /--continue/, "the retry resumes the first attempt's session");
    assert.ok(
      warns.some((w) => w.includes('provider request timed out after accepting the connection')),
      `the warning names the timeout: ${warns.join(" | ")}`,
    );
    assert.deepEqual(sleeps, [60_000], "the retry waits the minute-scale refill pause");
    assert.equal(usage.length, 2, "both attempts fold — the failed one before the pause");
  } finally {
    restore();
  }
});

test("a retry that ends on an uncovered backend kind still issues its own floor warning", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    // The first attempt ends on a covered transient (the request-timeout kind), so it earns
    // the one retry; the retry itself then dies on the UNCOVERED connection kind. The floor
    // must judge the run that is actually returned, not only the first attempt (BUGS.md
    // 2026-10-09), or the feed's last word is the first attempt's "retrying the agent run once".
    firstRun: `echo '${errorLine("Request timed out.")}'`,
    retryRun: `echo '${errorLine("Connection error.")}'`,
  });
  try {
    const { loopPi, warns, usage } = makeHost(root);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-11-author");
    assert.equal(result.ok, false, "the retry's connection failure is the returned run");
    assert.equal(result.transientBackend, true);
    assert.equal(result.backendKind, "connection");
    assert.equal(runArgs(args).length, 2, "the covered timeout earned exactly one retry");
    assert.equal(usage.length, 2, "both attempts fold — the retry folds before the floor");
    assert.ok(
      warns.some((w) => w.includes('provider request timed out after accepting the connection')),
      `the first attempt's warning names the covered timeout: ${warns.join(" | ")}`,
    );
    assert.ok(
      warns.some((w) => w.includes('provider backend failure (connection error)')),
      `the retry's own floor warning names the uncovered kind: ${warns.join(" | ")}`,
    );
    assert.equal(
      warns.filter((w) => w.includes('does not cover this kind')).length,
      1,
      `the floor warning is emitted exactly once: ${warns.join(" | ")}`,
    );
  } finally {
    restore();
  }
});

test("a retry that ends on a covered backend kind emits no false floor warning", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    // The first attempt ends on the timeout kind, which the retry DOES cover; the retry then
    // ends on the stream-severed kind, which it also covers. The floor warning's "the transient
    // retry does not cover this kind" would be false here, so the floor must stay silent and
    // leave the first attempt's "retrying the agent run once" as the run's last word (BUGS.md
    // 2026-10-09 review).
    firstRun: `echo '${errorLine("Request timed out.")}'`,
    retryRun: `echo '${errorLine("terminated")}'`,
  });
  try {
    const { loopPi, warns, usage } = makeHost(root);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-12-author");
    assert.equal(result.ok, false, "the retry's severed stream is the returned run");
    assert.equal(result.backendKind, "stream-severed");
    assert.equal(runArgs(args).length, 2, "the covered timeout earned exactly one retry");
    assert.equal(usage.length, 2, "both attempts fold");
    assert.ok(
      warns.some((w) => w.includes('provider request timed out after accepting the connection')),
      `the first attempt's warning names the covered timeout: ${warns.join(" | ")}`,
    );
    assert.ok(
      !warns.some((w) => w.includes('does not cover this kind')),
      `a covered retry gets no false floor warning: ${warns.join(" | ")}`,
    );
  } finally {
    restore();
  }
});

test("a successful run that merely saw a backend error mid-stream stays silent", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    // A provider blip that pi recovered from: the error line rides mid-stream and the run
    // still completes — nothing failed, so there is nothing to warn about.
    firstRun: `printf '%s\\n' '${errorLine("Connection error.")}' '${assistantLine("done\\nSUMMARY: tidied src")}'`,
  });
  try {
    const { loopPi, warns, usage } = makeHost(root);
    const result = await loopPi.runRolePi(root, "work", "tumwater-feature-8-author");
    assert.equal(result.ok, true);
    assert.equal(warns.length, 0, "a recovered run raises no alarm");
    assert.equal(usage.length, 1);
  } finally {
    restore();
  }
});
