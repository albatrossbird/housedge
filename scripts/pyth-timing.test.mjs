// lib/pythTiming.js — finding WHEN a Pyth-settled market takes its print.
// A synthetic price path is settled at a known offset; the scan must find
// that offset and no other.
import { priceAt, scoreOffset } from "../lib/pythTiming.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };

// A seeded random walk, one row a second, ~4000 with $0.40 steps.
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
const START = 1_793_000_000_000, SECS = 200 * 900;
const t = new Float64Array(SECS), v = new Float64Array(SECS);
for (let i = 0, p = 4000; i < SECS; i++) { t[i] = START + i * 1000; p += rnd() * 0.8; v[i] = p; }
const T = { t, v };

console.log("priceAt");
ok(priceAt(T, START + 1500) === v[1], "the row standing at a moment is the last at or before it");
ok(priceAt(T, START - 1) === null, "nothing before the first row");
ok(priceAt({ t: Float64Array.of(START), v: Float64Array.of(1) }, START + 61000) === null, "a row over 60s old is a shut market, not a price");

function settledAt(offsetMs) {
  const W = [];
  let strike = priceAt(T, START + 900000 + offsetMs);
  for (let k = 2; k < 199; k++) {
    const close = START + k * 900000, value = priceAt(T, close + offsetMs);
    W.push({ close, strike, value, result: value >= strike ? "yes" : "no" });
    strike = value;
  }
  return W;
}

console.log("scoreOffset");
for (const truth of [0, 60000]) {
  const W = settledAt(truth);
  const rows = [-60000, -30000, 0, 30000, 60000, 90000].map(o => scoreOffset(T, W, o));
  const best = rows.reduce((a, b) => (b.corr > a.corr ? b : a));
  ok(best.offsetMs === truth && Math.abs(best.corr - 1) < 1e-9 && best.side === 1 && best.near === 1,
    `settled at +${truth / 1000}s: the scan peaks there, exactly`, JSON.stringify(best));
  const off = rows.find(r => r.offsetMs === truth + 30000);
  ok(off.corr < 0.99 && off.near < 1, `and 30s away it does not fit (corr ${off.corr.toFixed(3)}, near ${off.near})`);
}
{
  // A scaled, inverted quote (6J-style after inversion is done upstream;
  // here a unit gap) is a slope, not a worse fit.
  const W = settledAt(0).map(w => ({ ...w, strike: w.strike * 2, value: w.value * 2 }));
  const r = scoreOffset(T, W, 0);
  ok(Math.abs(r.slope - 2) < 1e-9 && Math.abs(r.corr - 1) < 1e-9, "a unit gap is fitted as a slope");
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
