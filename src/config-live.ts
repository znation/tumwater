import type { TumwaterConfig } from "./config-schema.js";
import { changedConfigKeys, enabledRoleIds, loadConfigCached } from "./config.js";
import { logEvent, warnEvent } from "./events.js";
import { LoopRunner } from "./loop.js";
import { configPath } from "./paths.js";
import type { Semaphore } from "./semaphore.js";

/** The orchestrator's live view of tumwater.json: the single reload point shared by all loops,
 * polled once per poll (src/orchestrator.ts). A broken file keeps the last-known-good config and
 * warns once per distinct error text; an unchanged file is served from a stat-keyed cache (one
 * stat per poll, no read). Owns all the edge-triggered bookkeeping so each crossing logs exactly
 * one event instead of once per poll: missing/reappeared, config_changed's changed keys, live
 * role enable/disable (creating a runner for each newly enabled role), and the semaphore's
 * live-resized concurrency cap. */
interface LiveConfigReload {
  /** Poll the config file once, applying any reload and its side effects; returns the live
   * config — the last successful reload's (last-known-good while the file is broken or missing). */
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
  signal: AbortSignal;
  /** The orchestrator's runner list, mutated in place: a role enabled mid-run gets a runner
   * appended here (its persisted state survives). */
  runners: LoopRunner[];
  /** The shared concurrency cap, live-resized when maxConcurrent changes. */
  semaphore: Semaphore;
  /** A scoped once round's role filter (`run --once --role <id>`): a mid-round config edit
   * that enables another role still logs its `role enabled` warning, but no runner is created
   * for it — the round must not silently widen past the role it was scoped to. Undefined in
   * daemon and unscoped-once runs, which create a runner for every newly enabled role. */
  roleFilter?: string;
}): LiveConfigReload {
  // The last config error already warned about (a broken file must warn once per distinct text,
  // not every poll), whether the file is currently missing (one warning per vanish, one line
  // when it reappears), and the previous cycle's enabled set (for one-shot enable/disable
  // transition warnings).
  let lastConfigError: string | null = null;
  let configMissing = false;
  let prevEnabled = new Set(enabledRoleIds(deps.config));
  let live = deps.config;
  // The previous successful reload's config, for the one-shot config_changed event. Seeded from
  // the startup config, so the first poll of an unchanged file logs nothing.
  let prevLive = deps.config;
  // The cap last applied to the semaphore (live-resized on each reload), so a change logs
  // exactly one event per distinct value — not once per poll.
  let lastMaxConcurrent = Math.max(1, deps.config.maxConcurrent);

  return {
    poll() {
      const reloaded = loadConfigCached(deps.root);
      // A missing file keeps the last-known-good config too, and never reloads as defaults: the
      // fleet was started on a real file (startup refuses to run without one), so its vanishing
      // mid-run is an incident — a landing's fast-forward deleted it on 2026-09-22 and the fleet
      // silently ran 8.6 h on defaults (BUGS.md 2026-09-23). One warning per vanish, not per
      // poll; its return logs one line, then the normal reload below diffs it against the
      // retained config — so config_changed names only what the returned file really changed.
      if (reloaded.missing) {
        if (!configMissing) {
          warnEvent(deps.root, "harness", `tumwater.json missing — keeping current config until it returns (${configPath(deps.root)})`);
          configMissing = true;
          lastConfigError = null; // Whatever state it returns in is stated afresh.
        }
      } else if (configMissing) {
        warnEvent(deps.root, "harness", "tumwater.json reappeared — reloading it");
        configMissing = false;
      }
      if (reloaded.config) {
        live = reloaded.config;
        // A live edit that changes behavior elsewhere logs one event naming the settings that
        // changed (maxConcurrent and sessionRetentionDays have their own events elsewhere).
        const changedKeys = changedConfigKeys(prevLive, reloaded.config);
        if (changedKeys.length > 0)
          logEvent(deps.root, { loop: "harness", type: "config_changed", keys: changedKeys });
        prevLive = reloaded.config;
        for (const r of deps.runners) r.config = reloaded.config;
        // Live-resize the concurrency cap: a mid-run edit changes how many pi runs execute
        // concurrently within this poll — no restart. Growing admits already-queued ticks;
        // shrinking never preempts in-flight work, it only caps future grants.
        const newMaxConcurrent = Math.max(1, reloaded.config.maxConcurrent);
        if (newMaxConcurrent !== lastMaxConcurrent) {
          deps.semaphore.setCapacity(newMaxConcurrent);
          logEvent(deps.root, { loop: "harness", type: "max_concurrent_changed", from: lastMaxConcurrent, to: newMaxConcurrent });
          lastMaxConcurrent = newMaxConcurrent;
        }
        const nowEnabled = enabledRoleIds(reloaded.config);
        // Enabling a role mid-run starts it: create its runner (its persisted state survives).
        // A scoped round skips every other role: the enabling is logged (the warn loop below),
        // but its runner waits for the next unscoped round.
        for (const role of nowEnabled) {
          if (deps.roleFilter !== undefined && role !== deps.roleFilter) continue;
          if (!deps.runners.some((r) => r.role === role))
            deps.runners.push(new LoopRunner(deps.root, role, reloaded.config, deps.mainBranch, deps.signal));
        }
        for (const role of prevEnabled)
          if (!nowEnabled.includes(role))
            warnEvent(deps.root, "harness", `role ${role} disabled — stopping ticks`);
        for (const role of nowEnabled)
          if (!prevEnabled.has(role))
            warnEvent(deps.root, "harness", `role ${role} enabled — starting ticks`);
        prevEnabled = new Set(nowEnabled);
        lastConfigError = null;
      } else if (reloaded.error && reloaded.error !== lastConfigError) {
        warnEvent(deps.root, "harness", `tumwater.json invalid — keeping current config: ${reloaded.error}`);
        lastConfigError = reloaded.error;
      }
      return live;
    },
  };
}
