import type { RunnerState } from "../runner/runner-state.js";
import { readSlotsState } from "../git/slots-state.js";
import type { BuildStatus } from "../build/build-info.js";
import type { CheckPermitSnapshot, OrchestratorInfo, PermitSnapshot, SlotPoolSnapshot } from "../team/orchestrator-info.js";
import { openBugs, openQuestions } from "../backlog/backlog.js";
import { baseRoleOf, roleInScope, runnerIds, runnerPaused } from "../roles/runner-ids.js";
import type { ModelTier } from "../config/config-schema.js";
import type { ModelFallbackView } from "../config/config-fallbacks.js";
import type { ClaudeWindowEntry } from "../agent/claude/claude-account.js";
import type { SubscriptionWindowBlock } from "../agent/subscription-account.js";
import { piModelsPath } from "../pi/pi-models.js";
import { configForStatus, queueInFlight, mainCheckForPoll, maintenanceQuotaForPoll, ciParityForPoll, type CiParityStatus, type MainCheckStatus } from "./status-polls.js";
import { quietHoursStatus, roleQuietHold } from "../scheduling/quiet-hours.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { pausedRoles, pausedRolesUntil, scheduledStopAt, scheduledWakes, standingTeamPause } from "../team/team-state.js";
import {
  orchestratorAlive,
  readOrchestratorInfo,
  type DiskStatus,
} from "../team/orchestrator-info.js";
import type { MergeInFlight } from "../merge/merge-slot.js";
import { bootstrapHoldsRole, bootstrapStatus } from "../gates/bootstrap-gates.js";
import { readMergeQueue } from "../merge/merge-queue.js";
import { collectImageProbeFailures, collectRoleRows } from "./status-roles.js";
import { collectInboxes } from "./status-inbox.js";
import { collectBudget } from "./status-budget.js";
import { collectRootInstallDrift } from "./status-install.js";
import { detectBuildCheck } from "../build/build-check-detect.js";
import { briefBlockMissing, briefBlockOverCap } from "../brief/brief.js";

/** Status data collection: one fresh snapshot of the team for observers (`tumwater
 * status`, TUI, GUI). Rendering lives in status-render.ts; the per-poll cached readers
 * snapshot() reads through (main-check scan, last-known-good config, runner-state stat cache)
 * live in status/status-polls.ts. snapshot() composes the per-domain collectors in
 * status-roles.ts, status-inbox.ts and status-budget.ts and keeps the one-off fields here. */

