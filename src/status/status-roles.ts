import path from "node:path";
import type { RunnerState } from "../runner/runner-state.js";
import type { readSlotsState } from "../git/slots-state.js";
import type { ModelTier, TumwaterConfig } from "../config/config-schema.js";
import {
  configForRole,
  modelSelectorField,
  roleSeamTier,
} from "../config/config-views.js";
import { isCustomRole } from "../config/config.js";
import { baseRoleOf, configuredInstances, instanceIndex, runnerIds, runnerPaused } from "../roles/runner-ids.js";
import { errorStreakAtWarn, QUIET_KILL_RESUME_LIMIT } from "../run/run-apply.js";
import { queuedMergeRoles } from "../merge/merge-queue.js";
import { hasOutstandingWork } from "../runner/runner-state.js";
import { formatModelSelector } from "../config/model-selector.js";
import { piSettingsPath, readPiDefaultModel } from "../pi/pi-settings.js";
import { isJsonObject } from "../files/json-object.js";
import { runnerStateForPoll } from "./status-polls.js";
import { roleImageInfo } from "../agent/image-input.js";
import { backendDefaultLabel } from "../agent/backend-traits.js";
import { readPiListedModels } from "../pi/pi-listed-models.js";
import { seamContextWindowForRole } from "../pi/pi-models.js";

/** One status-table row: the persisted runner state plus the display-only fields the dashboard
 * computes at the source (`custom`, the resolved selector, the active fallback, the pooled
 * slot, the base-role instance). The structural mirror of `StatusSnapshot["roles"]`, kept
 * here so the roles collector owns its row type; status-data.ts composes the array into the
 * snapshot and TypeScript checks the two shapes agree. */
export type StatusRoleRow = RunnerState & {
  custom: boolean;
  modelTier?: ModelTier;
  model?: string;
  modelFromPi?: true;
  slot?: string;
  slotPinned?: boolean;
  instanceOf?: string;
  /** The role's image-input capability (plans/image-input.md "Surfaces", part 5/5): `true`
   * when its own model reads images, `false` when it is text-only, null when the team cannot
   * tell. Always present, so `status --json` and the dashboards answer without running
   * doctor. */
  imageInput: boolean | null;
  /** The resolved primary seam's declared context window, from the same `seamContextWindow`
   * the role page's `- Context window:` line prints — a table/drawer peak-ctx share divides a
   * run's peak against this. Present only when the seam declares a window (the omit-when-unknown
   * the `modelFromPi` convention uses), so a row without a window is byte-identical. */
  contextWindow?: number;
};

/** One row per enabled role id (part 5b/7). `configForRole`, the leased /
 * pinned slot and the pi-default seam all resolve against the values `snapshot()` already
 * read once for the poll — the info and slots pins (threaded as `slots`) keep rows, `running`
 * and `disk` on the same shared reads. One read of pi's own saved default per poll
 * (docs/backends.md) serves the rows whose seam runs pi and resolves no model — its
 * settings.json sits beside the models catalog this snapshot reads (piSettingsPath), so one
 * seam serves both. */
