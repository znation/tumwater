import type { CompileResult } from "../build/build-stage.js";
import type { RedeployDeps } from "./redeploy-policy.js";
import { errorMessage } from "../text/text.js";

/** Background-task tracking shared by the self-redeploy layer (src/redeploy/redeployer.ts, this
 * module): a probe the poll consults without awaiting — settled flag plus result or error. */

export interface Tracked<T> {
  done: boolean;
  result?: T;
  error?: string;
}

/** Track a promise without awaiting it: the returned snapshot flips `done` on settlement and
 * carries either the resolved value or the rejection's message. Attaches the rejection
 * handler, so a probe that fails never surfaces as an unhandled rejection. */
export function track<T>(promise: Promise<T>): Tracked<T> {
  const t: Tracked<T> = { done: false };
  promise.then(
    (r) => {
      t.result = r;
      t.done = true;
    },
    (err: unknown) => {
      t.error = errorMessage(err);
      t.done = true;
    },
  );
  return t;
}

/** The mirror worktree's steps: redeploy.ts runs every green check and staged compile in one
 * shared checkout (`.tumwater/worktrees/_main`), checking it out at the step's head first, so a
 * step started while another runs re-points the mirror under it. The running one then finishes
 * on a tree it did not start on and records its verdict against the wrong SHA: on 2026-10-30 a
 * cooldown pre-warm's suite ran on while the lapsed episode checked the mirror out at two newer
 * heads, and logged 10 failures against a tree it never ran. Every step the pre-warm and the
 * episode run starts here, and none starts while an earlier one is unsettled — a superseded
 * episode's included: the episode forgets its step when main moves, this does not. A refused
 * start returns null; the caller holds and asks again on a later poll. */
export class MirrorSteps {
  private running: Tracked<unknown> | null = null;

  constructor(private readonly deps: Pick<RedeployDeps, "mainGreen" | "compile">) {}

  /** True while a step started here has not settled. */
  busy(): boolean {
    return this.running !== null && !this.running.done;
  }

  /** Start `head`'s green check, or null while an earlier step still runs. */
  green(head: string): Tracked<boolean> | null {
    return this.start(() => this.deps.mainGreen(head));
  }

  /** Start `head`'s staged compile, or null while an earlier step still runs. */
  compile(head: string): Tracked<CompileResult> | null {
    return this.start(() => this.deps.compile(head));
  }

  private start<T>(step: () => Promise<T>): Tracked<T> | null {
    if (this.busy()) return null;
    const t = track(step());
    this.running = t;
    return t;
  }
}

/** The cooldown's pre-warm probes (src/redeploy/redeployer.ts's poll runs them while the restart is
 * deferred — BUGS.md 2026-09-30): the deferred head's green check and, only after a green
 * verdict, its staged compile, once per SHA, owned here so the state machine's episode can
 * adopt whatever verdict is already in hand at the lapse. A red verdict or a "could not run"
 * shape prewarms nothing further — there is no point staging a compile for a tree the check
 * condemned — and is simply not adopted (the episode re-runs it under its own rules).
 * Skipped while an episode is pending: its own steps are the warm-up. Both start their steps
 * through the same MirrorSteps, so neither re-points the mirror under the other's running step.
 * A new head that arrives while a step is still running is not adopted: returning without
 * resetting keeps probing the head the running check (or compile) is testing; the next poll
 * after it settles takes the newest head as today. */
export class PrewarmProbes {
  private head: string | null = null;
  private green: Tracked<boolean> | null = null;
  private compiled: Tracked<CompileResult> | null = null;

  constructor(private readonly mirror: MirrorSteps) {}

  /** Run the deferred head's green check, then its staged compile, once per SHA — the same
   * effects the episode itself runs, so their cost lands inside the dead window instead of
   * stretching it; the restart rate limit keeps protecting against churn, and this keeps it from
   * also idling away verification work a known-stale build owes. */
  prewarm(head: string, pending: boolean): void {
    if (pending) return;
    if (this.head !== head) {
      // A newer head arrived while a step is still running in the mirror (see MirrorSteps): keep
      // probing for the older head; the next poll after it settles adopts the newest head.
      if (this.mirror.busy()) return;
      this.head = head;
      this.green = null;
      this.compiled = null;
    }
    // A step the busy mirror refused stays null and starts on a later poll.
    if (this.green === null) {
      this.green = this.mirror.green(head);
      return;
    }
    if (!this.green.done) return;
    if (this.green.error || this.green.result !== true) return;
    if (this.compiled === null) this.compiled = this.mirror.compile(head);
  }

  /** The pre-warm's green check for `head`, when the episode can adopt it: still running (adopt
   * and keep waiting — the lapse caught the check mid-flight) or finished with a real verdict
   * (green or red). A check that finished WITHOUT a verdict — a rejection, "could not run" — is
   * never adopted: the episode's rejection rules drop the pending head and re-run the check
   * fresh, and adopting it would replay the same dead end on every retry (BUGS.md 2026-09-16).
   * Otherwise a fresh check of `head` — or null while an earlier step still runs in the mirror,
   * when the episode holds in its check and asks again on the next poll. */
  adoptGreen(head: string): Tracked<boolean> | null {
    const g = this.head === head ? this.green : null;
    return g !== null && (!g.done || !g.error) ? g : this.mirror.green(head);
  }

  /** The pre-warm's staged compile for `head`, when the episode can adopt it: still running (a
   * compile in flight when the lapse lands — adopt and keep waiting, never start a second one
   * against the same mirror and staging dir) or finished ok (its staged tree is exactly the
   * artifact the swap consumes). A compile that finished without a usable verdict — a rejected
   * spawn or a thrown promise — is never adopted, like the green check above. A finished FAILED
   * compiler verdict is also not adopted: the episode recompiles, so every block decision rests
   * on a verdict its own step produced, at the cost of one bounded recompile. */
  adoptCompile(head: string): Tracked<CompileResult> | null {
    const c = this.head === head ? this.compiled : null;
    return c !== null && (!c.done || c.result?.ok === true) ? c : null;
  }
}
