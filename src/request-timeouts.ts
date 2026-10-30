/** The bounded one-reply follow-up turns — and the author's SUMMARY and stage-fix requests
 * (runner-pi.ts) — share one cap idiom: keep the configured budgets but clamp both timeouts
 * to the follow-up's own tighter caps, and force the quiet cap when the config has no quiet
 * timeout (0 means "unset" there). Two call sites, one per side, each passing its own cap
 * constants. */
import type { TumwaterConfig } from "./config/config-schema.js";

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
