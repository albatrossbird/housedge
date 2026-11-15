// A volatility flag for the 15-minute rules (docs/research/vol-flag-plan.md).
//
// Bitcoin's realized volatility, from Kalshi's own KXBTC15M settlements: a
// window's floor_strike is the previous window's settlement average and its
// expiration_value is its own, so ln(expiration / floor) is a 15-minute
// return. A decision is flagged when the standard deviation of the last N
// returns settled before its window OPENED is at or above a cutoff, so
// every input is known before the window starts and the flag can run live.

// Settled markets -> [{ close (ms), ret (log return) }], sorted by close.
// A market without both prices is skipped, never guessed.
export function returnsFromSettlements(markets) {
  const out = [];
  for (const m of markets) {
    const f = Number(m.floor_strike), e = Number(m.expiration_value), close = typeof m.close === "number" ? m.close : Date.parse(m.close_time);
    if (f > 0 && e > 0 && Number.isFinite(close)) out.push({ close, ret: Math.log(e / f) });
  }
  return out.sort((a, b) => a.close - b.close);
}

// Standard deviation of the last n returns whose window closed at or
// before `asOf`. Null when fewer than n are available: a flag built on a
// short history is not the flag the plan fixed.
export function trailingVol(returns, asOf, n = 8) {
  let hi = returns.length;
  let lo = 0;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (returns[mid].close <= asOf) lo = mid + 1; else hi = mid; }
  if (lo < n) return null;
  const xs = returns.slice(lo - n, lo).map(r => r.ret);
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
}

// The p-th quantile (0..1) by nearest rank on the sorted values.
export function quantile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))];
}

// Welch's t for mean(a) - mean(b). Null when either side has under 2.
export function welchT(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const m = x => x.reduce((s, v) => s + v, 0) / x.length;
  const v = (x, mu) => x.reduce((s, y) => s + (y - mu) ** 2, 0) / (x.length - 1);
  const ma = m(a), mb = m(b), se = Math.sqrt(v(a, ma) / a.length + v(b, mb) / b.length);
  return se > 0 ? (ma - mb) / se : null;
}

// The plan's verdict for one rule. trades: [{ t, open, pnl, ctrs }], open
// = the window's open time (ms). Cutoff from the train trades' own
// trailing vols (the top third), frozen, then applied to the test half.
export function scoreFlag(trades, returns, { split, n = 8, q = 2 / 3, minFlagged = 50 } = {}) {
  const withVol = trades.map(x => ({ ...x, vol: trailingVol(returns, x.open, n), perCtr: x.ctrs ? x.pnl / x.ctrs : 0 }));
  const dropped = withVol.filter(x => x.vol == null).length;
  const usable = withVol.filter(x => x.vol != null);
  const train = usable.filter(x => x.t < split), test = usable.filter(x => x.t >= split);
  const cutoff = quantile(train.map(x => x.vol), q);
  const half = xs => {
    const fl = xs.filter(x => x.vol >= cutoff), un = xs.filter(x => x.vol < cutoff);
    const per = ys => { const c = ys.reduce((s, x) => s + x.ctrs, 0); return c ? ys.reduce((s, x) => s + x.pnl, 0) / c : null; };
    return {
      n: xs.length, flagged: fl.length, unflagged: un.length,
      allPerCtr: per(xs), flaggedPerCtr: per(fl), unflaggedPerCtr: per(un),
      diff: per(un) != null && per(fl) != null ? per(un) - per(fl) : null,
      t: welchT(un.map(x => x.perCtr), fl.map(x => x.perCtr)),
      flaggedPnl: fl.reduce((s, x) => s + x.pnl, 0), unflaggedPnl: un.reduce((s, x) => s + x.pnl, 0),
    };
  };
  const tr = half(train), te = half(test);
  const pass = cutoff != null && te.t != null && te.t >= 2 && te.unflaggedPerCtr > te.allPerCtr
    && tr.diff != null && tr.diff > 0 && te.flagged >= minFlagged;
  return { cutoff, dropped, train: tr, test: te, pass };
}