export interface StatusSnapshot {
  running: boolean;
  pid?: number;
  inbox: number;
  /** Previews of those queued prompts in execution order, each via promptPreview (the shared
   * one-line preview width also used by the event previews) — full text would bloat the GUI
   * payload, and dashboards clip display width themselves. Fresh per poll like `questions`. */
  inboxPrompts: string[];
  /** The director queue's file basenames, same order as inboxPrompts — the address the
   * dashboard's per-row cancel affordance sends (/api/prompt-cancel cancels by queue file,
   * not by list position, so a 1 s-stale poll can never cancel the wrong entry). Same single
   * inbox pass as inboxPrompts (queuedRolePromptEntries), so the two arrays cannot drift. */
  inboxFiles: string[];
  /** The director queue's enqueue stamps (epoch ms parsed from each queue filename by
   * queueFileStamp — null for a hand-placed name), same order as inboxPrompts — the
   * established pairing pattern; the dashboard's Queued tab shows each prompt's age from it.
   * Same single inbox pass as inboxPrompts (queuedRolePromptEntries), so the arrays cannot
   * drift. */
  inboxQueuedAt: Array<number | null>;
  /** The director queue's not-before times (epoch ms parsed from each queue file's
   * `tumwater:not-before` marker line by notBeforeMs — null when absent or malformed), same
   * order as inboxPrompts — the established pairing pattern; the dashboard's Queued tab shows
   * each deferred prompt's delivery countdown from it. Same single inbox pass as inboxPrompts
   * (queuedRolePromptEntries), so the arrays cannot drift. */
  inboxNotBefore: Array<number | null>;
  /** Open questions awaiting a human answer (QUESTIONS.md's ## Open) — the header badge. */
  questions: number;
  /** The doctor's live image-probe failures (plans/image-input.md "Surfaces", part 5/5):
   * every claimed model whose probe failed (fresh verdict), labelled as `<provider>/<model>`.
   * Empty when nothing failed or no probe ran — the amber probe alert keys on this. */
  imageProbeFailures: string[];
  /** One row per enabled role. `custom` marks user-defined roles (tumwater.json's
   * customRoles) for the dashboards' asterisk — display-only metadata computed here at the
   * source, from the same last-known-good config that produced the role list, so a transiently
   * broken tumwater.json keeps marking its customs rather than flipping them unmarked
   * mid-poll. RunnerState itself stays the persisted type; this intersection is view-layer only. */
  roles: Array<RunnerState & {
    custom: boolean;
    /** The selector this role's pi runs resolve at (`provider/id[:thinking]`, the
     * configForRole view) — present whenever a model resolves, both for a single string
     * `model` and under a tier map. When neither a provider nor a model resolves — an
     * opencode role with no `model`, or a pi role whose own saved default is unreadable —
     * `model` instead carries that backend's own-default label (`opencode default` /
     * `pi default`, backendDefaultLabel), the same wording `tumwater role <id>`'s Model line
     * prints (docs/invariants.md INV-A7). The model seam tier (roleSeamTier) is a
     * tier-map-only affordance (model-tiers.md part 7a, "Observability"): it stays absent
     * with a single string model, where every role rides the same pair. Fresh per poll,
     * like `custom`. */
    modelTier?: ModelTier;
    model?: string;
    /** True when this row's `model` names pi's own saved default (read from pi's settings.json
     * beside the models catalog — see src/pi/pi-settings.ts), not a model `tumwater.json`
     * resolved: `tumwater.json` names no model and the seam routes to pi, so the row shows
     * the model pi actually starts on. `model` is set in exactly this case; every other row
     * carries a config-resolved selector or a backend-default label and no `modelFromPi`.
     * A tier-map row never carries either the flag or its default, since a tier map always
     * resolves a model. */
    modelFromPi?: true;
    /** While a model-fallback episode is active (PLANS.md "Model failure fallback"): the
     * tier-resolved fallback pair this role's agent runs use, when the episode began, and the
     * provider-class failure that tripped it. Absent while the episode is not running the
     * fallback (no episode, or a due probe on the primary), so the common row shape is
     * unchanged. */
    fallback?: ModelFallbackView;
    /** The pooled worktree slot this role holds (a live run or verification lease) or is
     * pinned to, named by basename; absent when the role has no slot. `slotPinned` marks a pin
     * (a pending resume waiting on the same checkout) rather than the slot's live lease. */
    slot?: string;
    slotPinned?: boolean;
    /** The base role this row is an instance of (`feature-2` → `feature`), present only on an
     * instance row so a dashboard can group and label parallel work instances
     * (plans/parallel-work-instances.md "Observability", part 6/7). Absent on the bare role. */
    instanceOf?: string;
    /** The role's image-input capability (plans/image-input.md "Surfaces", part 5/5): true
     * when its own model reads images, false when it is text-only, null when the team cannot
     * tell (an unknown pair). Always present, so both observer surfaces answer without running
     * doctor. */
    imageInput: boolean | null;
    /** The role's image reroute target as `<tier> (<model>)`, or null when no other tier reads
     * images — the `reruns on …` the images alert and role page name. Named `imageRerouteLabel`
     * to avoid the persisted RunnerState.imageReroute handoff record. Always present. */
    imageRerouteLabel: string | null;
    /** The resolved primary seam's declared context window (part 3c/…), from the same
     * `seamContextWindow` the role page prints — present only when the seam declares one, so
     * the table/drawer peak-ctx share can divide a run's peak against it. */
    contextWindow?: number;
  }>;
  /** The daily cost budget, unconditionally (cap 0 = disabled — the display decides what to
   * show): today's team spend vs the cap, for the header badge on both dashboards (`· budget:
   * $X/$Y today` while enabled, `· no cap` when disabled) and the editable affordance that
   * needs a badge even on a disabled team. While the orchestrator runs, `spentUsd` is the
   * scheduler's OWN published figure (the gate's poll, over the runners' live in-memory
   * states — BUGS.md 2026-09-30): what an operator sees is what the scheduler enforces. Not
   * running, it is the persisted runner states' sum — a stopped team's files are final. The
   * per-role rows always read their persisted copies, so while runs are in flight the
   * per-role cells can sit under the header/total figure: that difference is exactly the
   * charge the scheduler has already counted. `free` is true when every model the team could
   * use resolves to an unpriced or zero-cost entry in pi's models.json (src/pi/pi-models.ts):
   * spend can never accumulate against a cap that cannot be reached, so both dashboards read
   * `· budget: n/a` instead of a dollar figure. `fallback` is the cost-free model roles
   * switch to once the cap is reached (plans/fallback-model.md) — non-null ONLY when one is
   * configured AND pi's definitions price it at zero, i.e. exactly when the gate would engage
   * it rather than pausing, so the dashboards' three-valued gate matches the scheduler's. */
  budget: {
    spentUsd: number;
    capUsd: number;
    /** When today's linear burn will reach the cap (epoch ms, the badge's `~cap at HH:MM`
     * forecast), or null when no forecast may be stated — no cap, no spend yet, the cap
     * already reached (the gate's own states supersede a forecast), or a burn that misses
     * midnight (budget.ts's projectCapHit, the one home of the rule). Computed once per poll
     * from the same materialized spend `spentUsd` renders, so every observer shows one
     * computed fact rather than three derivations. `status --json` and `/api/status` carry it
     * to scripts through the snapshot's own serialization. */
    capHitAt: number | null;
    free: boolean;
    fallback: { backend?: string; provider?: string; model?: string } | null;
    /** The per-tier fallback labels (part 7b/8): tier → `provider/model[ (from <tier>)]` —
     * non-null ONLY while the cap is reached and the tiers resolve to two or more distinct
     * pairs, the badge's tier-list state; a single fallback (the other tiers borrowing its
     * pair) leaves it undefined so the badge keeps today's single-pair text byte-identical.
     * Optional so literal budget blocks in the tests stand. The labels come from the same
     * resolution (resolveTierFallbacks over the published demotions) the per-role pause set
     * above reads, so the badge and the role rows cannot disagree about which pair a tier
     * runs on. */
    tiers?: Partial<Record<string, string>> | null;
  };
  /** Each tier the budget gate has off its primary and the fallback step it runs on, from the
   * live orchestrator's info file (fallback chain part 7c/7); absent when none moved or the
   * orchestrator is not alive. */
  chain?: OrchestratorInfo["chain"];
  /** The claude.ai subscription usage window (plans/agent-backends.md §8, PLANS.md part 6d/7),
   * derived from the claude entry of `subscriptionWindows`, kept for one release (part 3a/9) so
   * the pre-3b displays keep their shape: present only when a seam routes to claude on
   * subscription billing AND the account reported at least one window reading. `windows` is the
   * full list (most constrained first), `primary` the one the badge shows, `only` the same
   * team-global answer as `subscriptionOnly`, and `heldUntil` the rejected window's future
   * `resetsAt` (epoch ms) the display names in "claude seams held until …", or null when no
   * window holds. A pi-only or API-claude team has no account subscription reading, so the
   * block is absent and every surface renders as before. */
  claudeWindow?: {
    windows: ClaudeWindowEntry[];
    primary: ClaudeWindowEntry;
    only: boolean;
    heldUntil: number | null;
  };
  /** One subscription-window block per subscription backend in use (plans/codex-backend.md
   * "Groundwork: the subscription account is per backend" item 3, part 3a/9), each carrying the
   * backend's own windows most-constrained-first and the `heldUntil` of a rejected hold — the
   * shared model parts 3b/9–3e/9 display. Present only when at least one subscription backend
   * in use reported a window; `subscriptionOnly` is true when every paying seam is a
   * subscription seam (the windows replace the daily-spend badge rather than just joining it).
   * A claude-only team carries exactly this list's claude block, byte-identical to the fields
   * `claudeWindow` still exposes for one release. */
  subscriptionWindows?: SubscriptionWindowBlock[];
  /** True when every paying seam is a subscription seam (see `subscriptionWindows`); the
   * claude spelling `claudeWindow.only` shadows it for one release. */
  subscriptionOnly: boolean;
  /** True while the operator has paused the team (`tumwater pause` marker present): every
   * idle role runner's state cell reads `paused`. Fresh per poll like `questions` — no cache,
   * because a 2-second-stale pause flag would mislead an operator mid-resume. */
  paused: boolean;
  /** The roles the operator has individually paused (`tumwater pause --role <id>` marker
   * set): an idle role in this set also reads `paused`, the same cell as under the team
   * pause. Fresh per poll like `paused` — no cache, for the same mid-resume reason. */
  pausedRoles: string[];
  /** The role ids the scheduler treats as paused by the per-role marker (`runnerPaused`): a role
   * whose own id, base role, or — for instance 1 — `<role>-1` key is in `pausedRoles`. The display
   * surfaces read this, while `pausedRoles` stays the raw marker `resume --role` takes. */
  pausedRunners: string[];
  /** The role ids the per-role daily cost cap holds (`maxDailyCostUsdPerRole`): an idle role
   * in this set reads `cap paused`, its own spend state — more specific than the team's
   * `budget paused`. Computed with the gate's own grouped verdict (roleCapVerdicts): instance
   * role ids share their base role's cap and its SUMMED spend, and the director is exempt,
   * exactly as the scheduler's gate groups and exempts them (role-cap-gates.ts). Uses the caps
   * of the same last-known-good config that produced the role list (a transiently broken
   * tumwater.json degrades with the whole config, like `quietHours`), so the verdict an
   * operator sees is the scheduler's. Always present, empty when none — the `pausedRoles`
   * shape. Fresh per poll, like `pausedRoles`: a live `config set` edit shows on the next
   * poll, and local midnight lifts the hold by itself. */
  capPaused: string[];
  /** The maintenance allowance (plans/work-ratio.md, part 1b/4): the rolling-24 h window's
   * `allowance` and `used` (maintenance merges plus maintenance roles in flight), and the
   * enabled maintenance role ids the scheduler holds while `used >= allowance`. Computed by the
   * same pure verdict the gate folds (maintenance-quota.ts) against this process's own memo of
   * the event log, so an observer shows the hold the scheduler enforces. Always present, empty
   * `held` while the gate is open — the `capPaused` shape with the figures the role cell's
   * `held: maintenance quota <used>/<allowance>` label renders. Fresh per poll, like capPaused. */
  maintenanceQuota: { allowance: number; used: number; held: string[] };
  /** The new-project bootstrap (plans/work-ratio.md, part 2/2) while it is active: its progress
   * against `bootstrap.untilPlansDone`. Absent once the latch is written or the config entry
   * removed, so the surfaces render exactly as before in a normal project. */
  bootstrap?: { plansDone: number; untilPlansDone: number };
  /** The roles the bootstrap gate holds (see `bootstrap`): every role but plan, feature and
   * director — and bugfix while BUGS.md `## Open` is empty. An idle role in this set reads
   * `held: bootstrap`. Always present, empty when bootstrap is inactive — the `capPaused`
   * shape. Recomputed per poll from the gate's own predicate (bootstrap-gates.ts), so the hold
   * an operator sees is the hold the scheduler enforces. */
  bootstrapHeld: string[];
  /** The roles whose budget tier resolved to pause while the cap is reached (part 5c/8): a
   * role whose `model` tier (roleSeamTier) has no usable free pair — none configured, one
   * priced above zero, or its fallback breaker demoted — reads `budget paused`, the same cell
   * the team gate's old team-wide verdict filled. Computed with resolveTierFallbacks over
   * the SAME usable predicate the scheduler's gate folds (price at zero, and not among the
   * running orchestrator's published demotions), against the same last-known-good config as
   * `capPaused`, so the verdict an operator sees is the scheduler's — the per-tier pause set
   * (gate-polls.ts's budgetPausedRoles). The director is exempt, exactly as the gate exempts
   * it. Always present, empty when none — the `capPaused` shape. Fresh per poll, like
   * `capPaused`. */
  budgetPausedRoles: string[];
  /** The roles the per-role quiet-hours window holds (`quietHoursPerRole`): keyed by ROLE
   * id (`feature-2`, so rolePhase's `[s.role]` lookup finds the row) to that role's window
   * string as written (trimmed by quietHoursStatus's parser rule — the schedule as written,
   * not a reformat). The window is looked up by BASE role, exactly as the scheduler's own
   * gate does (gate-polls.ts's roleQuietHeld): config keys are base role ids, so an
   * instance role reads its base's window. An idle role in this map reads the team gate's
   * own quiet wording, scoped to its window — `quiet until <end>`. Computed with
   * roleQuietHold against the same last-known-good config as `capPaused` (a transiently
   * broken tumwater.json degrades with the whole config), the director exempt exactly as
   * the scheduler's gate exempts it. Empty when no per-role window holds anyone — the
   * `capPaused` shape's keyed sibling. Fresh per poll, like `capPaused`: a live `config
   * set quietHoursPerRole` edit shows on the next poll. */
  roleQuietPaused: Record<string, string>;
  /** The team marker's standing deadline (ms epoch) while a timed pause
   * (`tumwater pause --for <duration>`) holds — undefined for an indefinite team pause, a
   * role-only pause, or an expired `until` (team-state's read side already treats expiry as
   * unpaused, so the field cannot outlive the pause it describes). Team-scoped: only the
   * team marker's deadline may be claimed by a header badge, since only it covers the whole
   * team. JSON.stringify drops the undefined field, so `status --json` carries it only while
   * a timed team pause stands. Fresh per poll, like `paused`. */
  pausedUntil?: number;
  /** The paused-roles marker's one shared `until` (ms epoch) — the field `pause --role <id>
   * --for` writes — while a timed per-role pause stands; absent for a standing role pause, a
   * team-only pause, or after expiry. Read with `pausedRoles` from one marker parse, so it is
   * present only while that set is non-empty. */
  pausedRolesUntil?: number;
  /** A pending scheduled wake (`tumwater wake --in`): the roles it targets and the deadline
   * (ms epoch); absent for no marker, an immediate or expired one, or a corrupt one. */
  scheduledWake?: { roles: string[]; atMs: number };
  /** Every pending scheduled wake, earliest first (`scheduledWake` is its head); absent when
   * none is pending. */
  scheduledWakes?: { roles: string[]; atMs: number }[];
  /** The standing team pause's operator reason (`tumwater pause --reason <text>`), absent
   * for a reasonless pause, a role-only pause, or no pause at all — read from the same
   * standing marker read as `paused`/`pausedUntil`, so a reason is never advertised after
   * the pause it describes has lifted or been replaced (last write wins). JSON.stringify
   * drops the undefined field. Fresh per poll, like `paused`. */
  pauseReason?: string;
  /** The configured quiet-hours window as written (trimmed — "Quiet hours … part 2/2,
   * observability"), present only while the config's `quietHours` parses to a real window:
   * absent when unset or empty (off), because a schedule the gate is not holding must never
   * be advertised as one it is. A malformed value degrades with the whole config
   * (configForStatus's last-known-good hold, or the defaults when none exists) — the badge
   * never flashes off on one broken write. Standing information — the header badge shows it
   * in every configured state, like the budget badge's cap figure. Fresh per poll like
   * `paused`: a live `config set quietHours` edit shows on the next poll, the same
   * fresh-read rule the gate itself follows. */
  quietHours?: string;
  /** True while the LOCAL wall clock sits inside that window: idle roles start no new
   * runs (the director keeps steering). Decided by quiet-hours.ts's inQuietHours — the
   * scheduler's own predicate — so the dashboards and the hold cannot disagree. Fresh per
   * poll, like `quietHours`. */
  inQuietHours: boolean;
  /** The running harness's build (src/build/build-info.ts) as the orchestrator published it: the
   * stamp plus whether main's build inputs have moved past it. Null when no harness is running or
   * its dist carries no stamp. Both dashboards render it in the header — a stale build is the one
   * fact about the team that nothing inside the team can otherwise see. */
  build: BuildStatus | null;
  /** Prompts queued per role (`tumwater prompt --role <id>`),
   * keyed by role id for every enabled role except the director — the director's queue IS the
   * shared `inbox` above, so counting it here too would double-report the same prompts. Every
   * enabled role appears (0 included) so `status --json` consumers see one stable shape, like
   * `mergeQueue`; the dashboards render a `p:N` marker and the GUI's per-row prompt affordance
   * from it. Counts only — full previews stay in each queue file, readable via
   * `tumwater prompt --list --role <id>`. Fresh per poll (a directory listing per role, no
   * content reads — the stat-keyed prompt cache), like `inbox`/`inboxPrompts`. */
  roleInbox: Record<string, number>;
  /** Each non-director role's queued prompts with the queue-file basename that addresses
   * them (the /api/prompt-cancel target), execution order — the dashboard renders one cancel
   * row per prompt instead of a bare count. Roles with an empty queue are absent (unlike
   * roleInbox, which lists every role with 0): there is no row to render. Same read pass as
   * the previews (queuedRolePromptEntries, stat-keyed like the director's — each entry also
   * carries its enqueue stamp, queuedAtMs, for the Queued tab's age); filled only when
   * the count above is nonzero, so the common empty case costs one listing per role. */
  roleInboxPrompts: Record<string, Array<{ file: string; preview: string; queuedAtMs: number | null; notBeforeMs: number | null }>>;
  /** The durable merge queue (plans/merge-queue.md 4/5), unconditionally (depth 0 when
   * empty) so `status --json` consumers see one stable shape: the number of committed-but-
   * unmerged changes in the merge pipeline, and — only while a merge is actually
   * running — which ones. `inFlight` requires three things to agree: the 4/5 marker
   * exists, a queue entry with its sha still exists (entries are dropped only AFTER an
   * outcome — 3/5 — so in-flight always implies depth ≥ 1), and the orchestrator is alive.
   * The cross-check makes every crash ordering self-healing: a stale marker without a
   * matching entry never displays. The check is liveMergeMarker's: an older-generation
   * single-change marker displays only while its sha is queued; one with per-change records
   * keeps just the records whose entry is still queued and displays while one is not yet
   * `done`. */
  mergeQueue: {
    depth: number;
    /** Each queued change in execution order (oldest first) for `status --json` readers —
     * position, role, summary, sha, age. Filled from the same
     * `readMergeQueue` pass the depth already costs (shallow per-entry copies without the
     * optional `body`), only when at least one readable entry is queued — the
     * same filling discipline `roleInboxPrompts` follows: there is nothing to render, so the
     * common empty case carries no field. (`depth` can be positive with `entries` absent: it
     * also counts the unreadable files the reader skips.) */
    entries?: Array<{ role: string; sha: string; run: number; summary: string; enqueuedAt: number; revisionRound?: number; priorObjections?: number; retry?: string; notBefore?: number; highFriction?: true; retryCount?: number }>;
    inFlight?: MergeInFlight;
  };
  /** Main's newest merge-scope build check:
   * the latest `build_check` event at the `merge`/`batch`/`baseline` scope, read from the
   * event tail — the live replacement for the committed README stamp the readme role used to
   * maintain. `sha` is the main commit the check verified: a `merged` event after the check
   * names it via its `commit` field (a merge/batch check runs pre-merge; the merge's own
   * `merged` commit is the head it produced), otherwise main's current tip (a baseline check
   * runs ON the tip, and a later merge would have logged a newer check). Unresolvable from
   * either source — no merge yet and no readable ref — drops the field. Absent entirely
   * before any merge-scope check has run (and in tests that assemble snapshots by hand). */
  mainCheck?: MainCheckStatus;
  /** The disk floor's measured state (plans/disk-floor.md, part 4/4), read from the running
   * orchestrator's published info file: free space (one decimal), the configured floor and
   * reclaim threshold, whether the hold is on, and the last reclaim pass. Absent when no
   * orchestrator runs, its build predates the field, or statfs could not measure the volume —
   * every surface then renders exactly as before. */
  disk?: DiskStatus;
  /** The standing per-provider failure holds (src/team/team-hold.ts `standingHolds`), read
   * from the running orchestrator's info file: a provider storm's hold, so the dashboards and
   * `tumwater status` name why a provider's roles sit idle. Absent while none stands or the
   * orchestrator is not alive. */
  providerHolds?: OrchestratorInfo["providerHolds"];
  /** Direct dependencies the root checkout's `node_modules` does not hold at `package-lock.json`'s
   * pin (the doctor's `root install` row); absent when none drift. */
  rootInstallDrift?: string[];
  /** The permit pool's live state (plans/provider-concurrency.md §8) as the orchestrator
   * published it: team in-use/cap plus each referenced provider key's state. Only while the
   * orchestrator runs; absent otherwise, so the surfaces render exactly as before, and the
   * provider part of the team line appears only while any key carries a cap. */
  permits?: PermitSnapshot;
  /** The ci observer's parity ledger's glance verdict (src/run/ci-parity.ts, read through
   * status-polls.ts's ciParityForPoll): whether the last full-suite run has covered main's
   * current tip with the current lock — the badge's answer to "has the expensive verification
   * behind a green main actually run on this tip?". Absent when no parity record exists (a
   * repo the ci role has never run), so the surfaces render exactly as before the badge
   * existed. */
  ciParity?: CiParityStatus;
  /** True when no deterministic build check is declared — `detectBuildCheck(root, config)`
   * returned null (no `check.command` and no qualifying npm `package.json` on the walked-up
   * root) — the doctor `check` row's warning state (src/doctor/doctor-project-checks.ts's
   * checkBuildCheck). Present only in that state, so the always-on amber `no-check` alert
   * surfaces the silent state on `tumwater status`, the dashboard and the TUI; absent
   * otherwise, so the surfaces render exactly as before. */
  noDeclaredCheck?: boolean;
  /** True when a brief candidate file exists but none resolves to a usable prompt block —
   * the marker-less file, the unreadable candidate, or a marked block with no text
   * (src/brief/brief.ts's briefBlockMissing) — the doctor `brief` row's marker-less,
   * unreadable and empty-block warning state. Present only in that state, so the always-on
   * amber `no-brief` alert surfaces the silent state on `tumwater status`, the dashboard and
   * the TUI; absent otherwise (including the bare pre-init repo), so the surfaces render
   * exactly as before. */
  noBrief?: boolean;
  /** True when the resolved brief block exceeds the read cap (src/brief/brief.ts's
   * briefBlockOverCap) — the doctor `brief` row's over-cap warning state, the warning tune
   * extractPrompt truncates every run's prompt with. Present only in that state (the
   * always-on amber `brief-truncated` alert surfaces it on `tumwater status`, the dashboard
   * and the TUI); absent otherwise (at-cap, under-cap, empty and marker-less-keep-
   * `no-brief`'s), so the surfaces render exactly as before. */
  briefTruncated?: boolean;
  /** The check-permit pool's live state as the orchestrator published it; only while it runs. */
  checkPermits?: CheckPermitSnapshot;
  /** The workspace pool's live state as the running orchestrator published it; absent
   * otherwise, so a stopped team never shows a stale pool. */
  slotPool?: SlotPoolSnapshot;
  /** The earlier of the `run --for` deadline (the running orchestrator's info file) and a
   * `tumwater stop --in` marker (epoch ms); absent when neither is set or the team is stopped. */
  runStopsAt?: number;
  /** A `tumwater stop --in` marker's deadline (epoch ms) alone, so a surface can tell it from
   * `run --for`'s; absent when none is set or the team is stopped. */
  scheduledStopAt?: number;
}

