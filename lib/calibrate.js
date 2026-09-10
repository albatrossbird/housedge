// The pure half of the 15-minute calibration: picking the sample,
// bucketing it, and pricing the trade. No IO, so it can be tested.
//
// scripts/m15-calibrate.mjs does the reading and the printing; this
// does the arithmetic that decides whether a strategy has an edge.

// contracts x 0.07 x multiplier x p(1-p). Settlement is free on
// Kalshi, so a hold-to-expiry trade pays this ONCE, on entry.
export function feeOf(p, mult) {
  return 0.07 * mult * p * (1 - p);
}

// ONE quote per ticker: the one nearest the target moment.
//
// This is the correctness of the whole analysis. m15_quotes is
// write-on-change, so a market whose price chopped around in the entry
// window wrote many rows and a quiet one wrote one. Counting ROWS
// weights the sample toward volatile markets — precisely the ones
// likeliest to settle against their quote — and manufactures a
// calibration gap out of nothing.
//
// Ties go to the EARLIER row, so the choice is deterministic rather
// than dependent on the order the pager happened to return.
export function pickOnePerTicker(rows, target, { known = null } = {}) {
  const best = new Map();
  for (const r of rows) {
    if (known && !known.has(r.ticker)) continue;
    // Number(null) is 0 and 0 is finite, so isFinite alone would read a
    // MISSING seconds-to-close as a quote sitting at the closing bell.
    // The same coercion that once mirrored an absent book into a
    // {bid: 1, ask: 1} quote — guard the value, not just its type.
    if (r.secs_to_close == null || r.secs_to_close === "") continue;
    const secs = Number(r.secs_to_close);
    if (!isFinite(secs)) continue;
    const d = Math.abs(secs - target);
    const cur = best.get(r.ticker);
    if (!cur || d < cur.d) best.set(r.ticker, { d, row: r });
  }
  return [...best.values()].map(v => v.row);
}

// A buyer pays the ASK, so calibration is asked of the ask, never the
// midpoint — a midpoint gap reads as an edge that nobody can take.
export function bucketize(obs, resultOf, { width = 0.05 } = {}) {
  const buckets = new Map();
  for (const r of obs) {
    const a = Number(r.yes_ask);
    if (!isFinite(a) || a <= 0 || a >= 1) continue;
    const b = Math.round(Math.floor(a / width) * width * 100) / 100;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push({ a, yes: resultOf.get(r.ticker) === "yes" });
  }
  return [...buckets.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([lo, rows]) => {
      const n = rows.length;
      const avgAsk = rows.reduce((s, r) => s + r.a, 0) / n;
      const hit = rows.filter(r => r.yes).length / n;
      return { lo, hi: lo + width, n, avgAsk, hit, gap: hit - avgAsk };
    });
}

// The strategy as specified: buy whichever side sits in [lo, hi] with a
// tight enough spread, hold to settlement.
//
// The NO ask is 1 - yes_bid. Kalshi runs a genuinely separate NO book,
// but the recorder stores only the YES side, and taking NO at its ask
// is the same trade as selling YES at the bid.
//
// YES is tested first and a market can only enter once, so the two
// sides cannot both fire on one quote — with lo >= 0.5 they are
// mutually exclusive anyway, but the guard keeps that true if someone
// widens the band.
export function simulate(obs, resultOf, { lo, hi, maxSpread, mult }) {
  let n = 0, wins = 0, gross = 0, net = 0;
  const sides = { yes: 0, no: 0 };
  const entries = [];

  for (const r of obs) {
    const bid = Number(r.yes_bid), ask = Number(r.yes_ask);
    // A missing side is UNKNOWN, not zero. Number(null) is 0 and a
    // fabricated zero here would read as a free option.
    if (!isFinite(bid) || !isFinite(ask)) continue;
    if (ask - bid > maxSpread) continue;

    const res = resultOf.get(r.ticker);
    if (res !== "yes" && res !== "no") continue;

    let price = null, won = null;
    if (ask >= lo && ask <= hi) { price = ask; won = res === "yes"; sides.yes++; }
    else {
      const noAsk = 1 - bid;
      if (noAsk >= lo && noAsk <= hi) { price = noAsk; won = res === "no"; sides.no++; }
    }
    if (price == null) continue;

    const f = feeOf(price, mult);
    n++; if (won) wins++;
    gross += won ? (1 - price) : -price;
    net += won ? (1 - price - f) : -(price + f);
    entries.push(price);
  }

  if (!n) return { n: 0, sides, entries };
  const avgEntry = entries.reduce((a, b) => a + b, 0) / n;
  const winRate = wins / n;
  return {
    n, wins, sides, entries, avgEntry, winRate,
    breakeven: avgEntry + feeOf(avgEntry, mult),
    grossPer: gross / n,
    netPer: net / n,
    // A win rate is a fact about the entry price, not about skill. Only
    // this, net of fees, is a finding.
    edgeOverPrice: winRate - avgEntry,
    se: Math.sqrt(winRate * (1 - winRate) / n),
  };
}
