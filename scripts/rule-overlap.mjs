// p75 and sharp-move in the same window (docs/research/restart-plan.md).
//
//   node scripts/rule-overlap.mjs --p75=.vol-cache/p75.json --sharp=a.txt,b.txt [--size=10]
//
// --p75   the tape backtest's --out file (scripts/m15-tape-backtest.mjs).
// --sharp one or more files of scripts/m15-index.mjs --list lines (the
//         "EVERY 1bp DECISION" block of a run's log), 40 contracts.
// Joined on the window's ticker over the days both cover. p75 always buys
// the favourite; its side is read from the window's result and whether it
// won. Both rules are scaled to --size contracts.
//
// Prints p75's trades by what sharp-move held in the window, and the
// combined daily risk under three skip rules. Decision rule: the plan.

import { readFileSync } from "node:fs";
import { etParts, blockOf } from "../lib/m15TimeOfDay.js";
import { welchT } from "../lib/volFlag.js";

const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const SIZE = Number(opt("size", 10));
const sharpAll = new Map();
for (const f of String(opt("sharp", "")).split(",").filter(Boolean)) {
  for (const l of readFileSync(f, "utf8").split("\n")) {
    const c = l.trim().split(/\s+/);
    if (!/^KXBTC15M-/.test(c[0])) continue;
    const ctrs = Number(c[7]);
    sharpAll.set(c[0], { ticker: c[0], t: Date.parse(c[1]), side: c[5], seen: Number(c[6]), ctrs, result: c[c.length - 2], pnl: Number(c[c.length - 1]) * SIZE / 40 });
  }
}
const sharp = [...sharpAll.values()].filter(x => x.ctrs > 0);
const lo = Math.min(...[...sharpAll.values()].map(x => x.t)), hi = Math.max(...[...sharpAll.values()].map(x => x.t));
const day = ms => new Date(ms).toISOString().slice(0, 10);
const p75 = JSON.parse(readFileSync(opt("p75"), "utf8")).filter(x => x.t >= Date.parse(`${day(lo)}T00:00:00Z`) && x.t <= hi + 900000)
  .map(x => ({ ticker: x.ticker, t: x.t, price: x.price, won: x.won, pnl: x.pnl * SIZE / x.ctrs, ctrs: SIZE }));
const sBy = new Map(sharp.map(x => [x.ticker, x]));
for (const p of p75) {
  const s = sBy.get(p.ticker);
  p.cls = !s ? "none" : (s.side === s.result) === p.won ? "same" : "opposite";
  p.sharpPnl = s ? s.pnl : 0;
  p.filtered = blockOf(p.t) === 16 || etParts(p.t).weekend;   // the restart plan's two p75 filters
}
const days = [...new Set([...sharp.map(x => day(x.t)), ...p75.map(x => day(x.t))])].sort();
const mid = days[Math.floor(days.length / 2)];
const c = v => Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(2) + "c" : "—";
const per = xs => xs.length ? 100 * xs.reduce((s, x) => s + x.pnl, 0) / xs.reduce((s, x) => s + x.ctrs, 0) : NaN;
const pc = xs => xs.map(x => 100 * x.pnl / x.ctrs);

console.log(`P75 AND SHARP-MOVE IN ONE WINDOW, ${days[0]} .. ${days.at(-1)} (${days.length} days), ${SIZE} contracts each`);
console.log(`sharp-move: ${sharpAll.size} decisions, ${sharp.length} filled (+250ms, seen +1c). p75: ${p75.length} tape trades.`);
console.log("\np75's trades, by what sharp-move already held in that window:");
console.log("  sharp-move held     trades  won    paid   per ctr   halves                 vs no position: diff     t");
const none = p75.filter(x => x.cls === "none");
for (const k of ["none", "same", "opposite"]) {
  const xs = p75.filter(x => x.cls === k), A = xs.filter(x => day(x.t) < mid), B = xs.filter(x => day(x.t) >= mid);
  const t = k === "none" ? null : welchT(pc(xs), pc(none));
  console.log(`  ${({ none: "nothing", same: "the same side", opposite: "the other side" })[k].padEnd(18)} ${String(xs.length).padStart(6)}  ${(100 * xs.filter(x => x.won).length / xs.length).toFixed(1).padStart(5)}%  ${(xs.reduce((s, x) => s + x.price, 0) / xs.length).toFixed(3)}  ${c(per(xs)).padStart(8)}   ${c(per(A)).padStart(8)} / ${c(per(B)).padStart(8)}   ${k === "none" ? "" : `${c(per(xs) - per(none)).padStart(8)}  ${(t ?? NaN).toFixed(2).padStart(6)}`}`);
}
// Secondary: the SIGNAL rather than the position. Every sharp-move
// decision, filled or not, against p75's side in that window.
console.log("\nthe same split by sharp-move's DECISION, filled or not (the signal, not the position):");
for (const p of p75) { const s = sharpAll.get(p.ticker); p.sig = !s ? "none" : (s.side === s.result) === p.won ? "same" : "opposite"; }
const noSig = p75.filter(x => x.sig === "none");
for (const k of ["none", "same", "opposite"]) {
  const xs = p75.filter(x => x.sig === k), A = xs.filter(x => day(x.t) < mid), B = xs.filter(x => day(x.t) >= mid);
  const t = k === "none" ? null : welchT(pc(xs), pc(noSig));
  console.log(`  ${({ none: "no decision", same: "for p75's side", opposite: "against p75's side" })[k].padEnd(18)} ${String(xs.length).padStart(6)}  ${(100 * xs.filter(x => x.won).length / xs.length).toFixed(1).padStart(5)}%  ${(xs.reduce((s, x) => s + x.price, 0) / xs.length).toFixed(3)}  ${c(per(xs)).padStart(8)}   ${c(per(A)).padStart(8)} / ${c(per(B)).padStart(8)}   ${k === "none" ? "" : `${c(per(xs) - per(noSig)).padStart(8)}  ${(t ?? NaN).toFixed(2).padStart(6)}`}`);
}
{
  const against = p75.filter(x => x.sig === "opposite"), rest = p75.filter(x => x.sig !== "opposite");
  console.log(`  against, vs every other p75 trade: ${c(per(against) - per(rest))}, t ${(welchT(pc(against), pc(rest)) ?? NaN).toFixed(2)}`);
  const pos = p75.filter(x => x.cls === "opposite"), posRest = p75.filter(x => x.cls !== "opposite");
  console.log(`  POSITION on the other side, vs every other p75 trade (the fixed hypothesis): ${c(per(pos) - per(posRest))}, t ${(welchT(pc(pos), pc(posRest)) ?? NaN).toFixed(2)}, ${pos.length} trades`);
}

