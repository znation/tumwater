// vocabulary: plain
import type { TumwaterConfig } from "./config-schema.js";
import { changedConfigKeys, loadConfigCached } from "./config.js";
import { runnerIds } from "../roles/runner-ids.js";
import { configForRole, teamModelLabel, modelSelectorField } from "./config-views.js";
import { seamsInUse } from "./config-fallbacks.js";
import { bestEffortEventLogger, TUMWATER_SOURCE } from "../events/events.js";
import { RoleRunner } from "../runner/runner.js";
import { configPath } from "../paths.js";
import type { Semaphore } from "../concurrency/semaphore.js";
import { seedClaudeAccount } from "../agent/claude/claude-account.js";
import { backendMissingMessage, findBackendBinary, resolveBackendBin } from "../pi/pi-bin.js";

/** The orchestrator's live view of tumwater.json: the single reload point shared by all roles,
 * polled once per scheduler cycle (src/orchestrator/orchestrator.ts). A broken file keeps the
 * last-known-good config and warns once per distinct error text; an unchanged file is served
 * from a stat-keyed cache (one stat per poll, no read). Owns all the edge-triggered bookkeeping
 * so each crossing logs exactly one event instead of once per poll: missing/reappeared,
 * config_changed's changed keys, live role enable/disable (creating a runner for each newly
 * enabled role), and the semaphore's live-resized concurrency cap. */
interface LiveConfigReload {
  /** Poll the config file once, applying any reload and its side effects; returns the live
   * config — the last successful reload's (last-known-good while the file is broken or
   * missing). */
  poll(): TumwaterConfig;
}

/** A live config reloader over the given wiring; poll it once per scheduler cycle (see
 * LiveConfigReload for the contract). */
