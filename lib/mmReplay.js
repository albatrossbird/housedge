// Market-making study, Part B (docs/research/mm-plan.md): replay a resting
// two-sided quote against one market's tape.
//
// The quote rests each minute at the last one-minute candle's closing bid
// and ask (carried forward through minutes with no candle) and is re-posted
// at the start of every minute. No queue is published, so fills are
// bracketed:
//   front: a taker trade AT or through our price fills us, up to what is posted;
//   back:  only a trade strictly THROUGH our price does.
// Either way the fill is at OUR price: a seller who printed under our bid
// would have hit our bid first.
//
// Position cap: the net position never exceeds the quote's size on either
// side. A side that is full posts nothing until the other side trades it
// down. Without that, a fixed amount of capital is fiction.
//
// Nothing here fetches or places anything.

const r4 = n => Math.round(n * 1e4) / 1e4;
const EPS = 1e-9;

// quotes: [[tMs, bid|null, ask|null], ...] ascending (candle closes).
// trades: [{ t, price (YES price), count, taker: "yes"|"no" }, ...] ascending.
//   taker "no" sold YES into the bids; taker "yes" bought YES from the asks.
// poolRate(tMs) -> dollars of reward pool per MINUTE at that time.
// fee(price, contracts) -> dollars a resting fill costs (maker fee).
// boundary: optional ms; P&L and reward are split before / from it.
// settle: 1 or 0 where the market settled by `to`, else null.
// budgetYes / budgetNo: when given, the cap is in DOLLARS rather than
// contracts. A side posts what its budget buys at today's price, less what
// its unpaired holding has already cost (average cost; Kalshi nets YES
// against NO, so a fill on the other side closes a position rather than
// pairing it), plus whatever would close the other side's holding. Without
// it, a size fixed at one price puts many times the budget at risk once
// the price moves. sizeYes / sizeNo stay the size the share was measured
// at: the reward credits min(1, posted / that size) of the share.
// quoteWhen(tMs) -> false for a minute in which nothing is posted (no
// program paying); inventory is still held and marked.
export function replay({ quotes, trades, from, to, sizeYes, sizeNo, budgetYes = null, budgetNo = null, shareYes = 0, shareNo = 0, mode = "back", fee = () => 0, poolRate = () => 0, quoteWhen = () => true, supplyEmpty = false, boundary = null, settle = null, tick = 0.01, marks = [60e3, 600e3, 3600e3] }) {
  if (mode !== "front" && mode !== "back") throw new Error(`mode ${mode}`);
  let yes = 0, no = 0, cash = 0, reward = 0, fees = 0, maxCost = 0;
  let qi = -1, ti = 0, quoted = 0, fillsN = 0, contracts = 0, basis = 0;
  let split = null;
  const fills = [];
  const book = i => {
    const q = i >= 0 ? quotes[i] : null;
    let bid = q && q[1] > 0 ? q[1] : null, ask = q && q[2] != null && q[2] < 1 ? q[2] : null;
    if (bid != null && ask != null && bid >= ask - EPS) bid = ask = null;   // a crossed candle is not a quote
    return { bid, ask };
  };
  // Inventory at a moment: pairs are worth $1; what is left over is sold at
  // the touch (long YES at the bid, long NO at one minus the ask), never the mid.
  const equity = i => {
    const { bid, ask } = book(i), net = yes - no;
    return cash + Math.min(yes, no) + (net > 0 ? net * (bid ?? 0) : -net * (1 - (ask ?? 1)));
  };
  while (ti < trades.length && trades[ti].t < from) ti++;
  for (let m = from; m < to; m += 60000) {
    while (qi + 1 < quotes.length && quotes[qi + 1][0] <= m) qi++;
    if (boundary != null && split == null && m >= boundary) split = { pnl: equity(qi), reward, quoted };
    const { bid, ask } = book(qi), end = Math.min(m + 60000, to);
    const yb = bid ?? (supplyEmpty && ask != null && ask - tick >= tick - EPS ? r4(ask - tick) : null);
    const ya = ask ?? (supplyEmpty && bid != null && bid + tick <= 1 - tick + EPS ? r4(bid + tick) : null);
    const net = yes - no, on = quoteWhen(m);
    let py, pn;
    if (budgetYes == null) {
      py = on && yb != null ? Math.max(0, Math.min(sizeYes, sizeYes - net)) : 0;
      pn = on && ya != null ? Math.max(0, Math.min(sizeNo, sizeNo + net)) : 0;
    } else {
      const fresh = (budget, used, price) => Math.max(0, Math.floor((budget - used) / price + EPS));
      py = on && yb != null ? (net >= 0 ? fresh(budgetYes, basis, yb) : -net + fresh(budgetYes, 0, yb)) : 0;
      pn = on && ya != null ? (net <= 0 ? fresh(budgetNo, basis, 1 - ya) : net + fresh(budgetNo, 0, 1 - ya)) : 0;
    }
    const credit = (posted, size) => posted > 0 ? Math.min(1, posted / size) : 0;
    if (on && (bid != null || ask != null)) quoted++;
    if (on && yb != null && ya != null) reward += poolRate(m) * (shareYes * credit(py, sizeYes) + shareNo * credit(pn, sizeNo)) / 2;
    for (; ti < trades.length && trades[ti].t < end; ti++) {
      const x = trades[ti];
      if (x.taker === "no" && py > 0 && (mode === "front" ? x.price <= yb + EPS : x.price < yb - EPS)) {
        const q = Math.min(py, x.count), f = fee(yb, q);
        basis = moveBasis(basis, yes - no, q, yb);
        py -= q; yes += q; cash -= yb * q + f; fees += f; fillsN++; contracts += q;
        fills.push({ t: x.t, side: "yes", price: yb, q });
      } else if (x.taker === "yes" && pn > 0 && (mode === "front" ? x.price >= ya - EPS : x.price > ya + EPS)) {
        const q = Math.min(pn, x.count), f = fee(1 - ya, q);
        basis = moveBasis(basis, no - yes, q, 1 - ya);
        pn -= q; no += q; cash -= (1 - ya) * q + f; fees += f; fillsN++; contracts += q;
        fills.push({ t: x.t, side: "no", price: ya, q });
      }
      maxCost = Math.max(maxCost, -cash - Math.min(yes, no));
    }
  }
  while (qi + 1 < quotes.length && quotes[qi + 1][0] <= to) qi++;
  const pnl = settle == null ? equity(qi) : cash + yes * settle + no * (1 - settle);
  if (boundary != null && split == null) split = to <= boundary ? { pnl, reward, quoted } : { pnl: 0, reward: 0, quoted: 0 };

  // Diagnosis only: each fill against the mid when it filled and 1, 10 and
  // 60 minutes later, per contract, signed so that positive is good for us.
  const midAt = t => {
    let lo = 0, hi = quotes.length - 1, at = -1;
    while (lo <= hi) { const k = (lo + hi) >> 1; if (quotes[k][0] <= t) { at = k; lo = k + 1; } else hi = k - 1; }
    const { bid, ask } = book(at);
    return bid != null && ask != null ? (bid + ask) / 2 : null;
  };
  const vs = [0, ...marks].map(() => ({ sum: 0, q: 0 }));
  for (const f of fills) [0, ...marks].forEach((d, k) => {
    const mid = midAt(f.t + d);
    if (mid == null) return;
    vs[k].sum += (f.side === "yes" ? mid - f.price : f.price - mid) * f.q; vs[k].q += f.q;
  });
  return {
    fills: fillsN, contracts, yes, no, fees, pnl, reward, quoted, maxCost,
    week: boundary == null ? null : [{ pnl: split.pnl, reward: split.reward, quoted: split.quoted }, { pnl: pnl - split.pnl, reward: reward - split.reward, quoted: quoted - split.quoted }],
    vsMid: vs,
  };
}

// What the unpaired holding has cost, after buying q more of one side at
// `price`, where `own` is the holding on that side before (negative = the
// other side is held). Closing the other side's holding releases its cost
// in proportion; anything past zero opens a holding at this price.
export function moveBasis(basis, own, q, price) {
  if (own >= 0) return basis + q * price;
  const close = Math.min(q, -own), left = basis * (1 - close / -own);
  return q > close ? (q - close) * price : left;
}

// A repeatable draw: FNV-1a of the ticker. Sorting by it is the "random"
// order the plan's samples are taken in.
export function tickerHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

// Dollars of pool per minute at t for one market's programs.
export function poolRateFor(programs) {
  const P = (programs || []).map(p => ({ a: Date.parse(p.start_date), b: Date.parse(p.end_date), r: Number(p.period_reward) / 1e4 })).filter(p => p.b > p.a && p.r > 0).map(p => ({ ...p, perMin: p.r / ((p.b - p.a) / 60000) }));
  return t => { let s = 0; for (const p of P) if (t >= p.a && t < p.b) s += p.perMin; return s; };
}
