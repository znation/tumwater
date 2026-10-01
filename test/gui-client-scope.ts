/** Load pieces of the dashboard's browser script into a test. The script is one blob the page
 * inlines (src/ui/gui-client.ts), so its testable parts are marked regions (`// <name>:start`
 * … `// <name>:end`); clientScope runs the chosen regions in one function scope — after the
 * script's own esc() — with stand-ins for whatever else they reach (the DOM, postJson, …),
 * and hands back the names asked for. Pure regions need no stand-ins at all. */
import { GUI_CLIENT_JS } from "../src/ui/gui-client.js";

/** The source of one marked region of the served script. Exported for tests that run a
 * region alongside code outside the marked regions (the drawer blob). */
export function clientRegion(name: string): string {
  const start = GUI_CLIENT_JS.indexOf(`// ${name}:start`);
  const end = GUI_CLIENT_JS.indexOf(`// ${name}:end`);
  if (start < 0 || end < start) throw new Error(`no "${name}" region in the dashboard script`);
  return GUI_CLIENT_JS.slice(start, end);
}

/** The script's own escape function, as served. Exported for the same callers. */
export const ESC_LINE = GUI_CLIENT_JS.match(/^\s*const esc = .*$/m)?.[0] ?? "";

/** Run `regions` (in order, after esc) in one scope with `inject` bound as free variables, and
 * return the declarations named in `names`. */
export function clientScope<T>(regions: string[], names: string[], inject: Record<string, unknown> = {}): T {
  const code = [ESC_LINE, ...regions.map(clientRegion)].join("\n");
  const keys = Object.keys(inject);
  const run = new Function(...keys, `${code}\nreturn { ${names.join(", ")} };`) as (...args: unknown[]) => T;
  return run(...keys.map((k) => inject[k]));
}

/** An icon() stand-in: the icon's name in a marker the assertions can find. */
export const iconStub = (name: string): string => `<i:${name}>`;
