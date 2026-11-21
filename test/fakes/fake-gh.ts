/** A fake `gh` for the doctor's `feedback filing` check (checkFeedbackFiling), the `github
 * issues` row (checkGithubIssues) and the hourly issue scan (src/github/issue-scan.ts). The
 * readiness probe runs `gh --version` and `gh auth status --hostname github.com`, so this fake
 * answers those two, with switches to simulate a missing binary and an unauthenticated install.
 * `gh api repos/<repo>/issues?...&page=<n>` answers page <n> of the `issues` pages given (an empty
 * list past the last one), or fails when `apiFail` is set. Every other args vector is answered
 * with exit 0. Every invocation is recorded, so a test can assert that a row made no gh call at
 * all (an empty `calls`). No test reaches a real gh (see PRINCIPLES.md). */

interface FakeGhProbe {
  /** The probe to pass to checkFeedbackFiling and the issue scan: runs `gh <args>` and answers
   * per the fake's switches, recording the invocation on `calls`. */
  probe: (args: string[]) => Promise<{ code: number | null; stdout: string } | null>;
  /** Every args vector probed, in order. */
  calls: string[][];
}

/** Build a fake gh probe. `auth: false` makes `gh auth status` exit 1 (unauthenticated);
 * `version: false` makes `gh --version` fail as if gh were missing; `issues` gives the JSON
 * issue objects each `gh api` page returns, one array per page; `apiFail: true` makes every
 * `gh api` call exit 1. */
export function fakeGh(
  opts: {
    auth?: boolean;
    version?: boolean;
    issues?: unknown[][];
    apiFail?: boolean;
    /** The status each `api repos/<repo>/compare/<sha>...<branch>` answers, by sha, read on every
     * call so a test can change it between scans. A sha not listed is unknown to GitHub: the call
     * fails, as the real API does for a commit that was never pushed. */
    compare?: Record<string, string>;
  } = {},
): FakeGhProbe {
  const calls: string[][] = [];
  const authenticated = opts.auth ?? true;
  const hasVersion = opts.version ?? true;
  const pages = opts.issues ?? [];
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
    if (args[0] === "api") {
      if (opts.apiFail) return { code: 1, stdout: "" };
      const compare = /\/compare\/([0-9a-f]+)\.\.\./.exec(args[1] ?? "")?.[1];
      if (compare !== undefined) {
        const status = opts.compare?.[compare];
        return status === undefined ? { code: 1, stdout: "" } : { code: 0, stdout: `${status}\n` };
      }
      const page = Number(/[?&]page=(\d+)/.exec(args[1] ?? "")?.[1] ?? 1);
      return { code: 0, stdout: JSON.stringify(pages[page - 1] ?? []) };
    }
    return { code: 0, stdout: "" };
  };
  return { probe, calls };
}