export function newLiveConfigReload(deps: {
  root: string;
  /** The startup config: the first live config and the config_changed baseline (seeded so the
   * first poll of an unchanged file logs nothing). */
  config: TumwaterConfig;
  mainBranch: string;
  /** The signal every runner watches — the orchestrator's roleSignal (the caller's stop plus
   * both internal stops), NOT the full harness signal: a role enabled mid-run must be cut off
   * by the restart drain's role-run abort exactly like a startup runner (BUGS.md 2026-09-30). */
  runnerSignal: AbortSignal;
  /** The orchestrator's runner list, mutated in place: a role enabled mid-run gets a runner
   * appended here (its persisted state survives). */
  runners: RoleRunner[];
  /** The shared concurrency cap, live-resized when maxConcurrent changes. */
  semaphore: Semaphore;
  /** A scoped once round's role filter (`run --once --role <id>[,<id>...]`): a mid-round
   * config edit that enables another role still logs its `role enabled` warning, but no
   * runner is created for it — the round must not silently widen past the roles it was
   * scoped to. Undefined in daemon and unscoped-once runs, which create a runner for every
   * newly enabled role. */
  roleFilter?: readonly string[];
}): LiveConfigReload {
  // The last config error already warned about (a broken file must warn once per distinct text,
  // not every poll), whether the file is currently missing (one warning per vanish, one line
  // when it reappears), and the previous cycle's enabled set (for one-shot enable/disable
  // transition warnings).
  let lastConfigError: string | null = null;
  let configMissing = false;
  let prevEnabled = new Set(runnerIds(deps.config));
  let live = deps.config;
  // The previous successful reload's config, for the one-shot config_changed event. Seeded from
  // the startup config, so the first poll of an unchanged file logs nothing.
  let prevLive = deps.config;
  // The cap last applied to the semaphore (live-resized on each reload), so a change logs
  // exactly one event per distinct value — not once per poll.
  let lastMaxConcurrent = Math.max(1, deps.config.maxConcurrent);
  // The per-provider caps last applied to the semaphore (live-resized on each reload), so a
  // change logs exactly one event per distinct value — not once per poll. Seeded from the
  // startup config, so the first poll of an unchanged file emits nothing.
  let lastKeyCaps: Record<string, number> = deps.config.maxConcurrentPerProvider ?? {};

  // Roots this process has already attempted a live-edit claude-account seed for (see the
  // reload block below), so repeated polls of a config that keeps a claude seam cannot respawn
  // `claude auth status` on every cycle.
  const liveClaudeSeedAttempted = new Set<string>();

  // Best-effort event logging: poll() runs inside the orchestrator's poll loop
  // (src/orchestrator/orchestrator.ts), which has no catch, so an unwritable feed (ENOSPC,
  // EACCES, the path replaced by a directory) would otherwise end the team — and, worse, skip
  // the config application that follows the emission. bestEffortEventLogger (events.ts) holds
  // the shared "logging must not throw" policy.
  const { emit, warn } = bestEffortEventLogger(deps.root);

  return {
    poll() {
      const reloaded = loadConfigCached(deps.root);
      // A missing file keeps the last-known-good config too, and never reloads as defaults: the
      // team was started on a real file (startup refuses to run without one), so its vanishing
      // mid-run is an incident — a merge's fast-forward deleted it on 2026-09-22 and the team
      // silently ran 8.6 h on defaults (BUGS.md 2026-09-23). One warning per vanish, not per
      // poll; its return logs one line, then the normal reload below diffs it against the
      // retained config — so config_changed names only what the returned file really changed.
      if (reloaded.missing) {
        if (!configMissing) {
          warn(`tumwater.json missing — keeping current config until it returns (${configPath(deps.root)})`);
          configMissing = true;
          lastConfigError = null; // Whatever state it returns in is stated afresh.
        }
      } else if (configMissing) {
        warn("tumwater.json reappeared — reloading it");
        configMissing = false;
      }
      if (reloaded.config) {
        live = reloaded.config;
        const nextConfig = reloaded.config;
        // A live edit that changes behavior elsewhere logs one event naming the settings that
        // changed (maxConcurrent and sessionRetentionDays have their own events elsewhere).
        const changedKeys = changedConfigKeys(prevLive, reloaded.config);
        if (changedKeys.length > 0) {
          emit({ source: TUMWATER_SOURCE, type: "config_changed", keys: changedKeys });
          // A real model-wiring change gets its own event naming the new selector(s), which the
          // key list cannot show; a non-model edit (instructions, an interval) emits nothing.
          const fromModel = teamModelLabel(prevLive);
          const toModel = teamModelLabel(reloaded.config);
          const roleDiffs = changedKeys
            .filter((key) => key.startsWith("roles."))
            .map((key) => {
              const role = key.slice("roles.".length);
              const from = modelSelectorField(configForRole(prevLive, role)).model ?? null;
              const to = modelSelectorField(configForRole(nextConfig, role)).model ?? null;
              return { role, from, to };
            })
            .filter((d) => d.from !== d.to);
          if (fromModel !== toModel || roleDiffs.length > 0)
            emit({
              source: TUMWATER_SOURCE,
              type: "model_changed",
              from: fromModel,
              to: toModel,
              ...(roleDiffs.length > 0 ? { roles: roleDiffs } : {}),
            });
        }
        // A live edit that routes a seam to a backend the previous config did not use: the
        // team keeps running, but that backend must be verified and (for claude) its account
        // seeded, exactly as startup would — so a claude reviewer added to a pi team does not
        // start uncheckable. A missing binary is a warning event, never a crash; a present one
        // logs its verdict as a backend_binary event. The seed is attempted once per root.
        const prevBackends = new Set(seamsInUse(prevLive).map((s) => s.agent ?? "pi"));
        for (const backend of new Set(seamsInUse(reloaded.config).map((s) => s.agent ?? "pi"))) {
          if (prevBackends.has(backend)) continue;
          const resolved = resolveBackendBin(reloaded.config, backend);
          if (findBackendBinary(resolved)) {
            emit({ source: TUMWATER_SOURCE, type: "backend_binary", agent: backend, found: true });
          } else {
            warn(`newly routed ${backend} backend: ${backendMissingMessage(resolved, backend)}`);
          }
          if (backend === "claude" && !liveClaudeSeedAttempted.has(deps.root)) {
            liveClaudeSeedAttempted.add(deps.root);
            seedClaudeAccount(deps.root, reloaded.config);
          }
        }
        prevLive = reloaded.config;
        for (const r of deps.runners) r.config = reloaded.config;
        // Live-resize the concurrency cap: a mid-run edit changes how many pi runs execute
        // concurrently within this poll — no restart. Growing admits already-queued runs;
        // shrinking never preempts in-flight work, it only caps future grants.
        const newMaxConcurrent = Math.max(1, reloaded.config.maxConcurrent);
        if (newMaxConcurrent !== lastMaxConcurrent) {
          deps.semaphore.setCapacity(newMaxConcurrent);
          emit({ source: TUMWATER_SOURCE, type: "max_concurrent_changed", from: lastMaxConcurrent, to: newMaxConcurrent });
          lastMaxConcurrent = newMaxConcurrent;
        }
        // Live-resize the per-provider caps (plans/provider-concurrency.md §7): an edit
        // re-applies the whole map to the pool, and each changed provider fires its own
        // `provider_concurrency_changed` event. setKeyCaps never preempts — shrinking only
        // withholds future grants on that key until releases drain it under the new cap.
        const nextKeyCaps = reloaded.config.maxConcurrentPerProvider ?? {};
        deps.semaphore.setKeyCaps(nextKeyCaps);
        for (const provider of new Set([...Object.keys(lastKeyCaps), ...Object.keys(nextKeyCaps)])) {
          const from = lastKeyCaps[provider];
          const to = nextKeyCaps[provider];
          if (from !== to) {
            emit({
              source: TUMWATER_SOURCE,
              type: "provider_concurrency_changed",
              provider,
              from: from ?? 0,
              to: to ?? 0,
            });
          }
        }
        lastKeyCaps = nextKeyCaps;
        const nowEnabled = runnerIds(reloaded.config);
        // Enabling a role — or raising `roles.<id>.instances` — mid-run starts it: create the
        // runner for each newly present role id (its persisted state survives). A lowered
        // instance count keeps its runner; `runnerEnabled` skips its future runs. A scoped round
        // skips every other id: the enabling is logged (the warn loop below), but its runner
        // waits for the next unscoped round.
        for (const role of nowEnabled) {
          if (deps.roleFilter !== undefined && !deps.roleFilter.includes(role)) continue;
          if (!deps.runners.some((r) => r.role === role))
            deps.runners.push(new RoleRunner(deps.root, role, reloaded.config, deps.mainBranch, deps.runnerSignal));
        }
        for (const role of prevEnabled)
          if (!nowEnabled.includes(role))
            warn(`role ${role} disabled — no new runs`);
        for (const role of nowEnabled)
          if (!prevEnabled.has(role))
            warn(`role ${role} enabled — starting runs`);
        prevEnabled = new Set(nowEnabled);
        lastConfigError = null;
      } else if (reloaded.error && reloaded.error !== lastConfigError) {
        warn(`tumwater.json invalid — keeping current config: ${reloaded.error}`);
        lastConfigError = reloaded.error;
      }
      return live;
    },
  };
}
