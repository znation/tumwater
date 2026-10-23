/** A fake `gh` for the doctor's `feedback filing` check (checkFeedbackFiling): the check probes
 * `gh --version` and `gh auth status`, so this fake answers those two and records every
 * invocation, with switches to simulate a missing binary and an unauthenticated install. The
 * same probe shape is what a filing run's `gh issue create`/`gh issue list` would exercise, so
 * the recorder keeps every args vector for part 2's contract tests. No test reaches a real gh
 * (see PRINCIPLES.md). */

interface FakeGhProbe {
  /** The probe to pass to checkFeedbackFiling: runs `gh <args>` and answers --version/auth
   * status per the fake's switches, recording the invocation on `calls`. */
  probe: (args: string[]) => Promise<{ code: number | null; stdout: string } | null>;
  /** Every args vector probed, in order. */
  calls: string[][];
}

/** Build a fake gh probe. `auth: false` makes `gh auth status` exit 1 (unauthenticated);
 * `version: false` makes `gh --version` fail as if gh were missing. */
export function fakeGh(
  opts: { auth?: boolean; version?: boolean } = {},
): FakeGhProbe {
  const calls: string[][] = [];
  const authenticated = opts.auth ?? true;
  const hasVersion = opts.version ?? true;
  const probe = async (
    args: string[],
  ): Promise<{ code: number | null; stdout: string } | null> => {
    calls.push(args);
    if (args[0] === "--version") {
      if (!hasVersion) return { code: null, stdout: "" };
      return { code: 0, stdout: "gh version 2.60.0\n" };
    }
    if (args[0] === "auth" && args[1] === "status") {
      if (!authenticated) return { code: 1, stdout: "" };
      return { code: 0, stdout: "Logged in to github.com account zach\n" };
    }
    return { code: 0, stdout: "" };
  };
  return { probe, calls };
}
