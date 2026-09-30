// Scale and pace: what human-effort models estimate for the code that exists, against how long
// it actually took, and surviving code lines per day by author.
//
// Usage: node scale.cjs <data-dir>
//   reads <data-dir>/metrics.json (analyze.cjs), blame.json (blame.py) and history-tumwater.json
//   (history.py); writes <data-dir>/scale.json and prints the summary.
//
// Code lines are analyze.cjs's code class (comments and blank lines excluded), production = src/,
// tests = test/, surviving at the checkout's HEAD. Two reference models, both line-count based:
//   Basic COCOMO, organic mode (Boehm 1981): effort E = 2.4 × KLOC^1.05 person-months, schedule
//     D = 2.5 × E^0.38 months, average staff E / D.
//   McConnell's lines of code per staff-year by project size, as quoted by Coding Horror (2006)
//     for 100,000-line projects, the band nearest tumwater: 1,000–20,000 a year, COCOMO average
//     2,600. Per working day assumes 250 working days a year.
const fs = require("fs");
const path = require("path");
const DATA = path.resolve(process.argv[2]);
const M = JSON.parse(fs.readFileSync(path.join(DATA, "metrics.json"), "utf8"));
const BL = JSON.parse(fs.readFileSync(path.join(DATA, "blame.json"), "utf8")).files;
const H = JSON.parse(fs.readFileSync(path.join(DATA, "history-tumwater.json"), "utf8"));
const who = (c) => (c === "tumwater" ? "tumwater" : c && c.startsWith("claude") ? "claude" : "human");

const lines = { prod: {}, test: {} }; // area → author → surviving code lines
for (const f of M.files) {
  const area = f.cat.startsWith("src") ? "prod" : f.cat.startsWith("test") ? "test" : null;
  if (!area || !f.cls) continue;
  for (let i = 0; i < f.cls.length; i++) {
    if (f.cls[i] !== "c") continue;
    const a = who(BL[f.file]?.cls[i]);
    lines[area][a] = (lines[area][a] || 0) + 1;
  }
}
const total = (area, a) => (a ? lines[area][a] || 0 : Object.values(lines[area]).reduce((s, x) => s + x, 0));

const cocomo = (codeLines) => {
  const effort = 2.4 * (codeLines / 1000) ** 1.05; // person-months
  const schedule = 2.5 * effort ** 0.38; // months
  return { effortMonths: effort, staffYears: effort / 12, scheduleMonths: schedule, staff: effort / schedule };
};
const MCCONNELL_100K = { low: 1000, high: 20000, cocomoAverage: 2600 }; // lines per staff-year
const WORK_DAYS = 250;
const mcconnell = (codeLines) => ({
  staffYears: { atCocomoAverage: codeLines / MCCONNELL_100K.cocomoAverage, range: [codeLines / MCCONNELL_100K.high, codeLines / MCCONNELL_100K.low] },
  linesPerWorkDay: { atCocomoAverage: MCCONNELL_100K.cocomoAverage / WORK_DAYS, range: [MCCONNELL_100K.low / WORK_DAYS, MCCONNELL_100K.high / WORK_DAYS] },
});

const days = H.spanDays;
const prod = total("prod"), both = prod + total("test");
const added = H.linesByArea.src.added + H.linesByArea.test.added;
const byAuthor = Object.fromEntries(["tumwater", "claude"].map((a) => {
  const n = total("prod", a) + total("test", a);
  return [a, { codeLines: n, perCalendarDay: n / days, activeDays: H[a]?.activeDays, perActiveDay: n / (H[a]?.activeDays || days) }];
}));
const out = {
  spanDays: days, first: H.first, last: H.last,
  codeLines: { production: prod, tests: total("test"), productionAndTests: both },
  cocomo: { production: cocomo(prod), productionAndTests: cocomo(both) },
  mcconnell: { production: mcconnell(prod), productionAndTests: mcconnell(both) },
  pace: {
    survivingPerCalendarDay: { production: prod / days, productionAndTests: both / days },
    addedPerCalendarDay: { srcAndTest: added / days }, // physical lines added (before deletions), git numstat
    byAuthor,
    // people needed to sustain the whole repository's surviving-code rate for a year at McConnell's
    // per-staff-year rates: (lines per calendar day × 365) / lines per staff-year
    equivalentStaff: {
      atCocomoAverage: (both / days) * 365 / MCCONNELL_100K.cocomoAverage,
      range: [(both / days) * 365 / MCCONNELL_100K.high, (both / days) * 365 / MCCONNELL_100K.low],
    },
  },
};
fs.writeFileSync(path.join(DATA, "scale.json"), JSON.stringify(out, null, 1));

const n0 = (x) => Math.round(x).toLocaleString("en-US");
const n1 = (x) => x.toFixed(1);
console.log(`span ${n1(days)} days (${H.first} → ${H.last} PDT)`);
console.log(`surviving code lines: production ${n0(prod)}, tests ${n0(total("test"))}, both ${n0(both)}`);
for (const [k, v] of Object.entries(out.cocomo))
  console.log(`COCOMO ${k}: ${n0(v.effortMonths)} person-months (${n1(v.staffYears)} staff-years), schedule ${n1(v.scheduleMonths)} months with ${n1(v.staff)} people`);
for (const [k, v] of Object.entries(out.mcconnell))
  console.log(`McConnell 100k-line rates ${k}: ${n1(v.staffYears.atCocomoAverage)} staff-years at the COCOMO average (range ${n1(v.staffYears.range[0])}–${n1(v.staffYears.range[1])})`);
const r = out.mcconnell.production.linesPerWorkDay;
console.log(`human reference: ${n1(r.range[0])}–${n0(r.range[1])} code lines per staff working day, ${n1(r.atCocomoAverage)} at the COCOMO average`);
console.log(`pace: ${n0(out.pace.survivingPerCalendarDay.productionAndTests)} surviving code lines per calendar day (production alone ${n0(out.pace.survivingPerCalendarDay.production)}); ${n0(out.pace.addedPerCalendarDay.srcAndTest)} src+test lines added per day before deletions`);
const eq = out.pace.equivalentStaff;
console.log(`equivalent team at McConnell's rates: ${n0(eq.atCocomoAverage)} developers at the COCOMO average (range ${n0(eq.range[0])}–${n0(eq.range[1])})`);
for (const [a, v] of Object.entries(byAuthor))
  console.log(`  ${a}: ${n0(v.codeLines)} surviving code lines, ${n0(v.perCalendarDay)} per calendar day, ${n0(v.perActiveDay)} per active day (${v.activeDays} active days)`);
