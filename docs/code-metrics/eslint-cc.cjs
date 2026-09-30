// Summarize the eslint-complexity.config.mjs run (ESLint JSON report) the way summary.cjs reports
// analyze.cjs's own McCabe counts, so the two can be compared.
// Usage: node eslint-cc.cjs <eslint-report.json>
const report = require(require("path").resolve(process.argv[2]));
const cc = [];
for (const f of report) for (const m of f.messages) { const x = /complexity of (\d+)/.exec(m.message); if (x) cc.push(Number(x[1])); }
cc.sort((a, b) => a - b);
const q = (p) => cc[Math.floor((cc.length - 1) * p)];
console.log(`eslint classic complexity: n ${cc.length}, mean ${(cc.reduce((a, b) => a + b, 0) / cc.length).toFixed(2)}, median ${q(0.5)}, p90 ${q(0.9)}, max ${cc.at(-1)}, >10 ${((100 * cc.filter((x) => x > 10).length) / cc.length).toFixed(1)}%, >20 ${cc.filter((x) => x > 20).length}`);
