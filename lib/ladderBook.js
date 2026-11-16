// Ladder step 2, the analysis (docs/research/ladder-step2-plan.md): from
// one close's recorded lines, how long each contradiction lasted and what
// a bot at our latency would have caught.
//
// Input is the ladder recorder's archive lines for ONE close, in file
// order (scripts/ladder-stream.mjs): k:"mkt" (strike fields), k:"full"
// (a whole book), k:"d" (one change), k:"tr" (a trade), k:"gap".
// Prices are YES-leg dollars; the ask side is already in YES prices.
// Time is Kalshi's own ts_ms (`x`), never the box's receive time.
//
// A GAP: market X implies market Y (lib/ladder.js), so X's best YES bid
// should not exceed Y's best YES ask. When it does by more than both
// taker fees, buying NO on X and YES on Y pays at least $1.
//
// A QUALIFYING gap opens the first instant its edge is at least minEdge
// a contract after fees with at least minSize contracts at both touches,
// and closes when the edge is gone (<= 0). Its lifetime is the plan's
// early-stop measure.
//
// THE FILL REPLAY: at a qualifying open (t0) both legs are sent as
// immediate-or-cancel limits at the prices seen at t0. Each fills at
// t0 + L against the book as it stood then, up to the size asked. One
// order per book at a time: a gap whose leg is still in flight from an
// earlier attempt is not attempted, so the same contracts are not
// counted twice. It is still an upper bound: when we and the bot already
// there arrive together, the replay gives us the fill.

import { eventOf, implies } from "./ladder.js";

const K = p => Math.round(Number(p) * 10000);   // price -> 1/100 of a cent
const r2 = n => Math.round(n * 100) / 100;

function makeBook() {
  const bids = new Map(), asks = new Map();
  let ready = false, bestB = null, bestA = null;
  const scan = (m, hi) => { let x = null; for (const k of m.keys()) if (x == null || (hi ? k > x : k < x)) x = k; return x; };
  return {
    full(L) {
      bids.clear(); asks.clear();
      for (const [p, q] of L[0] || []) if (q > 0) bids.set(K(p), q);
      for (const [p, q] of L[1] || []) if (q > 0) asks.set(K(p), q);
      bestB = scan(bids, true); bestA = scan(asks, false); ready = true;
    },
    delta(sd, p, q) {
      if (!ready) return;
      const isBid = sd === "b", side = isBid ? bids : asks, k = K(p), n = r2((side.get(k) || 0) + q);
      if (n > 0) {
        side.set(k, n);
        if (isBid) { if (bestB == null || k > bestB) bestB = k; } else if (bestA == null || k < bestA) bestA = k;
      } else {
        side.delete(k);
        if (isBid) { if (k === bestB) bestB = scan(bids, true); } else if (k === bestA) bestA = scan(asks, false);
      }
    },
    distrust() { ready = false; bestB = bestA = null; },
    get ready() { return ready; },
    get bid() { return ready && bestB != null ? bestB : null; },
    get ask() { return ready && bestA != null ? bestA : null; },
    bidSize() { return bestB == null ? 0 : bids.get(bestB) || 0; },
    askSize() { return bestA == null ? 0 : asks.get(bestA) || 0; },
    // Selling YES into the bids at `limit` or better (which is buying NO at
    // 1 - price): contracts and proceeds, best price first, up to `size`.
    hitBids(limit, size) {
      if (!ready) return { n: 0, sum: 0 };
      let n = 0, sum = 0;
      for (const k of [...bids.keys()].filter(k => k >= limit).sort((a, b) => b - a)) {
        const take = Math.min(size - n, bids.get(k)); n += take; sum += take * k / 10000;
        if (n >= size - 1e-9) break;
      }
      return { n: r2(n), sum };
    },
    // Buying YES from the asks at `limit` or better.
    liftAsks(limit, size) {
      if (!ready) return { n: 0, sum: 0 };
      let n = 0, sum = 0;
      for (const k of [...asks.keys()].filter(k => k <= limit).sort((a, b) => a - b)) {
        const take = Math.min(size - n, asks.get(k)); n += take; sum += take * k / 10000;
        if (n >= size - 1e-9) break;
      }
      return { n: r2(n), sum };
    },
  };
}

const lowerBound = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };

