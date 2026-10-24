/** The `tumwater gui` CLI entry: flag parsing, the banner, and the serve-until-Ctrl+C wait.
 * The HTTP server itself (startGui) lives in gui/gui-server.ts — this module owns the command
 * line, not the socket. The LAN address filter and the --token wording live here because
 * only the CLI's banner and flag gate use them. */
import os from "node:os";
import { startGui } from "./gui-server.js";
import { errCode } from "../errno.js";
import { fail, say } from "../cli/cli-output.js";
import { flagValue, parsePortFlag, tokenValueProblem } from "../cli/cli-args.js";

/** External IPv4 addresses of this machine's network interfaces, for printing the URLs a
 * `gui --all-interfaces` server is reachable at. IPv6 and internal (loopback) addresses are
 * skipped: the loopback URL is printed separately, and bracketed IPv6 URLs are rarely what
 * someone types on another device. The interface table is injectable (defaulting to the live
 * one) so the filter's inclusions and exclusions stay unit-testable on machines — CI boxes,
 * containers — that have no external address of their own. The parameter type says what
 * os.networkInterfaces() really returns: an interface with no addresses maps to undefined,
 * which is why the `?? []` below is load-bearing.
 */
export function lanAddresses(
  interfaces: Record<string, os.NetworkInterfaceInfo[] | undefined> = os.networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/** The env var that carries the dashboard gate token between a supervisor and its dashboard
 * child, and across a re-exec'd dashboard generation — and from a direct `--token` flag into
 * the process's own durable env. Process env is what a spawn hands a child intact (`childEnv`
 * in process.ts, and reexecSelf's own childEnv), whereas argv is what /proc/<pid>/cmdline
 * exposes to every local user and what a reload re-runs verbatim — so the secret must travel
 * by env, never argv. `cmdGui` seeds it from `--token` when the flag is given, and a
 * `run --gui` supervisor passes the token to its dashboard child through it instead of
 * guiArgs/argv. */
export const GUI_TOKEN_ENV = "TUMWATER_GUI_TOKEN";

/** Remove a `--token <secret>` pair from argv in place, so a process that typed the secret on
 * the command line stops exposing it in `ps`/`/proc/<pid>/cmdline` the moment cmdGui has copied
 * it into TUMWATER_GUI_TOKEN. Only a `--token` that has a following, non-flag value token is
 * removed: a valueless trailing `--token`, or one followed by another flag (both CLI errors
 * tokenValueProblem rejects), is left alone — deleting it would hide the operator's mistake
 * rather than surface it. Exported so the splice branch itself is unit-tested. */
export function stripTokenFromArgv(argv: string[]): void {
  const t = argv.indexOf("--token");
  if (t < 0) return;
  const next = t + 1 < argv.length ? argv[t + 1] : undefined;
  if (next !== undefined && !next.startsWith("--")) void argv.splice(t, 2);
}

/** Injectable seams for cmdGui, mirroring runTui's TuiSeams: the server it starts, the LAN
 * address list and the printer its banner names, and the serve-until-Ctrl+C wait. Production
 * callers omit it and get the real server, interfaces, stdout, and wait; tests inject fakes
 * so the CLI's gui-specific policy (the banner wording, the LAN announcement, the
 * listen-failure messages) is assertable in-process, without a listener or a killed child whose
 * coverage the suite can never see. */
export interface GuiSeams {
  startGui?: typeof startGui;
  lanAddresses?: typeof lanAddresses;
  say?: typeof say;
  serve?: () => Promise<void>;
}

/** The `tumwater gui` command: parse the --port/--all-interfaces/--token flags, start the
 * server, print the banner, and serve until Ctrl+C. Lives beside startGui (gui/gui-server.ts) so
 * the CLI's gui-specific policy (token validation, the listen-failure messages, the LAN
 * announcement) cannot drift from the server it drives. Flag-vocabulary rejection stays in
 * cli.ts with the other cases; everything gui-specific after that gate is this function's job.
 * A failed listen throws (cli.ts's main catch renders it as the same `tumwater: …` line and
 * exit 1 fail() would) so the listen-failure wordings stay assertable in-process. */
export async function cmdGui(root: string, args: string[], seams: GuiSeams = {}): Promise<void> {
  const start = seams.startGui ?? startGui;
  const lan = seams.lanAddresses ?? lanAddresses;
  const print = seams.say ?? say;
  const serve = seams.serve ?? (() => new Promise<void>(() => {}));
  const portRaw = flagValue(args, "--port");
  const port = portRaw !== null ? parsePortFlag(portRaw) : 7180;
  const allInterfaces = args.includes("--all-interfaces");
  // A valueless or empty --token is a CLI error, not an open server: an operator who
  // asked for protection must never silently get none. The validation and its wording
  // live in tokenValueProblem, shared with `start --gui` so the two callers cannot
  // drift; its flag-looking-value case names `tumwater gui` here.
  const problem = tokenValueProblem(args, "tumwater gui");
  if (problem) fail(problem);
  const flagToken = flagValue(args, "--token");
  const token = flagToken ?? process.env[GUI_TOKEN_ENV] ?? "";
  if (flagToken !== null) {
    // The `--token` flag is a convenience that still transits the command line, so it shows up
    // in `ps`/`/proc/<pid>/cmdline` to any local user (the world-readable channel). Carry the
    // token forward by environment only: seed the env var now and drop the secret from this
    // process's argv, so a self-reload's re-run and every child keep it off the process table.
    // The operator could instead pre-set TUMWATER_GUI_TOKEN to avoid typing it at all; that
    // advice is the warning printed below.
    process.env[GUI_TOKEN_ENV] = token;
    print(
      "--token on the command line is visible to any local user in ps; prefer TUMWATER_GUI_TOKEN to keep the secret off the process list",
    );
    stripTokenFromArgv(process.argv);
  }
  try {
    await start(root, port, allInterfaces, token);
  } catch (err) {
    // The two common listen failures each get a hint naming their fix; Node's raw
    // EADDRINUSE/EACCES suggest nothing. Rarer errors keep their raw message. The
    // EACCES hint assumes the privileged-port cause — a sandbox refusing even an
    // unprivileged port lands here too and takes the below-1024 wording, which is
    // then only a guess — but an occasionally-missed hint still beats a bare
    // "permission denied" that never suggests anything.
    if (errCode(err) === "EADDRINUSE")
      throw new Error(
        `port ${port} is already in use — stop that process or pick another port with \`tumwater gui --port <n>\``,
      );
    if (errCode(err) === "EACCES")
      throw new Error(
        `port ${port} could not be opened (permission denied) — ports below 1024 need root; pick an unprivileged port with \`tumwater gui --port <n>\``,
      );
    throw err;
  }
  const tokenSuffix = token ? `/?token=${encodeURIComponent(token)}` : "";
  print(`tumwater gui at http://127.0.0.1:${port}${tokenSuffix} — Ctrl+C to stop`);
  if (allInterfaces) {
    // Name the concrete URLs teammates can open (token included, so they are openable
    // as printed), and say what exposure means: without a token the dashboard has no
    // auth and its prompt box steers the team; with one, the token is the gate.
    for (const addr of lan()) print(`             also at http://${addr}:${port}${tokenSuffix}`);
    print(
      token
        ? "listening on ALL interfaces — token-protected; prompting the director requires the token"
        : "listening on ALL interfaces — no auth; anyone reaching it can prompt the director",
    );
  }
  await serve(); // Serve until Ctrl+C.
}
