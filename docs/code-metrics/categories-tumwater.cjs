// Path → category for the tumwater repository. Never returns null, so every tracked file is
// counted somewhere (the repo-wide breakdown in docs/code-metrics.md sums them all).
module.exports = function category(f) {
  if (f.startsWith("docs/code-metrics/")) return "docs:tooling"; // this pipeline — not product code
  if (f.startsWith("src/ui/")) return "src/ui";
  if (f.startsWith("src/")) return "src";
  if (f.startsWith("test/") && f.endsWith(".test.ts")) return "test:spec";
  if (f.startsWith("test/")) return "test:support";
  if (f.startsWith("scripts/") || f === "eslint.config.js") return "scripts";
  if (f.startsWith(".github/")) return "ci";
  if (/^(BUGS|PLANS|QUESTIONS)\.md$/.test(f) || f.startsWith("plans/")) return "docs:backlog";
  if (f.endsWith(".md") || f === "LICENSE") return "docs:prose";
  return "config/other";
};