export function collectRoleRows(
  root: string,
  cfg: TumwaterConfig,
  slots: ReturnType<typeof readSlotsState>["slots"],
  modelsPath: string,
  paused: ReadonlySet<string>,
): StatusRoleRow[] {
  // A surplus runner (index above `instances`, from the runner pool of plans/fast-merge.md
  // "Lever 1") with nothing to show gets no row, so the table does not list idle extras.
  // The exceptions are exactly the surplus runners an operator most needs to see and resume
  // from the dashboard: one the pause marker stops (`runnerPaused`), one on an error streak
  // at the warning threshold, and one on a quiet-kill streak at the give-up threshold. The
  // last two mirror onErrorStreak (status-model.ts), the exact condition the red "failing
  // run after run" alert keys on, so a surplus runner the alert would report is never
  // hidden. Without these rows the role is invisible and unresumable (BUGS.md 2026-10-23),
  // and the alerts — which read the rows — cannot name it.
  const queued = queuedMergeRoles(root);
  const roles = runnerIds(cfg).filter((r) => {
    if (instanceIndex(r) <= configuredInstances(cfg, r)) return true;
    const s = runnerStateForPoll(root, r);
    if (runnerPaused(paused, r)) return true;
    return (
      s.running ||
      queued.has(r) ||
      s.claim !== undefined ||
      hasOutstandingWork(s) ||
      errorStreakAtWarn(s) ||
      (s.lastResult === "quiet_killed" && (s.quietKillStreak ?? 0) >= QUIET_KILL_RESUME_LIMIT)
    );
  });
  const piDefault = readPiDefaultModel(piSettingsPath(modelsPath), root);
  const listed = readPiListedModels(root);
  return roles.map((r) => {
    const base = { ...runnerStateForPoll(root, r), custom: isCustomRole(cfg, r) };
    const leased = slots.find((slot) => slot.lease?.role === r);
    const pinned = slots.find((slot) => slot.pinnedFor === r);
    const slot = leased ?? pinned;
    // Every row carries the selector its config resolves to, so the dashboards show which
    // model a role rides even with a single string `model`. A tier-name `roles.<id>.model`
    // and a role selector override both resolve through configForRole — the same view the
    // seam consumes. Part 7a (model-tiers.md "Observability"): the seam tier tag is added
    // only with a tier map declared, where it names the tier a role rides.
    const eff = configForRole(cfg, r);
    // The image-input surface (plans/image-input.md "Surfaces", part 5/5): the role's own
    // capability, one shared resolver so the status rows, the role page, and the submit gate
    // cannot disagree about who reads images.
    const image = roleImageInfo(cfg, r, modelsPath, listed);
    // The peak-ctx share denominator (the role's context window, part 3c): resolved once per
    // poll here, beside `eff` (the same seam the role page resolves and names) — the same seam
    // `seamContextWindow` run against, so row, page and drawer cannot disagree.
    const contextWindow = seamContextWindowForRole(cfg, r, root, modelsPath);
    // A seam that runs pi and resolves neither a provider nor a model starts on pi's own
    // saved default — name it in the row (modelFromPi) so the operator sees which model the
    // role runs. The config's `thinking` wins over the default's because tumwater passes it
    // to pi as `--thinking` (src/pi/pi-args.ts). Any other row is unchanged and carries no
    // `modelFromPi`.
    const runsPiWithoutAModel =
      (eff.agent === undefined || eff.agent === "pi") &&
      eff.provider === undefined &&
      eff.model === undefined;
    const modelFromPi = runsPiWithoutAModel && piDefault !== null;
    return {
      ...base,
      ...modelSelectorField(eff),
      imageInput: image.imageInput,
      ...(modelFromPi
        ? {
            model: formatModelSelector({
              ...piDefault,
              thinking: eff.thinking ?? piDefault.thinking,
            }),
            modelFromPi: true as const,
          }
        : {}),
      // A seam that resolves neither a provider nor a model (an opencode role with no
      // `model`, or a pi role when pi's own settings hold no readable default) names its
      // backend's own default — the same label `tumwater role <id>`'s Model line prints, so
      // the two surfaces cannot disagree (docs/invariants.md "Cross-surface agreement").
      // `eff.agent` is always set (`withModelOverrides` defaults it to `"pi"`); a claude or
      // codex seam already carries routeModel's tier default in `eff.model`, and the
      // `modelFromPi` branch above still wins when pi's default is readable.
      ...(modelFromPi || eff.provider !== undefined || eff.model !== undefined
        ? {}
        : { model: backendDefaultLabel(eff.agent) }),
      ...(isJsonObject(cfg.model) ? { modelTier: roleSeamTier(cfg, r) } : {}),
      ...(contextWindow !== null ? { contextWindow } : {}),
      ...(slot ? { slot: path.basename(slot.dir), slotPinned: pinned !== undefined } : {}),
      ...(baseRoleOf(r) === r ? {} : { instanceOf: baseRoleOf(r) }),
    };
  });
}