// lines: one close's archive lines, file order.
// fee(price, contracts) -> dollars for one taker order.
// results: Map ticker -> "yes" | "no" (for one-legged fills held to
// settlement); a missing result prices the held leg as null.
export function analyzeClose(lines, { fee, results = new Map(), sizes = [40, 10], delays = [0, 25, 50, 100, 250], minEdge = 0.01, minSize = 10, tradeSlackMs = 2, busyMs = 250 } = {}) {
  // Markets, their events, and who implies whom.
  const mk = new Map();
  for (const l of lines) if (l.k === "mkt" && !mk.has(l.m)) {
    const ev = eventOf({ strike_type: l.type, floor_strike: l.floor, cap_strike: l.cap, custom_strike: l.custom });
    if (ev) mk.set(l.m, { ticker: l.m, ev, close: Date.parse(l.close), book: makeBook(), pairs: [], busyNo: -Infinity, busyYes: -Infinity });
  }
  if (!mk.size) return { close: null, markets: 0, pairs: 0, episodes: [], counts: { events: 0, untrusted: 0, afterClose: 0, attempts: 0, skippedBusy: 0 } };
  const close = Math.min(...[...mk.values()].map(m => m.close).filter(Number.isFinite));
  const pairs = [];
  for (const x of mk.values()) for (const y of mk.values()) {
    if (x !== y && implies(x.ev, y.ev)) { const p = { x, y, open: null }; pairs.push(p); x.pairs.push(p); y.pairs.push(p); }
  }
  // Trade times per market, to say what closed a gap.
  const trades = new Map();
  for (const l of lines) if (l.k === "tr" && Number.isFinite(l.x)) { if (!trades.has(l.m)) trades.set(l.m, []); trades.get(l.m).push(l.x); }
  for (const a of trades.values()) a.sort((p, q) => p - q);
  const tradedNear = (m, t) => { const a = trades.get(m); if (!a) return false; const i = lowerBound(a, t - tradeSlackMs); return i < a.length && a[i] <= t + tradeSlackMs; };

  const feeAt = (noPrice, yesPrice) => fee(noPrice, 1) + fee(yesPrice, 1);
  const episodes = [], probes = [];   // probes: { at, fn }, kept sorted by `at` (offsets are fixed, so near-sorted)
  const counts = { events: 0, untrusted: 0, afterClose: 0, attempts: 0, skippedBusy: 0 };
  const pushProbe = (at, fn) => { let i = probes.length; while (i > 0 && probes[i - 1].at > at) i--; probes.splice(i, 0, { at, fn }); };
  const runProbes = upTo => { while (probes.length && probes[0].at < upTo) probes.shift().fn(); };

  function attempt(ep, p, now) {
    const X = p.x, Y = p.y;
    if (X.busyNo > now || Y.busyYes > now) { counts.skippedBusy++; ep.attempted = false; return; }
    X.busyNo = Y.busyYes = now + busyMs;
    counts.attempts++; ep.attempted = true; ep.fills = {};
    const limBid = X.book.bid, limAsk = Y.book.ask;
    for (const L of delays) for (const size of sizes) {
      pushProbe(now + L, () => {
        const fx = X.book.hitBids(limBid, size), fy = Y.book.liftAsks(limAsk, size);
        const noCost = fx.n - fx.sum, yesCost = fy.sum;                 // dollars paid on each leg
        const feeX = fx.n ? fee(noCost / fx.n, fx.n) : 0, feeY = fy.n ? fee(yesCost / fy.n, fy.n) : 0;
        const m = Math.min(fx.n, fy.n);
        const locked = m > 0 ? m * (1 - noCost / fx.n - yesCost / fy.n) : 0;
        const e = r2(Math.abs(fx.n - fy.n)), legNo = fx.n > fy.n;
        const cz = e > 0 ? (legNo ? noCost / fx.n : yesCost / fy.n) : 0;
        const f = { fx: fx.n, fy: fy.n, matched: m, excess: e, leg: e > 0 ? (legNo ? "no" : "yes") : null, base: locked - feeX - feeY, unwound: null, held: null };
        ep.fills[`${L}/${size}`] = f;
        if (e <= 0) { f.unwound = f.held = f.base; return; }
        const res = results.get(legNo ? X.ticker : Y.ticker);
        const wins = res == null ? null : legNo ? res === "no" : res === "yes";
        f.held = wins == null ? null : f.base + e * ((wins ? 1 : 0) - cz);
        // Unwind at t0 + 2L: sell the excess back at the bid for that side.
        pushProbe(now + 2 * L, () => {
          // Selling NO on X = lifting X's YES asks (NO bid = 1 - YES ask);
          // selling YES on Y = hitting Y's YES bids.
          const u = legNo ? X.book.liftAsks(Infinity, e) : Y.book.hitBids(-Infinity, e);
          const got = legNo ? u.n - u.sum : u.sum;                      // dollars received
          const feeU = u.n ? fee(got / u.n, u.n) : 0;
          const rest = r2(e - u.n);                                     // could not be sold: held
          const restVal = rest > 0 ? (wins == null ? null : rest * (wins ? 1 : 0)) : 0;
          f.unwound = restVal == null ? null : f.base + got - feeU + restVal - e * cz;
        });
      });
    }
  }

  function evaluate(p, now) {
    const X = p.x, Y = p.y, b = X.book.bid, a = Y.book.ask;
    const known = b != null && a != null;
    // A bid at or under the ask is no gap whatever the fees: skip the fee maths.
    const edge = !known ? null : b <= a ? -1 : (b - a) / 10000 - feeAt(1 - b / 10000, a / 10000);
    if (!p.open) {
      if (known && edge >= minEdge && X.book.bidSize() >= minSize && Y.book.askSize() >= minSize) {
        p.open = { x: X.ticker, y: Y.ticker, t0: now, edge0: edge, maxEdge: edge, bid: b / 10000, ask: a / 10000, sizeX: X.book.bidSize(), sizeY: Y.book.askSize(), toClose: (close - now) / 1000 };
        attempt(p.open, p, now);
      }
      return;
    }
    if (known && edge > 0) { if (edge > p.open.maxEdge) p.open.maxEdge = edge; return; }
    const ep = p.open; p.open = null;
    ep.t1 = now; ep.ms = now - ep.t0;
    ep.cause = !known ? "unknown" : (tradedNear(X.ticker, now) || tradedNear(Y.ticker, now)) ? "trade" : "quote";
    episodes.push(ep);
  }

  let clock = -Infinity;
  for (const l of lines) {
    if (l.k !== "full" && l.k !== "d" && l.k !== "gap") continue;
    const now = Math.max(clock, Number.isFinite(l.x) ? l.x : (l.k === "gap" ? clock : l.t));
    if (now > close) { counts.afterClose++; continue; }
    runProbes(now); clock = now; counts.events++;
    if (l.k === "gap") {
      for (const t of l.m || []) { const m = mk.get(t); if (!m) continue; m.book.distrust(); counts.untrusted++; for (const p of m.pairs) evaluate(p, now); }
      continue;
    }
    const m = mk.get(l.m);
    if (!m) continue;
    const b0 = m.book.bid, a0 = m.book.ask, bs0 = m.book.bidSize(), as0 = m.book.askSize();
    if (l.k === "full") m.book.full(l.L); else m.book.delta(l.sd, l.p, l.q);
    // Only a change at the touch can open, close or resize a gap.
    if (m.book.bid !== b0 || m.book.ask !== a0 || m.book.bidSize() !== bs0 || m.book.askSize() !== as0) for (const p of m.pairs) evaluate(p, now);
  }
  runProbes(Infinity);
  // Whatever is still open at the close ends there.
  for (const p of pairs) if (p.open) { const ep = p.open; p.open = null; ep.t1 = close; ep.ms = close - ep.t0; ep.cause = "close"; episodes.push(ep); }
  return { close, markets: mk.size, pairs: pairs.length, episodes, counts };
}

