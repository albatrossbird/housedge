// Kalshi's Liquidity Incentive Program, as its help page describes the
// scoring (read 2026-11-16; docs/research/mm-plan.md): what share of a
// market's pool a resting quote would score against the book as it stands.
//
// One SIDE is a stack of resting bids in its own prices: YES bids in YES
// prices, NO bids in NO prices (REST /markets/<t>/orderbook gives both,
// ascending). Per side:
//   - Reference Price: walking down from the best bid, the first level
//     where cumulative size reaches a fifth of Target Size.
//   - An order at or better than it scores its size; one further away
//     scores size x DiscountFactor ^ (ticks away).
//   - Our share of the side = our score / everyone's score.
// A snapshot counts only if Target Size rests on BOTH sides. The page does
// not say whether that is plain resting size or discounted score, so both
// readings are returned: `lenient` (plain size) and `strict` (score).

const r4 = n => Math.round(n * 1e4) / 1e4;

// levels: [[price, size], ...] in any order. -> { ref, score, size }
// ref is null when the side never holds a fifth of the target.
export function sideScore(levels, { target, discount, tick = 0.01 }) {
  const L = (levels || []).map(([p, s]) => [Number(p), Number(s)]).filter(([p, s]) => p > 0 && s > 0).sort((a, b) => b[0] - a[0]);
  let cum = 0, ref = null;
  for (const [p, s] of L) { cum += s; if (cum >= target / 5) { ref = p; break; } }
  let score = 0, size = 0;
  for (const [p, s] of L) {
    size += s;
    if (ref == null) continue;
    const ticks = Math.max(0, Math.round((ref - p) / tick));
    score += s * (ticks === 0 ? 1 : discount ** ticks);
  }
  return { ref, score, size };
}

// What a quote of `capital` dollars, split as S contracts a side resting at
// each side's Reference Price, would score in this book.
//   -> { S, cost, shareYes, shareNo, counts: { lenient, strict }, perDay: { lenient, strict }, why }
// perDay is the pool a day x (yes share + no share) / 2 when the snapshot
// counts WITH our orders added, else 0. `why` names what stops it.
export function quoteReward({ yes, no, target, discount, poolPerDay, capital = 200, tick = 0.01 }) {
  const y = sideScore(yes, { target, discount, tick }), n = sideScore(no, { target, discount, tick });
  const none = why => ({ S: 0, cost: 0, shareYes: 0, shareNo: 0, counts: { lenient: false, strict: false }, perDay: { lenient: 0, strict: 0 }, why, refYes: y.ref, refNo: n.ref });
  // With no reference on a side there is no price the page defines for us
  // to join; an empty or near-empty side is the usual reason (a market
  // priced at 1c or 99c has no room for bids on one side).
  if (y.ref == null || n.ref == null) return none(y.ref == null && n.ref == null ? "neither side holds a fifth of the target" : `${y.ref == null ? "yes" : "no"} side holds under a fifth of the target`);
  const S = Math.floor(capital / (y.ref + n.ref));
  if (S < 1) return none("capital buys under one contract a side");
  const shareYes = S / (y.score + S), shareNo = S / (n.score + S);
  const lenient = y.size + S >= target && n.size + S >= target;
  const strict = y.score + S >= target && n.score + S >= target;
  const pay = poolPerDay * (shareYes + shareNo) / 2;
  return {
    S, cost: r4(S * (y.ref + n.ref)), shareYes, shareNo, refYes: y.ref, refNo: n.ref,
    counts: { lenient, strict }, perDay: { lenient: lenient ? pay : 0, strict: strict ? pay : 0 },
    why: lenient ? null : "target size not resting on both sides",
  };
}

// A second way to quote: SUPPLY what a thin side is missing. Where a side
// holds under a fifth of the target there is no reference price to join,
// but an order of our own can make one: posted at that side's best bid (or,
// on an empty side, one tick under the other side's implied ask), sized so
// the side reaches Target Size. Bids on a thin side are often a few cents,
// so this can cost little, and whoever supplies the side scores most of it.
//
// Sizes: each side first gets what it needs to count (target minus what
// rests there, and at least a fifth of the target where we make the
// reference ourselves); what is left of `capital` is split evenly in
// contracts. Scores are recomputed WITH our orders in the book, so a
// reference price we move is handled.
//   -> the shape of quoteReward, plus priceYes/priceNo and sizeYes/sizeNo.
export function supplyReward({ yes, no, target, discount, poolPerDay, capital = 200, tick = 0.01 }) {
  const norm = L => (L || []).map(([p, s]) => [Number(p), Number(s)]).filter(([p, s]) => p > 0 && s > 0);
  const Y = norm(yes), N = norm(no);
  const best = L => L.length ? Math.max(...L.map(l => l[0])) : null;
  const y0 = sideScore(Y, { target, discount, tick }), n0 = sideScore(N, { target, discount, tick });
  const none = why => ({ S: 0, cost: 0, shareYes: 0, shareNo: 0, counts: { lenient: false, strict: false }, perDay: { lenient: 0, strict: 0 }, supplied: 0, why });
  // Where we would rest on each side.
  const priceFor = (own, other, s0) => {
    if (s0.ref != null) return s0.ref;
    if (own.length) return best(own);
    const o = best(other);
    const p = o == null ? null : r4(1 - o - tick);   // one tick under the implied ask
    return p != null && p >= tick ? p : null;
  };
  const py = priceFor(Y, N, y0), pn = priceFor(N, Y, n0);
  if (py == null || pn == null) return none(`${py == null ? "yes" : "no"} side has no price a bid could rest at`);
  const needFor = s0 => Math.max(0, Math.ceil(target - s0.size), s0.ref == null ? Math.ceil(target / 5) : 0);
  const ry = needFor(y0), rn = needFor(n0);
  const minCost = ry * py + rn * pn;
  if (minCost > capital) return none(`making it count costs $${minCost.toFixed(0)}, over the capital`);
  const extra = Math.floor((capital - minCost) / (py + pn));
  const sy = ry + extra, sn = rn + extra;
  if (sy < 1 || sn < 1) return none("capital buys under one contract a side");
  const y1 = sideScore([...Y, [py, sy]], { target, discount, tick }), n1 = sideScore([...N, [pn, sn]], { target, discount, tick });
  const mult = (p, ref) => { const t = Math.max(0, Math.round((ref - p) / tick)); return t === 0 ? 1 : discount ** t; };
  const shareYes = y1.ref == null ? 0 : sy * mult(py, y1.ref) / y1.score, shareNo = n1.ref == null ? 0 : sn * mult(pn, n1.ref) / n1.score;
  const lenient = y1.size >= target && n1.size >= target, strict = y1.score >= target && n1.score >= target;
  const pay = poolPerDay * (shareYes + shareNo) / 2;
  return {
    S: Math.min(sy, sn), sizeYes: sy, sizeNo: sn, priceYes: py, priceNo: pn, cost: r4(sy * py + sn * pn), shareYes, shareNo,
    counts: { lenient, strict }, perDay: { lenient: lenient ? pay : 0, strict: strict ? pay : 0 },
    supplied: (y0.ref == null ? 1 : 0) + (n0.ref == null ? 1 : 0), why: lenient ? null : "target size not resting on both sides",
  };
}

// A program's pool in dollars a day: period_reward is in centi-cents.
export function poolPerDay(p) {
  const days = (Date.parse(p.end_date) - Date.parse(p.start_date)) / 86400000;
  return days > 0 ? Number(p.period_reward) / 1e4 / days : 0;
}
