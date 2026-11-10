// Time of day for the 15-minute rules: which 4-hour block of US Eastern time
// a decision fell in, and a test of one block against the rest of the day.
//
// The trader found, on live fills from 2026-10-19/21, that 16-20h ET was
// p75's worst block and sharp-move's best (2026-11-10). Twelve blocks were
// looked at to find it, so one at t ~2 is about chance, and a pattern found
// on the live days cannot be tested on them. The test here is therefore
// FIXED BEFORE THE RUN and scored only on days before the live period:
//   p75    16-20h ET worse than the rest of the day (and 08-20h worse than 20-08h)
//   sharp  16-20h ET better than the rest of the day
// PASS: the paired-day t of (block - rest) is 2 or more in the predicted
// direction. Every block is printed for both periods as reference only.
export const TOD_BLOCKS = [0, 4, 8, 12, 16, 20];

const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23", weekday: "short" });
// -> { hour 0-23, weekend } in New York time, DST included.
export function etParts(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { hour: Number(p.hour) % 24, weekend: p.weekday === "Sat" || p.weekday === "Sun" };
}
export const blockOf = ms => Math.floor(etParts(ms).hour / 4) * 4;
export const blockLabel = b => `${String(b).padStart(2, "0")}-${String(b + 4).padStart(2, "0")}h ET`;

// Paired by day: on each day with trades on both sides of the split, the
// per-contract P&L inside minus outside. Pairing by day takes out what a
// day's market shares across hours; t is the mean difference over its
// standard error across those days.
export function pairedDayDiff(rows, inside) {
  const days = new Map();
  for (const r of rows) {
    const k = inside(r) ? "in" : "out";
    if (!days.has(r.day)) days.set(r.day, { in: [0, 0], out: [0, 0] });
    const d = days.get(r.day)[k]; d[0] += r.pnl; d[1] += r.ctrs;
  }
  const diffs = [...days.values()].filter(d => d.in[1] && d.out[1]).map(d => d.in[0] / d.in[1] - d.out[0] / d.out[1]);
  const n = diffs.length;
  if (n < 2) return { days: n, diff: null, t: null };
  const mean = diffs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(diffs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  return { days: n, diff: mean, t: sd > 1e-12 ? mean / (sd / Math.sqrt(n)) : null };
}

// The fixed hypotheses, by rule. `sign` is the predicted direction of
// (inside - outside).
export const TOD_TESTS = {
  p75: [
    { label: "16-20h ET vs the rest", inside: b => b === 16, sign: -1 },
    { label: "08-20h ET vs 20-08h ET", inside: b => b >= 8 && b < 20, sign: -1 },
  ],
  sharp: [
    { label: "16-20h ET vs the rest", inside: b => b === 16, sign: +1 },
  ],
};
export const verdict = (res, sign) => (res.t != null && sign * res.t >= 2 ? "PASS" : "FAIL");

// The report both scripts print with --tod. `line(label, rows)` is the
// script's own table row; rows carry t (decision time, ms) and, once
// filled, pnl and ctrs. `liveStart` splits the days the trader's live
// fills cover from the ones they never saw.
export function printTimeOfDay({ rows, rule, liveStart, line, header }) {
  const pre = rows.filter(r => r.t < liveStart), live = rows.filter(r => r.t >= liveStart);
  const day0 = new Date(liveStart).toISOString().slice(0, 10);
  console.log(`\nTIME OF DAY (${rule}) — by the decision's hour in New York time`);
  console.log(`  Fixed before the run, scored ONLY on days before ${day0} (the trader's live fills start then, and the pattern was found on them):`);
  for (const h of TOD_TESTS[rule]) console.log(`    ${h.label}: predicted ${h.sign < 0 ? "WORSE" : "BETTER"}. PASS if the paired-day t is 2 or more that way.`);
  for (const [name, set] of [[`BEFORE ${day0} (out of sample)`, pre], [`FROM ${day0} (the trader's period, reference)`, live]]) {
    console.log(`\n  ${name}`);
    console.log(header);
    for (const b of TOD_BLOCKS) console.log(line(blockLabel(b), set.filter(r => blockOf(r.t) === b)));
    console.log(line("weekday", set.filter(r => !etParts(r.t).weekend)));
    console.log(line("weekend", set.filter(r => etParts(r.t).weekend)));
    const filled = set.filter(r => r.pnl != null);
    for (const h of TOD_TESTS[rule]) {
      const res = pairedDayDiff(filled, r => h.inside(blockOf(r.t)));
      const c = v => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(100 * v).toFixed(2)}c`);
      console.log(`  ${h.label}: inside minus outside ${c(res.diff)} a contract over ${res.days} paired days, t ${res.t == null ? "—" : res.t.toFixed(2)}${set === pre ? `  -> ${verdict(res, h.sign)}` : "  (reference)"}`);
    }
  }
}