// Roll episodes up: lifetimes, what closed them, and the fill replay by
// delay and size. Dollars; `unwound` and `held` are null if any leg's
// settlement was unknown.
export function summarize(episodes, { sizes = [40, 10], delays = [0, 25, 50, 100, 250] } = {}) {
  const life = episodes.map(e => e.ms).sort((a, b) => a - b);
  const q = p => life.length ? life[Math.min(life.length - 1, Math.floor(p * life.length))] : null;
  const by = k => { const o = {}; for (const e of episodes) o[e[k]] = (o[e[k]] || 0) + 1; return o; };
  const capture = {};
  for (const L of delays) for (const size of sizes) {
    const c = { attempts: 0, both: 0, legged: 0, nothing: 0, unwound: 0, held: 0, unknown: 0 };
    for (const e of episodes) {
      const f = e.fills?.[`${L}/${size}`];
      if (!f) continue;
      c.attempts++;
      if (f.fx === 0 && f.fy === 0) c.nothing++; else if (f.excess > 0) c.legged++; else c.both++;
      if (f.unwound == null || f.held == null) c.unknown++; else { c.unwound += f.unwound; c.held += f.held; }
    }
    capture[`${L}/${size}`] = c;
  }
  return { n: episodes.length, p10: q(0.1), p50: q(0.5), p90: q(0.9), under50: life.filter(x => x < 50).length, cause: by("cause"), capture };
}
