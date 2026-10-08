/** The bounded one-reply follow-up turns — the reviewer's missing-VERDICT turn and the
 * suite-rerun nudge (review-followup.ts's runFollowupTurn, behind requestVerdict and
 * requestNoRerun) and the author's SUMMARY and stage-fix requests (loop-pi.ts) — share one cap
 * idiom: keep the configured budgets but clamp both timeouts to the follow-up's own tighter
 * caps, and force the quiet cap when the config has no quiet timeout (0 means "unset" there).
 * Two call sites, one per side, each passing its own cap constants. */
import type { TumwaterConfig } from "./config/config-schema.js";

export function cappedRequestTimeouts(
  cfg: TumwaterConfig,
  tickCapS: number,
  quietCapS: number,
): Pick<TumwaterConfig, "tickTimeoutSeconds" | "quietTimeoutSeconds"> {
  return {
    tickTimeoutSeconds: Math.min(cfg.tickTimeoutSeconds, tickCapS),
    quietTimeoutSeconds:
      cfg.quietTimeoutSeconds > 0 ? Math.min(cfg.quietTimeoutSeconds, quietCapS) : quietCapS,
  };
}
