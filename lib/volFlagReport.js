// The volatility flag's data and report (docs/research/vol-flag-plan.md),
// shared by scripts/vol-flag.mjs (p75, from the trade tape) and
// scripts/m15-index.mjs section D6 (sharp-move, from the recorded books),
// so both rules are scored by the same code. The maths is lib/volFlag.js.

import { returnsFromSettlements, scoreFlag, trailingVol, quantile } from "./volFlag.js";

// Every settled KXBTC15M window closing in [since, until) as 15-minute
// returns. The live tier filters by close time; the historical tier
// ignores those filters, so it is paged newest first until past `since`
// (as scripts/m15-tape-backtest.mjs does). get(path) -> parsed JSON.
export async function kxbtc15mReturns(get, since, until) {
  const cut = Date.parse((await get("/historical/cutoff")).market_settled_ts);
  const out = new Map();
  const keep = m => {
    const close = Date.parse(m.close_time);
    if (close >= since && close < until) out.set(m.ticker, m);
    return close;
  };
  if (until > cut) {
    let cursor = "";
    do {
      const d = await get(`/markets?series_ticker=KXBTC15M&status=settled&min_close_ts=${Math.floor(Math.max(since, cut - 86400000) / 1000)}&max_close_ts=${Math.floor(until / 1000)}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
      (d.markets || []).forEach(keep); cursor = d.cursor || "";
    } while (cursor);
  }
  if (since < cut) {
    let cursor = "", oldest = Infinity;
    do {
      const d = await get(`/historical/markets?series_ticker=KXBTC15M&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
      for (const m of d.markets || []) oldest = Math.min(oldest, keep(m));
      cursor = d.cursor || "";
    } while (cursor && oldest >= since);
  }
  return returnsFromSettlements([...out.values()]);
}

// The report for one rule: the plan's verdict (2-hour flag, top third by
// the train cutoff), then the train-tercile table and the 24-hour version,
// which are printed beside it and decide nothing. trades: [{ t, open,
// pnl, ctrs }] with ctrs > 0.
export function flagReport(label, trades, returns, split) {
  const c = v => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}c`);
  const tt = v => (v == null ? "—" : v.toFixed(2));
  const L = [];
  const r = scoreFlag(trades, returns, { split });
  const bp = v => (v == null ? "—" : `${(v * 1e4).toFixed(1)}bp`);
  L.push(`${label}: ${trades.length} trades, ${r.dropped} without 2h of history; split ${new Date(split).toISOString().slice(0, 10)}; cutoff (train top third) ${bp(r.cutoff)}`);
  L.push("   half    trades  flagged   all/ctr   unflagged/ctr  flagged/ctr   unflagged - flagged   t     flagged P&L");
  for (const [name, h] of [["train", r.train], ["test", r.test]]) {
    L.push(`   ${name.padEnd(6)} ${String(h.n).padStart(6)}  ${String(h.flagged).padStart(7)}  ${c(h.allPerCtr).padStart(8)}  ${c(h.unflaggedPerCtr).padStart(13)}  ${c(h.flaggedPerCtr).padStart(11)}  ${c(h.diff).padStart(20)}  ${tt(h.t).padStart(5)}   ${(h.flaggedPnl >= 0 ? "+$" : "-$") + Math.abs(h.flaggedPnl).toFixed(2)}`);
  }
  L.push(`   VERDICT (${label}): ${r.pass ? "PASS" : "FAIL"} — needs test t >= 2, skipping flagged to raise the test half, the train half to agree, and 50+ flagged test trades`);
  // Beside it: terciles by the train half's cutoffs, on the test half.
  const withVol = trades.map(x => ({ ...x, vol: trailingVol(returns, x.open, 8) })).filter(x => x.vol != null);
  const trainVols = withVol.filter(x => x.t < split).map(x => x.vol);
  const q1 = quantile(trainVols, 1 / 3), q2 = quantile(trainVols, 2 / 3);
  const test = withVol.filter(x => x.t >= split);
  const per = ys => { const k = ys.reduce((s, x) => s + x.ctrs, 0); return k ? ys.reduce((s, x) => s + x.pnl, 0) / k : null; };
  L.push(`   beside it, test half by train terciles of 2h vol: calm ${c(per(test.filter(x => x.vol < q1)))} (${test.filter(x => x.vol < q1).length}), middle ${c(per(test.filter(x => x.vol >= q1 && x.vol < q2)))} (${test.filter(x => x.vol >= q1 && x.vol < q2).length}), wild ${c(per(test.filter(x => x.vol >= q2)))} (${test.filter(x => x.vol >= q2).length})`);
  const d = scoreFlag(trades, returns, { split, n: 96 });
  L.push(`   beside it, the 24h version: test unflagged - flagged ${c(d.test.diff)}, t ${tt(d.test.t)}, ${d.test.flagged} flagged (would ${d.pass ? "pass" : "fail"}; decides nothing)`);
  return { result: r, lines: L };
}
