/** The capped-config idiom the two `--continue` follow-up turns share (runner-pi.ts's
 * requestSummary and requestStageFix, both through requestFollowUp): keep the configured
 * budgets but clamp both timeouts to the follow-up's own tighter caps, and force the quiet
 * cap when the config has no quiet timeout (0 means "unset" there). One call site, which
 * passes its own per-turn cap constants. */
import type { TumwaterConfig } from "../config/config-schema.js";

export function cappedRequestTimeouts(
  cfg: TumwaterConfig,
  runCapS: number,
  quietCapS: number,
): Pick<TumwaterConfig, "runTimeoutSeconds" | "quietTimeoutSeconds"> {
  return {
    runTimeoutSeconds: Math.min(cfg.runTimeoutSeconds, runCapS),
    quietTimeoutSeconds:
      cfg.quietTimeoutSeconds > 0 ? Math.min(cfg.quietTimeoutSeconds, quietCapS) : quietCapS,
  };
}
