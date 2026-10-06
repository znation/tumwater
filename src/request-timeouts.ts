/** The bounded one-reply follow-up turns (the reviewer's two VERDICT turns in
 * review-followup.ts and the author's SUMMARY request in loop-pi.ts) share one cap idiom:
 * keep the configured budgets but clamp both timeouts to the follow-up's own tighter caps,
 * and force the quiet cap when the config has no quiet timeout (0 means "unset" there).
 * Three call sites, all passing their own cap constants. */
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