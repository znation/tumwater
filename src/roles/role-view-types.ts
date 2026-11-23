/** The role view's contract module: the one payload shape `tumwater role <id>` reports,
 * which the collector in role-view.ts fills and role-render.ts's Markdown renderer, the
 * `--json` document and the dashboard role drawer all consume (one shape, two surfaces).
 * Split out of role-view.ts the way
 * `status-types.ts` sits beside `src/status/status-data.ts` (and
 * `src/report/report-types.ts` beside `report-data.ts`), so the presentation layer depends
 * on the contract without importing the collection code. Pure
 * types: no logic, no module-level state. */
import type { FallbackModelConfig, ModelTier } from "../config/config-schema.js";
import type { ClaudeBilling } from "../agent/claude/claude-account.js";
import type { CoverageRow } from "../observer/qa-coverage.js";
import type { FilingRow } from "../observer/feedback-filings.js";
import type { ChainTierInfo } from "../team/team-orchestrator-info-types.js";

export interface RoleViewPayload {
  /** The role's id as the caller named it. */
  id: string;
  /** The catalog title, or "user-defined role" for a customRoles entry. */
  title: string;
  /** True when the id resolves through config.customRoles, not the built-in catalog. */
  custom: boolean;
  /** Whether the role is enabled in tumwater.json (a disabled role never runs). */
  enabled: boolean;
  /** Whether a per-role pause marker currently holds the role. */
  paused: boolean;
  /** Scheduling tier (roleTier): 0 work, 1 maintenance/observer — how fairOrder slots it. */
  tier: number;
  /** The model seam tier (roleSeamTier) this role's pi runs resolve at: a tier-name
   * `roles.<id>.model` names it directly, else the model catalog's assignment. Always
   * present — the operator can see which tier a role rides even when no tier map is
   * declared and every role rides `default`. */
  modelTier: ModelTier;
  /** The resolved model wiring (configForRole): role overrides applied over top-level. */
  provider?: string;
  model?: string;
  thinking?: string;
  /** The backend this seam routes to (configForRole's `agent`, plans/agent-backends.md):
   * `pi` unless a selector's provider names another agent or the top-level `agent` does.
   * Drives the renderer's `<agent> default` label and the agent-qualified selector string. */
  backend: string;
  /** pi's own saved default model (readPiDefaultModel) as a formatted selector, present only
   * for a pi seam that resolves neither a provider nor a model — the name the role runs when
   * tumwater.json names none. The effective `thinking` wins over the default's, matching
   * status-data.ts's snapshot. Absent for every other seam, so the JSON shape is unchanged. */
  piDefault?: string;
  /** The budget gate's fallback pair, or null when none is configured. */
  fallback: FallbackModelConfig | null;
  /** Whether that fallback is actually free in pi's definitions — what makes the gate
   * willing to engage it. Meaningful only when `fallback` is non-null. */
  fallbackFree: boolean;
  /** The subscription backend whose billing this answer reads (the role's own non-pi seam,
   * else the review gate's non-pi backend — today's claude precedence generalized, so a
   * codex role or a pi author on a codex reviewer names codex here): `"claude"`, `"codex"`, …
   * — the id the renderer labels a window with. Absent for a pi seam with no non-pi reviewer,
   * so old payloads stay byte-identical (plans/codex-backend.md "Groundwork", part 3c/9). */
  billingBackend?: string;
  /** The billing of the backend in play (plans/agent-backends.md §7/§8, PLANS.md part
   * 6d/7): "subscription" or "api" from the account file, absent for a pi seam or when no
   * account read exists. */
  billing?: ClaudeBilling;
  /** The primary subscription window's type (`five_hour`), present only for a subscription
   * reading that reported a window — the renderer's "(Codex 5h window)". */
  billingWindow?: string;
  /** Whether the role's own model reads images (plans/image-input.md "Surfaces", part 5/5):
   * true / false / null (unknown), always present so the role page and the status rows share
   * one capability answer. */
  imageInput: boolean | null;
  /** The role's image reroute target as `<tier> (<model>)`, or null when no other tier reads
   * images — the role page's `Images: no — reruns on …` line. */
  imageReroute: string | null;
  /** The resolved primary seam's declared context window in tokens, or null when it cannot
   * be known (a non-pi seam, an unresolvable provider/model pair, or a model pi's
   * definitions declare no window). The seam `- Next run:` previews, not the fallback. */
  contextWindow: number | null;
  /** Where the running orchestrator has this role's tier moved on its fallback chain (its
   * `chain` block), or null when no orchestrator is alive or the tier is on its primary. */
  chainStep: ChainTierInfo | null;
  /** The effective min-run interval: the role's override or the global value. */
  minRunIntervalSeconds: number;
  /** The role's own min-run-interval override (roles.<base>.minRunIntervalSeconds), present
   * only when set — so a payload without one renders the team default and every existing
   * `role --json` golden stays byte-identical. */
  minRunIntervalOverride?: number;
  /** The role's own raw provider override (the FILE's roles.<base>.provider), present only
   * when the file sets it — distinct from the resolved `provider` field, which merges the
   * top-level value. Read through the base role, so an instance id shows the override its
   * runs carry. Absent when unset, so a payload without one stays byte-identical. */
  providerOverride?: string;
  /** The role's own raw model override (roles.<base>.model), present only when set. */
  modelOverride?: string;
  /** The role's own raw thinking override (roles.<base>.thinking), present only when set. */
  thinkingOverride?: string;
  /** The role's own raw backend override (roles.<base>.backend), present only when the file
   * sets it — distinct from the resolved `backend` field, which reflects selectors and the
   * top-level agent. Read through the base role, so an instance id shows the override its
   * runs carry. Absent when unset, so a payload without one stays byte-identical. */
  backendOverride?: string;
  /** The configured parallel-runner count (roles.<base>.instances), present only when set —
   * so a payload without one stays byte-identical to before. Resolved through the base role
   * like the min-run-interval override, so an instance id shows the count its runs carry. */
  instances?: number;
  /** The roles.<id>.instructions override verbatim, or null when unset. */
  instructions: string | null;
  /** The role's own find-something-to-do text verbatim (a custom role's `task`), or null
   * for the director — it has no find text; its queued prompts ARE its work. */
  find: string | null;
  /** The role's notes: the note its own earlier runs wrote, or
   * null when there is none (missing, empty, or unreadable). Always null for the director. */
  notes: string | null;
  /** The role's lessons, rendered one line each (`- L<n> (date): text`), or null when there
   * are none (missing, empty, or unreadable). Always null for the director, which has no
   * lessons (its work is the operator's prompt). Read whole for display, like the note; a
   * corrupted file degrades to null rather than failing the inspection. */
  lessons: string | null;
  /** The epoch-ms instant the note file was last modified (`fs.statSync(...).mtimeMs`) — the
   * operator twin of the `<role-notes>` prompt block's `last saved <day>` age, so the role
   * view can name how stale a note is. Null exactly when `notes` is null (a missing, empty
   * or unreadable note is still "no note yet"). Always null for the director, which has no
   * note. The stat shares the one note path with the read; no second file read. */
  noteSavedAt: number | null;
  /** Prompts currently queued for this role (the director's count includes the shared
   * inbox, which IS its queue). */
  inboxCount: number;
  /** The next run's assembled prompt, verbatim, through the preview seam — or null when
   * the role has nothing to run (a director with an empty inbox). */
  nextPrompt: string | null;
  /** The role's persisted schedule (runner-state.ts): the epoch-ms instant before which it
   * must not run again and the backoff in seconds it is currently serving (0 when not
   * backing off) — the same two fields the status `next run` cell reads. `nextRunAt` is 0
   * for a role that has never been scheduled; `backoffSeconds` is 0 unless a wake-clearing
   * backoff is in force. */
  nextRunAt: number;
  backoffSeconds: number;
  /** The quiet-hours windows that govern this role, the role's own (`quietHoursPerRole`, looked
   * up by base role as the gate does) first and the team-wide `quietHours` second, each with
   * whether the local clock sits inside it now. Absent when no window parses and for the
   * director, which both gates exempt. */
  quietHours?: Array<{ scope: "role" | "fleet"; window: string; inWindow: boolean }>;
  /** The yield multiplier the role's recent-yield ring earns right now — the same
   * `×N` the status `next run` cell rides (status-render.ts's nextRunCell reads
   * yieldMultiplierFor) — so the role view's Schedule cannot understate a quiet
   * yield-scaled role's effective gap. 1 for every role outside the scalable set and
   * for a scalable role whose recent ring still holds a merge. */
  yieldMultiplier: number;
  /** When the role's last run ended, epoch ms — absent for a never-run role, so the
   * JSON shape stays unchanged until the role has acted. */
  lastRunEndedAt?: number;
  /** The role's recent run outcomes — the newest up to 8 `run_end` results read from the
   * event log, ordered newest-first, each with its time, result, duration, and summary.
   * Absent when the role has no `run_end` events, so the JSON shape is unchanged for a
   * never-run role. Read straight from the event log so the command runs with the team
   * stopped and never touches the live state. */
  recentOutcomes?: Array<{ ts: number; result: string; durationMs?: number; summary?: string }>;
  /** The `qa` observer's flow-coverage ledger (plans/observer-roles.md 2/2), surfaced to its
   * one reader: each flow's last exercise and result in the prompt block's order
   * (never-exercised first, then stalest-first) via observer/qa-coverage.ts's `coverageRows`.
   * Present only for the canonical `qa` id, so every other role's `--json` payload and
   * Markdown render stay byte-identical. The ledger read degrades to empty coverage on a
   * missing or torn file exactly as `readQaCoverage` already does. */
  flowCoverage?: CoverageRow[];
  /** The `feedback` observer's per-install filing ledger (plans/feedback-role.md 2/2), surfaced
   * to its one reader: each GitHub issue this install already filed, newest-first (via
   * observer/feedback-filings.ts's `filingRows`), so the operator sees what the role filed,
   * when, and under what title — the twin of `qa`'s `flowCoverage` above. Present only for the
   * canonical `feedback` id, so every other role's `--json` payload and Markdown render stay
   * byte-identical. The ledger read degrades to an empty list on a missing or torn file
   * exactly as `readFeedbackFilings` already does. */
  filings?: FilingRow[];
  /** The role's own spend over its retained event window — tokens, real cost, and notional
   * (subscription) cost summed from the same `run_end` events `recentOutcomes` reads, each
   * folded through the shared `eventUsage` finiteness guard so a torn field contributes 0.
   * The sum's window is the single `readEvents` call `recentOutcomes` already makes, so the
   * two per-role facts cannot drift on what they cover. Absent when all three are 0 (the
   * report's zero-means-absent convention), so a never-costly role's JSON is unchanged. */
  usage?: { tokens: number; costUsd: number; notionalCostUsd: number };
  /** The role's `maxDailyCostUsdPerRole` cap and today's spend against it, from the same
   * `roleCapVerdicts` the scheduler's gate and the status `capPaused` observer fold: `over` is
   * whether the role is held until local midnight, `spentUsd` the base role's instances' summed
   * spend today, `roleIds` the instances sharing the cap. Absent when no cap above 0 applies
   * (and for the director), so a team without per-role caps keeps its JSON shape. */
  dailyCap?: { capUsd: number; spentUsd: number; over: boolean; roleIds: string[] };
  /** The role's own cap's `projectCapHit({ spentUsd, capUsd }, now)` forecast instant — when
   * today's burn reaches the cap, the per-role twin of the team budget badge's `~cap at HH:MM`.
   * Present only while a forecast stands (under the cap and burning), so a capped-but-over,
   * zero-spend, or no-cap payload keeps its current JSON shape. */
  dailyCapHitAt?: number;
}