/** The earlier of the two optional stop deadlines (`run --for`'s and a scheduled stop's). */
function earliestStop(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

/** The snapshot keeping only the listed roles' rows: a base id also keeps its instances
 * (`feature` keeps `feature-2`). Every other field stays team-wide. */
export function scopeSnapshotToRoles(snap: StatusSnapshot, roles: readonly string[]): StatusSnapshot {
  return { ...snap, roles: snap.roles.filter((s) => roleInScope(s.role, roles)) };
}

/** One fresh team snapshot for observers. `modelsPath` overrides pi's model definitions
 * location (default ~/.pi/agent/models.json) — a test seam, like doctor's pathEnv. `now` pins
 * the poll's clock for the budget figures (the persisted day-stamp check and the burn-rate
 * projection) — one instant for the whole block, and the seam that keeps a test's expected
 * projection from racing the snapshot's own `Date.now()`; production callers take the default
 * and read the live clock, as always. The three per-domain collectors (status-roles, status-
 * inbox, status-budget) each take the shared reads and the pinned `now` as parameters, so
 * every poll still reads a shared resource exactly once and the one `now` pins the whole
 * snapshot — the consistency property the per-collector comments call out. */
export function snapshot(root: string, modelsPath = piModelsPath(), now = Date.now()): StatusSnapshot {
  const cfg = configForStatus(root);
  const rootDrift = collectRootInstallDrift(root, now);
  // The gate's read-only bootstrap verdict (plans/work-ratio.md, part 2/2), computed over the
  // same last-known-good config the caps read, so the dashboards show the hold the scheduler
  // enforces. Null when no bootstrap is configured.
  const bootstrapNow = bootstrapStatus(root, cfg);
  // One row per role id (part 5b/7): an instance role shows `feature` and `feature-2`.
  const roles = runnerIds(cfg);
  const markerRoles = pausedRoles(root);
  const markerSet = new Set(markerRoles);
  // One read of the orchestrator info file per poll: it serves both the displayed pid and the
  // liveness check (passing it to orchestratorAlive skips its own re-read).
  const info = readOrchestratorInfo(root);
  // One slots.json read per poll serves every row: the pooled slot a role leases (a running
  // run or verification) or is pinned to — threaded into the roles collector so `running`,
  // `disk` and the rows agree.
  const slots = readSlotsState(root).slots;
  const roleRows = collectRoleRows(root, cfg, now, slots, modelsPath, markerSet);
  // The doctor's cached image-probe failures (part 5/5): one read per snapshot, labelled, so
  // the amber probe alert and `status --json` both answer from the same collector.
  const imageProbeFailures = collectImageProbeFailures(root, now);
  // One inbox pass per poll (status-inbox.ts) serves all four director fields and the per-role
  // counts/entries from the same queuedRolePromptEntries reads.
  const { inbox, inboxPrompts, inboxFiles, inboxQueuedAt, inboxNotBefore, roleInbox, roleInboxPrompts } =
    collectInboxes(root, roles, now);
  const running = orchestratorAlive(root, info);
  // One team-pause-marker read per poll serves both the paused flag and its deadline:
  // isTeamPaused + pausedUntil would each re-read the same marker file every second.
  const teamPause = standingTeamPause(root);
  // One read of the pending scheduled wakes feeds both the earliest and the full list, so they
  // cannot disagree.
  const wakes = scheduledWakes(root, now);
  // One merge queue pass per poll (merge-queue.ts's stat cache keeps an unchanged queue at one
  // stat per file) serves the depth; inFlight is the 4/5 marker only when a live orchestrator
  // still has a queue entry for what the marker names (per change, for a batch) — the
  // cross-check makes every crash ordering self-healing (a stale marker alone never displays,
  // and needs no cleanup pass).
  const queue = readMergeQueue(root);
  const merges = queue.entries;
  const mergeQueue: StatusSnapshot["mergeQueue"] = {
    depth: merges.length + queue.unreadable,
  };
  if (merges.length > 0) {
    mergeQueue.entries = merges.map((e) => ({
      role: e.role,
      sha: e.sha,
      run: e.run,
      summary: e.summary,
      enqueuedAt: e.enqueuedAt,
      ...(e.revisionRound !== undefined ? { revisionRound: e.revisionRound } : {}),
      ...(Array.isArray(e.priorReview?.reasons) && e.priorReview.reasons.length > 0 ? { priorObjections: e.priorReview.reasons.length } : {}),
      ...(typeof e.retry === "string" ? { retry: e.retry } : {}),
      ...(typeof e.notBefore === "number" ? { notBefore: e.notBefore } : {}),
      ...(e.highFriction === true ? { highFriction: true as const } : {}),
      ...(typeof e.retryCount === "number" ? { retryCount: e.retryCount } : {}),
    }));
  }
  const inFlight = queueInFlight(root, merges, running);
  if (inFlight) mergeQueue.inFlight = inFlight;
  // Quiet hours 2/2 — one parse and one clock read per poll serve both the window string the
  // header badge renders and the in-window boolean the active reading turns on; the value is
  // read fresh from the same cached config load the budget block uses, so a live edit shows
  // on the next poll exactly when the gate applies it.
  const quiet = quietHoursStatus(cfg.quietHours, new Date());
  // The spend/billing block (status-budget.ts): the budget object, the per-backend
  // subscription windows and the team-global free-ness answer, and the two per-role pause
  // verdicts, all from one readPiProviders and one readAccount per backend in use per poll.
  const { budget, subscriptionWindows, subscriptionOnly, budgetPausedRoles, capPaused } = collectBudget(
    root,
    cfg,
    roleRows,
    roles,
    running,
    info,
    modelsPath,
    now,
  );
  // The one-release claude spelling (see StatusSnapshot.claudeWindow), derived from the claude
  // block so `subscriptionWindows` stays the single source of the window data.
  const claudeBlock = subscriptionWindows.find((b) => b.backend === "claude");
  return {
    running,
    pid: info?.pid,
    build: running && info?.build ? info.build : null,
    inbox,
    inboxPrompts,
    inboxFiles,
    inboxQueuedAt,
    inboxNotBefore,
    roleInbox,
    roleInboxPrompts,
    questions: openQuestions(root).length,
    imageProbeFailures,
    roles: roleRows,
    // Unconditional (never null): a disabled team still shows its spend and the badge is
    // the affordance for SETTING a cap. models.json itself is stat-cached inside pi-models.ts,
    // so an unchanged catalog costs one stat per poll, not a re-read plus parse.
    budget,
    // One window block per subscription backend in use, raw for `status --json` and the
    // parts 3b/9–3e/9 displays; omitted when no subscription backend reported a window.
    ...(subscriptionWindows.length > 0 ? { subscriptionWindows } : {}),
    subscriptionOnly,
    ...(claudeBlock
      ? {
          claudeWindow: {
            windows: claudeBlock.windows,
            primary: claudeBlock.primary,
            only: subscriptionOnly,
            heldUntil: claudeBlock.heldUntil,
          },
        }
      : {}),
    ...(running && info?.chain && Object.keys(info.chain).length > 0 ? { chain: info.chain } : {}),
    // Only while running: a stale info file beside a dead pid must not speak for a stopped
    // team, and only while a hold stands (an empty list is the same as none).
    ...(running && info?.providerHolds && info.providerHolds.length > 0 ? { providerHolds: info.providerHolds } : {}),
    paused: teamPause !== null,
    pausedRoles: markerRoles,
    pausedRunners: roles.filter((id) => runnerPaused(markerSet, id)),
    capPaused,
    // The maintenance allowance (plans/work-ratio.md, part 1b/4): the same pure verdict the
    // gate folds, over the same event log, so the dashboards show the hold the scheduler
    // enforces. `merges` is the one merge queue snapshot read above, so in-flight maintenance
    // merges count once here and in mergeQueue.
    maintenanceQuota: maintenanceQuotaForPoll(
      root,
      cfg.maintenancePerWorkMerge,
      roleRows,
      new Set(merges.map((e) => e.role)),
      now,
    ),
    // The new-project bootstrap hold (plans/work-ratio.md, part 2/2): the same read-only
    // verdict the gate computes (bootstrapStatus), so the dashboards and the scheduler agree.
    // The held set is computed with the gate's own predicate over the same role list.
    bootstrap:
      bootstrapNow?.active
        ? { plansDone: bootstrapNow.plansDone, untilPlansDone: bootstrapNow.untilPlansDone }
        : undefined,
    bootstrapHeld:
      bootstrapNow?.active
        ? roleRows.filter((l) => bootstrapHoldsRole(l.role, openBugs(root).length > 0)).map((l) => l.role)
        : [],
    budgetPausedRoles,
    // The per-role quiet windows' held roles (PLANS.md quietHoursPerRole): keyed role →
    // window, so the dashboards can render the same `quiet until <end>` wording the team
    // badge uses, scoped to the role's own schedule. The window string comes back out of
    // the same config the hold was decided from, so the label cannot name a window that is
    // not holding (roleQuietHold true implies a parseable, non-empty string there).
    roleQuietPaused: Object.fromEntries(
      roleRows
        .filter((l) => l.role !== DIRECTOR_ROLE && roleQuietHold(cfg.quietHoursPerRole, baseRoleOf(l.role), new Date()))
        .map((l) => [l.role, cfg.quietHoursPerRole?.[baseRoleOf(l.role)] ?? ""]),
    ),
    pausedUntil: teamPause?.until,
    pausedRolesUntil: pausedRolesUntil(root),
    scheduledWake: wakes[0],
    scheduledWakes: wakes.length > 0 ? wakes : undefined,
    pauseReason: teamPause?.reason,
    quietHours: quiet.window ?? undefined,
    inQuietHours: quiet.inWindow,
    mergeQueue,
    mainCheck: mainCheckForPoll(root, cfg),
    ciParity: ciParityForPoll(root, cfg),
    noDeclaredCheck: detectBuildCheck(root, cfg) === null ? true : undefined,
    noBrief: briefBlockMissing(root) ? true : undefined,
    briefTruncated: briefBlockOverCap(root) ? true : undefined,
    // The disk floor's published state (plans/disk-floor.md, part 4/4): only while the
    // orchestrator runs — the exit removes the info file, so a stale file beside a dead pid
    // must not speak for a stopped team — and only when the last poll could measure the
    // volume. Absent otherwise, so the surfaces render exactly as before.
    disk: running && info?.disk ? info.disk : undefined,
    // Independent of the team running: a stopped team's worktrees still borrow the root install.
    rootInstallDrift: rootDrift.length ? rootDrift : undefined,
    // Only while running: a stale info file beside a dead pid must not speak for a stopped team.
    permits: running && info?.permits ? info.permits : undefined,
    slotPool: running && info?.slotPool ? info.slotPool : undefined,
    // Only while running: a stale info file beside a dead pid must not speak for a stopped team.
    checkPermits: running && info?.checkPermits ? info.checkPermits : undefined,
    // Only while running: a stale info file beside a dead pid must not speak for a stopped team.
    runStopsAt: running ? earliestStop(info?.stopsAt, scheduledStopAt(root)) : undefined,
    scheduledStopAt: running ? scheduledStopAt(root) : undefined,
  };
}
