// Path → category for the OSS baseline repos (REPO env var = a name in oss-repos.tsv, whose last
// column is that repo's production root). "src" = production TypeScript under that root,
// "test:spec" = any JS/TS test code anywhere, "docs:prose" / "docs:changelog" = markdown,
// null = not counted: examples, samples, benchmarks, build scripts, websites, vendored or
// fixture node_modules, and .d.ts declarations.
const fs = require("fs");
const path = require("path");
const PROD_ROOT = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, "oss-repos.tsv"), "utf8").split("\n")
    .filter((l) => l && !l.startsWith("#")).map((l) => { const c = l.split("\t"); return [c[0], c[4]]; }),
);
const EXCLUDE = /(^|\/)(examples?|samples?|benchmarks?|website|docs?|scripts|resources|tools|dist|dist-raw|build|node_modules|typings|client-dist|\.github|\.circleci)(\/|$)/;
const TEST = /(^|\/)(test|tests|__tests__|__testUtils__|spec|integration|integrationTests|fixtures)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/;
module.exports = function category(f) {
  const root = PROD_ROOT[process.env.REPO];
  if (!root) throw new Error(`REPO=${process.env.REPO} is not in oss-repos.tsv`);
  if (f.endsWith(".md")) {
    if (/node_modules\//.test(f)) return null;
    return /(^|\/)CHANGELOG[^/]*\.md$/i.test(f) ? "docs:changelog" : "docs:prose";
  }
  if (EXCLUDE.test(f) || f.endsWith(".d.ts")) return null;
  if (!/\.([cm]?[jt]s|tsx|jsx)$/.test(f)) return null;
  if (TEST.test(f)) return "test:spec";
  if (f.startsWith(root) && /\.([cm]?ts|tsx)$/.test(f)) return "src";
  return null;
};
module.exports.EXCLUDE = EXCLUDE;
module.exports.TEST = TEST;