const same = p75.filter(x => x.cls === "same");
console.log(`\nin the ${same.length} same-side windows: both won ${same.filter(x => x.won).length}, both lost ${same.filter(x => !x.won).length}; the two losses together averaged $${(same.filter(x => !x.won).reduce((s, x) => s + x.pnl + x.sharpPnl, 0) / Math.max(1, same.filter(x => !x.won).length)).toFixed(2)} a window`);
const opp = p75.filter(x => x.cls === "opposite");
console.log(`in the ${opp.length} opposite-side windows: the pair together made $${(opp.reduce((s, x) => s + x.pnl + x.sharpPnl, 0) / Math.max(1, opp.length)).toFixed(2)} a window on average (one side always loses)`);

function profile(label, keep, base = p75) {
  const kept = base.filter(keep), byDay = new Map(days.map(d => [d, 0])), byWin = new Map();
  for (const s of sharp) { byDay.set(day(s.t), byDay.get(day(s.t)) + s.pnl); byWin.set(s.ticker, s.pnl); }
  for (const p of kept) { byDay.set(day(p.t), (byDay.get(day(p.t)) || 0) + p.pnl); byWin.set(p.ticker, (byWin.get(p.ticker) || 0) + p.pnl); }
  const v = [...byDay.values()], n = v.length, mu = v.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / (n - 1));
  let cum = 0, pk = 0, dd = 0; for (const x of v) { cum += x; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); }
  const w = [...byWin.values()];
  const p75pnl = kept.reduce((s, x) => s + x.pnl, 0);
  console.log(`  ${label.padEnd(44)} p75 trades ${String(kept.length).padStart(4)} (${c(per(kept))}, $${(p75pnl / n).toFixed(2)}/day)  both: $${mu.toFixed(2).padStart(5)}/day  sd $${sd.toFixed(1).padStart(4)}  worst day $${Math.min(...v).toFixed(0).padStart(3)}  drawdown $${dd.toFixed(0).padStart(3)}  worst window $${Math.min(...w).toFixed(2)}  windows losing $10+: ${w.filter(x => x <= -10).length}`);
}
console.log(`\nboth rules together, ${SIZE} contracts each:`);
profile("no rule (both independent)", () => true);
profile("A: p75 skips sharp-move's SAME side", x => x.cls !== "same");
profile("B: p75 skips any sharp-move window", x => x.cls === "none");
profile("C: p75 skips sharp-move's OTHER side", x => x.cls !== "opposite");
const f = p75.filter(x => !x.filtered);
console.log(`\nthe same, with p75's two filters on (no 16-20h New York, no weekends):`);
profile("no rule", () => true, f);
profile("A: p75 skips sharp-move's SAME side", x => x.cls !== "same", f);
profile("B: p75 skips any sharp-move window", x => x.cls === "none", f);
profile("C: p75 skips sharp-move's OTHER side", x => x.cls !== "opposite", f);
// Sharp-move alone and p75 alone, and how their days move together.
const dS = new Map(days.map(d => [d, 0])), dP = new Map(days.map(d => [d, 0]));
for (const s of sharp) dS.set(day(s.t), dS.get(day(s.t)) + s.pnl);
for (const p of p75) dP.set(day(p.t), dP.get(day(p.t)) + p.pnl);
const a = days.map(d => dS.get(d)), b = days.map(d => dP.get(d)), m = x => x.reduce((s, v) => s + v, 0) / x.length;
const ma = m(a), mb = m(b), cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0), va = a.reduce((s, v) => s + (v - ma) ** 2, 0), vb = b.reduce((s, v) => s + (v - mb) ** 2, 0);
console.log(`\nalone: sharp-move $${ma.toFixed(2)}/day (sd $${Math.sqrt(va / (a.length - 1)).toFixed(1)}), p75 $${mb.toFixed(2)}/day (sd $${Math.sqrt(vb / (b.length - 1)).toFixed(1)}); correlation of their daily P&L ${(cov / Math.sqrt(va * vb)).toFixed(2)}`);
