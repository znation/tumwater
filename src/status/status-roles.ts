import path from "node:path";
import type { LoopState } from "../loop/loop-state.js";
import type { readSlotsState } from "../git/slots-state.js";
import type { ModelTier, TumwaterConfig } from "../config/config-schema.js";
import {
  configForRole,
  modelFallbackView,
  modelSelectorField,
  roleSeamTier,
  type ModelFallbackView,
} from "../config/config-views.js";
import { isCustomRole } from "../config/config.js";
import { baseRoleOf, loopIds } from "../roles/loop-ids.js";
import { formatModelSelector } from "../config/model-selector.js";
import { piSettingsPath, readPiDefaultModel } from "../pi/pi-settings.js";
import { isJsonObject } from "../files/json-object.js";
import { loopStateForPoll } from "./status-polls.js";

/** One status-table row: the persisted loop state plus the display-only fields the dashboard
 * computes at the source (`custom`, the resolved selector, the active fallback, the pooled
 * slot, the base-role instance). The structural mirror of `StatusSnapshot["loops"]`, kept
 * here so the roles collector owns its row type; status-data.ts composes the array into the
 * snapshot and TypeScript checks the two shapes agree. */
export type StatusLoopRow = LoopState & {
  custom: boolean;
  modelTier?: ModelTier;
  model?: string;
  modelFromPi?: true;
  fallback?: ModelFallbackView;
  slot?: string;
  slotPinned?: boolean;
  instanceOf?: string;
};

/** One row per enabled loop id (part 5b/7). `configForRole`, `modelFallbackView`, the leased /
 * pinned slot and the pi-default seam all resolve against the values `snapshot()` already
 * read once for the poll — the info and slots pins (threaded as `slots`) keep rows, `running`
 * and `disk` on the same shared reads, and `now` is the snapshot's pinned clock so every row
 * agrees on what "active" means. One read of pi's own saved default per poll (docs/backends.md)
 * serves the rows whose seam runs pi and resolves no model — its settings.json sits beside the
 * models catalog this snapshot reads (piSettingsPath), so one seam serves both. */
export function collectRoleRows(
  root: string,
  cfg: TumwaterConfig,
  now: number,
  slots: ReturnType<typeof readSlotsState>["slots"],
  modelsPath: string,
): StatusLoopRow[] {
  const roles = loopIds(cfg);
  const piDefault = readPiDefaultModel(piSettingsPath(modelsPath), root);
  return roles.map((r) => {
    const base = { ...loopStateForPoll(root, r), custom: isCustomRole(cfg, r) };
    const leased = slots.find((slot) => slot.lease?.role === r);
    const pinned = slots.find((slot) => slot.pinnedFor === r);
    const slot = leased ?? pinned;
    // Every row carries the selector its config resolves to, so the dashboards show which
    // model a role rides even with a single string `model`. A tier-name `roles.<id>.model`
    // and a role selector override both resolve through configForRole — the same view the
    // seam consumes. Part 7a (model-tiers.md "Observability"): the seam tier tag is added
    // only with a tier map declared, where it names the tier a role rides.
    const eff = configForRole(cfg, r);
    // Model failure fallback, part 2/2: while the role's episode is active its ticks run on
    // the tier-resolved fallback pair, so the row names that pair, the episode's start, and
    // the failure that tripped it. `now` is the poll's own clock (the snapshot seam), so
    // every row agrees on what "active" means.
    const episode = modelFallbackView(base.modelFallback, cfg, r, now);
    // A seam that runs pi and resolves neither a provider nor a model starts on pi's own
    // saved default — name it in the row (modelFromPi) so the operator sees which model the
    // loop runs. The config's `thinking` wins over the default's because tumwater passes it
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
      ...(modelFromPi
        ? {
            model: formatModelSelector({
              ...piDefault!,
              thinking: eff.thinking ?? piDefault!.thinking,
            }),
            modelFromPi: true as const,
          }
        : {}),
      ...(isJsonObject(cfg.model) ? { modelTier: roleSeamTier(cfg, r) } : {}),
      ...(episode !== null ? { fallback: episode } : {}),
      ...(slot ? { slot: path.basename(slot.dir), slotPinned: pinned !== undefined } : {}),
      ...(baseRoleOf(r) === r ? {} : { instanceOf: baseRoleOf(r) }),
    };
  });
}
