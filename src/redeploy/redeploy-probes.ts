import type { CompileResult } from "../build/build-stage.js";
import type { RedeployDeps } from "./redeploy-policy.js";
import { errorMessage } from "../text/text.js";

/** Background-task tracking shared by the self-redeploy layer (src/redeploy/redeployer.ts, this module):
 * a probe the poll consults without awaiting — settled flag plus result or error. */

export interface Tracked<T> {
  done: boolean;
  result?: T;
  error?: string;
}

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

/** The cooldown's pre-warm probes (src/redeploy/redeployer.ts's poll runs them while the restart is
 * deferred — BUGS.md 2026-09-30): the deferred head's green check and, only after a green
 * verdict, its staged compile, once per SHA, owned here so the state machine's episode can
 * adopt whatever verdict is already in hand at the lapse. A red verdict or a "could not run"
 * shape prewarms nothing further — there is no point staging a compile for a tree the check
 * condemned — and is simply not adopted (the episode re-runs it under its own rules).
 * Skipped while an episode is pending: its own steps are the warm-up, and the mirror worktree
 * both run in must not serve two checks at once. */
export class PrewarmProbes {
  private head: string | null = null;
  private green: Tracked<boolean> | null = null;
  private compiled: Tracked<CompileResult> | null = null;

  constructor(private readonly deps: Pick<RedeployDeps, "mainGreen" | "compile">) {}

  /** Run the deferred head's green check, then its staged compile, once per SHA — the same
   * effects the episode itself runs, so their cost lands inside the dead window instead of
   * stretching it; the 12 h rate limit keeps protecting against churn, and this keeps it from
   * also idling away verification work a known-stale build owes. */
  prewarm(head: string, pending: boolean): void {
    if (pending) return;
    if (this.head !== head) {
      this.head = head;
      this.green = null;
      this.compiled = null;
    }
    if (this.green === null) {
      this.green = track(this.deps.mainGreen(head));
      return;
    }
    if (!this.green.done) return;
    if (this.green.error || this.green.result !== true) return;
    if (this.compiled === null) this.compiled = track(this.deps.compile(head));
  }

  /** The pre-warm's green check for `head`, when the episode can adopt it: still running (adopt
   * and keep waiting — the lapse caught the check mid-flight) or finished with a real verdict
   * (green or red). A check that finished WITHOUT a verdict — a rejection, "could not run" — is
   * never adopted: the episode's rejection rules drop the pending head and re-run the check
   * fresh, and adopting it would replay the same dead end on every retry (BUGS.md 2026-09-16). */
  adoptGreen(head: string): Tracked<boolean> {
    const g = this.head === head ? this.green : null;
    return g !== null && (!g.done || !g.error) ? g : track(this.deps.mainGreen(head));
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
