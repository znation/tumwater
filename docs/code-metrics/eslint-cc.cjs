// Summarize the eslint-complexity.config.mjs run (ESLint JSON report) the way summary.cjs reports
// analyze.cjs's own McCabe counts, so the two can be compared.
// Usage: node eslint-cc.cjs <eslint-report.json>
const report = require(require("path").resolve(process.argv[2]));
const cc = [];
for (const f of report) for (const m of f.messages) { const x = /complexity of (\d+)/.exec(m.message); if (x) cc.push(Number(x[1])); }
cc.sort((a, b) => a - b);
const q = (p) => (cc.length ? cc[Math.floor((cc.length - 1) * p)] : NaN);
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "-");
console.log(`eslint classic complexity: n ${cc.length}, mean ${fmt(cc.reduce((a, b) => a + b, 0) / cc.length, 2)}, median ${fmt(q(0.5), 0)}, p90 ${fmt(q(0.9), 0)}, max ${fmt(cc.at(-1), 0)}, >10 ${fmt((100 * cc.filter((x) => x > 10).length) / cc.length) + "%"}, >20 ${cc.filter((x) => x > 20).length}`);
