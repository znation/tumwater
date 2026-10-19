// vocabulary: plain
import path from "node:path";
import type { LoopState } from "../runner/runner-state.js";
import type { readSlotsState } from "../git/slots-state.js";
import type { ModelTier, TumwaterConfig } from "../config/config-schema.js";
import {
  configForRole,
  modelSelectorField,
  roleSeamTier,
} from "../config/config-views.js";
import { modelFallbackView, type ModelFallbackView } from "../config/config-fallbacks.js";
import { isCustomRole } from "../config/config.js";
import { baseRoleOf, configuredInstances, instanceIndex, loopIds } from "../roles/runner-ids.js";
import { queuedMergeRoles } from "../merge/merge-queue.js";
import { hasOutstandingWork } from "../runner/runner-state.js";
import { formatModelSelector } from "../config/model-selector.js";
import { piSettingsPath, readPiDefaultModel } from "../pi/pi-settings.js";
import { isJsonObject } from "../files/json-object.js";
import { loopStateForPoll } from "./status-polls.js";
import { roleImageInfo, seamImageLabel } from "../agent/image-input.js";
import { imageProbeEntryFresh, readImageProbeCache } from "../doctor/image-probe.js";

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
  /** The loop's image-input capability (plans/image-input.md "Surfaces", part 5/5): `true`
   * when its own model reads images, `false` when it is text-only, null when the team cannot
   * tell. Always present, so `status --json` and the dashboards answer without running
   * doctor. */
  imageInput: boolean | null;
  /** The loop's image reroute target as `<tier> (<model>)`, or null when no other tier reads
   * images — the `reruns on …` every surface names. Always present. (Named `imageRerouteLabel`
   * to avoid the persisted LoopState.imageReroute handoff record of the same name.) */
  imageRerouteLabel: string | null;
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
  // A surplus runner (index above `instances`, from the runner pool of plans/fast-merge.md
  // "Lever 1") with nothing to show gets no row, so the table does not list idle extras.
  const queued = queuedMergeRoles(root);
  const roles = loopIds(cfg).filter((r) => {
    if (instanceIndex(r) <= configuredInstances(cfg, r)) return true;
    const s = loopStateForPoll(root, r);
    return (
      s.running || queued.has(r) || s.claim !== undefined || hasOutstandingWork(s)
    );
  });
  const piDefault = readPiDefaultModel(piSettingsPath(modelsPath), root);
  // One probe-cache read per poll serves every row's image-input surface (same no-data policy
  // as every other degraded read: a missing cache is an empty one).
  const probes = readImageProbeCache(root);
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
    // The image-input surface (plans/image-input.md "Surfaces", part 5/5): the loop's own
    // capability and its reroute target, one shared resolver so the status rows, the role
    // page, and the submit gate cannot disagree about who reads images or where a blind
    // prompt would run.
    const image = roleImageInfo(cfg, r, modelsPath, probes);
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
      imageInput: image.imageInput,
      imageRerouteLabel: image.imageReroute,
      ...(modelFromPi
        ? {
            model: formatModelSelector({
              ...piDefault,
              thinking: eff.thinking ?? piDefault.thinking,
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

/** The doctor's live-probe failures (plans/image-input.md "Surfaces", part 5/5): every cached
 * probe verdict of `fail` that is still fresh (the claim is unchanged and within the 7-day
 * TTL), labelled as `<provider>/<model>`. A claimed model that failed the probe reads `false`
 * everywhere (seamImageInput honors a fresh failure), but the observability value is naming
 * it — a claim the doctor contradicted is exactly what the amber probe alert and the role/status
 * rows should surface, not just "this loop is text-only". A torn or missing cache answers
 * empty (the same no-data policy as the per-loop read). */
export function collectImageProbeFailures(root: string, now: number = Date.now()): string[] {
  const probes = readImageProbeCache(root);
  const out: string[] = [];
  for (const [key, entry] of Object.entries(probes)) {
    if (entry.verdict !== "fail" || !imageProbeEntryFresh(entry, now)) continue;
    // The cache key is agent/provider/model, and a pi model id is itself fully qualified (the
    // key's third segment can carry embedded '/' — parseModelSelector keeps the id whole), so
    // split only the first two separators and keep the rest as the model. A naive split("/")
    // destructured to three parts would truncate a qualified id to its org, mislabelling the
    // model the doctor flagged.
    const first = key.indexOf("/");
    const second = key.indexOf("/", first + 1);
    if (first === -1 || second === -1) continue;
    const agent = key.slice(0, first) || undefined;
    const provider = key.slice(first + 1, second) || undefined;
    const model = key.slice(second + 1) || undefined;
    out.push(seamImageLabel(agent, provider, model));
  }
  return out.sort();
}
