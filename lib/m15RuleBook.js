// A RULE FILE run against the recorded 15-minute markets: a loop that,
// every `interval` seconds, reads the market and the underlying, walks an
// ordered list of rules, and buys, sells everything, or does nothing. The
// format is the one in strategies/*.json:
//   market.series_ticker, risk { max_position, price_floor, price_ceiling },
//   loop.interval, edge.btc.fields, rules [{ name, when: { all: [cond] },
//   action: skip | sell_all | buy_yes | buy_no, size }]
//   cond: { field, op: > >= < <= == !=, value | value_field }
//
// Pure: scripts/m15-rulebook-backtest.mjs reads the archive and prints.
//
// WHAT A FIELD MEANS. The files give names, not definitions, so these are
// choices, stated once and applied everywhere:
//   price           the YES mid, (bid + ask) / 2. A `buy_no` rule reading
//                   `price <= 0.12` buys NO when YES is at 12c, so price is
//                   YES's, not the side about to be bought.
//   spread          ask - bid
//   time_to_expiry  seconds to the close; "5m" / "30s" in a file
//   position_size   contracts held, either side
//   unrealized_pnl  dollars: what the position would fetch at the touch
//                   now (YES at the bid, NO at 1 - ask) minus what it
//                   cost, fees excluded. `mark: "mid"` values at the mid.
//   unrealized_pnl_per_contract
//                   the same divided by position_size; null when flat. A
//                   dollar threshold means a different trade at every
//                   size ($8 is 26.7c a contract at 30, 4c at 200); this
//                   one does not.
//   edge.btc.*      lib/btcSignals.js, built with no lookahead
// An unknown field, op or action THROWS when the file is compiled: a
// condition the engine cannot read must not quietly read as false.
//
// HOW RULES FIRE. In order, and the FIRST rule whose conditions all hold
// acts (`skip` acts by doing nothing) — so the profit and loss exits,
// listed first, pre-empt entries. `mode: "all"` lets every matching rule
// act instead, for files written that way. A condition on a null value
// does not hold.
//
// HOW ORDERS FILL. Kalshi's book is walked level by level (the archive
// keeps the top ten each side, once a second), as a taker:
//   buy YES   lifts YES offers, cheapest first, none above price_ceiling
//   buy NO    hits YES bids at 1 - p, so the same NO cost cap applies
//   sell YES  hits YES bids, none below price_floor
//   sell NO   lifts YES offers, receiving 1 - p
// What the ten levels cannot fill does not fill. A buy of the opposite
// side first CLOSES what is held — Kalshi nets YES against NO in one
// market — and only the remainder opens. max_position caps what is held.
// Kalshi's taker fee is charged per order, 0.07 x multiplier x sum of
// q x p x (1-p), rounded up to the cent. `latencyMs` fills against the
// book that many ms after the decision; nothing fills at or after the
// close. Settlement pays $1 a contract on the winning side.
//
// RESTING ENTRIES (`entry: "maker"`). A buy rule posts one resting order
// at the touch instead of crossing: a YES bid at the bid, or for NO a YES
// offer at the ask (a NO bid at 1 - ask). It goes live `latencyMs` after
// the decision and is filled only by the TRADE TAPE: takers selling YES
// at or through our bid fill a YES bid, takers buying YES at or through
// our offer fill a NO bid. `queue: "join"` puts it behind everything
// resting at that price when it was posted, so only trades beyond that
// queue reach it; `"front"` puts it first. A trade THROUGH our price
// means the level was cleared and fills what is left. While the acting
// rule keeps buying the same side the order stays (re-pegged, losing its
// place, if the touch moved); anything else cancels it, so an order never
// outlives the signal that placed it. Makers pay the series' maker fee
// (zero on quadratic series). Exits stay taker orders: a stop has to get
// out, not wait.
//
// `fill: "mid"` is the OPTIMISTIC bound instead: every order fills in full
// at the mid with no fee — what a simulator that ignores the book and the
// fee would report. It exists to explain a gap, never to be believed.
//
// WHAT A FILL COST. Every taker fill also records `slip`: what it paid
// beyond the mid of the book it filled against (a sell, what it received
// short of it). So a window's P&L splits exactly into the outcome at the
// mid, the spread and depth paid, and the fee, on the SAME trades — where
// comparing against the "mid, no fees" run compares different trades.
//
// TWO VENUES (runWindowBoth). Polymarket US lists the same 15-minute
// Bitcoin market (lib/pmus15.js), so the same file can run on its book
// (runWindow with `feeFn: pmusOrderFee`) or on both: decided on Kalshi's
// book, each buy walks BOTH ladders cheapest all-in first, a .us level
// used only from a book at most `usFreshMs` old; contracts are held on
// the venue that bought them and sold there. A .us holding that cannot
// be sold for want of a .us book stays held — to settlement if need be.

import { pmusTakerFee, PMUS_FEE_COEF } from "./venueCompare.js";

const OPS = {
  ">": (a, b) => a > b, ">=": (a, b) => a >= b, "<": (a, b) => a < b,
  "<=": (a, b) => a <= b, "==": (a, b) => a === b, "!=": (a, b) => a !== b,
};
const ACTIONS = new Set(["skip", "sell_all", "buy_yes", "buy_no"]);
const BASE_FIELDS = new Set(["price", "spread", "time_to_expiry", "position_size", "unrealized_pnl", "unrealized_pnl_per_contract"]);
const KALSHI_RATE = 0.07;

export function parseDuration(v) {
  if (typeof v === "number") return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h)?\s*$/.exec(String(v));
  if (!m) throw new Error(`cannot read "${v}" as a duration`);
  return Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2] || "s"]);
}

export function compileRuleBook(cfg) {
  if (!cfg || !Array.isArray(cfg.rules) || !cfg.rules.length) throw new Error("rule file has no rules");
  const edgeFields = new Set((cfg.edge?.btc?.fields || []).map(f => `edge.btc.${f}`));
  const known = f => BASE_FIELDS.has(f) || edgeFields.has(f);
  const rules = cfg.rules.map((r, i) => {
    const where = `rule ${i + 1} (${r.name || "unnamed"})`;
    if (!ACTIONS.has(r.action)) throw new Error(`${where}: unknown action "${r.action}"`);
    const all = r.when?.all;
    if (!Array.isArray(all) || !all.length) throw new Error(`${where}: needs when.all with at least one condition`);
    const conds = all.map((c, j) => {
      if (!known(c.field)) throw new Error(`${where}, condition ${j + 1}: unknown field "${c.field}"`);
      if (!OPS[c.op]) throw new Error(`${where}, condition ${j + 1}: unknown op "${c.op}"`);
      if (c.value_field != null) {
        if (!known(c.value_field)) throw new Error(`${where}, condition ${j + 1}: unknown value_field "${c.value_field}"`);
        return { field: c.field, op: c.op, valueField: c.value_field };
      }
      if (c.value == null) throw new Error(`${where}, condition ${j + 1}: needs value or value_field`);
      const value = c.field === "time_to_expiry" ? parseDuration(c.value) : Number(c.value);
      if (!Number.isFinite(value)) throw new Error(`${where}, condition ${j + 1}: value "${c.value}" is not a number`);
      return { field: c.field, op: c.op, value };
    });
    const size = r.action.startsWith("buy_") ? Number(r.size) : null;
    if (r.action.startsWith("buy_") && !(Number.isInteger(size) && size > 0)) throw new Error(`${where}: a buy needs a positive whole size`);
    return { name: r.name || `rule${i + 1}`, conds, action: r.action, size };
  });
  return {
    name: cfg.strategy_name || "rulebook",
    series: cfg.market?.series_ticker || null,
    interval: Number(cfg.loop?.interval ?? 10),
    maxPosition: Number(cfg.risk?.max_position ?? Infinity),
    priceFloor: Number(cfg.risk?.price_floor ?? 0.01),
    priceCeiling: Number(cfg.risk?.price_ceiling ?? 0.99),
    rules,
  };
}

// The rules that act on this context: the first that matches, or every
// match with mode "all". `skip` stops the walk in both modes.
export function matchRules(book, ctx, mode = "first") {
  const hit = [];
  for (const r of book.rules) {
    const ok = r.conds.every(c => {
      const a = ctx[c.field], b = c.valueField != null ? ctx[c.valueField] : c.value;
      return a != null && b != null && Number.isFinite(a) && Number.isFinite(b) && OPS[c.op](a, b);
    });
    if (!ok) continue;
    if (r.action === "skip") return hit.length ? hit : [r];
    hit.push(r);
    if (mode === "first") return hit;
  }
  return hit;
}

export function kalshiOrderFee(fills, mult = 1) {
  const raw = fills.reduce((s, [p, q]) => s + KALSHI_RATE * mult * q * p * (1 - p), 0);
  return raw > 0 ? Math.ceil(raw * 100 - 1e-9) / 100 : 0;
}

// Polymarket US rounds each fill's fee half-even to the cent
// (lib/venueCompare.js), where Kalshi rounds the order's up.
export const pmusOrderFee = fills => fills.reduce((s, [p, q]) => s + pmusTakerFee(p, q), 0);

// Walk one side of a row's book for `qty` contracts.
//   kind "buy_yes" / "sell_no" take the offers; "buy_no" / "sell_yes" the bids.
// Returns { qty, cash, fills: [[yesPrice, q]] } where cash is what a buy
// costs or a sell brings in, on the traded side's own terms.
export function walk(row, kind, qty, { priceFloor = 0.01, priceCeiling = 0.99 } = {}) {
  const takeOffers = kind === "buy_yes" || kind === "sell_no";
  const levels = takeOffers ? row.asks : row.bids;
  let left = qty, got = 0, cash = 0;
  const fills = [];
  for (const [p, size] of levels || []) {
    if (left <= 0) break;
    const own = kind === "buy_yes" ? p : kind === "buy_no" ? 1 - p : kind === "sell_yes" ? p : 1 - p;   // price on the traded side
    if (kind.startsWith("buy") && own > priceCeiling + 1e-9) break;
    if (kind.startsWith("sell") && own < priceFloor - 1e-9) break;
    const n = Math.min(left, Math.floor(size + 1e-9));
    if (n <= 0) continue;
    got += n; left -= n; cash += n * own;
    fills.push([p, n]);
  }
  return { qty: got, cash, fills };
}

const mid = row => (row.bid + row.ask) / 2;
const r9 = x => Math.round(x * 1e9) / 1e9;

// The latest row at or before t (rows sorted by t), or null.
export function rowAt(rows, t) {
  let lo = 0, hi = rows.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m].t <= t) { i = m; lo = m + 1; } else hi = m - 1; }
  return i < 0 ? null : rows[i];
}

// One window. market: { ticker, close, result }. rows: its once-a-second
// books, { t, bid, ask, bids:[[p,q] best first], asks:[[p,q] best first] }.
// signalsAt(t): lib/btcSignals.js. Returns the window's result and every action.
export function runWindow(book, market, rows, signalsAt, opts = {}) {
  const { mode = "first", fill = "book", fees = true, mark = "touch", latencyMs = 0, mult = 1, staleMs = 12000, windowSecs = 900,
    entry = "taker", queue = "join", trades = [], makerFee = () => 0, feeFn = fills => kalshiOrderFee(fills, mult) } = opts;
  const MAKER = entry === "maker";
  const lim = { priceFloor: book.priceFloor, priceCeiling: book.priceCeiling };
  const open = market.close - windowSecs * 1000;
  let pos = 0, basis = 0, cash = 0, feesPaid = 0, slipPaid = 0, ticks = 0, staleTicks = 0, noSignal = 0;
  const actions = [];
  let opener = null;   // the rule that opened the position currently held

  const execute = (kind, qty, execRow) => {
    if (qty <= 0) return { qty: 0, cash: 0, fee: 0, slip: 0 };
    if (fill === "mid") {
      const p = mid(execRow), own = kind === "buy_yes" || kind === "sell_yes" ? p : 1 - p;
      return { qty, cash: qty * own, fee: 0, slip: 0 };
    }
    const w = walk(execRow, kind, qty, lim);
    return { qty: w.qty, cash: w.cash, fee: fees ? feeFn(w.fills) : 0, slip: slipOf(kind, w, execRow) };
  };
  // Close `qty` of what is held (pos > 0 YES, < 0 NO).
  const reduce = (qty, execRow) => {
    const held = Math.abs(pos);
    const r = execute(pos > 0 ? "sell_yes" : "sell_no", Math.min(qty, held), execRow);
    if (!r.qty) return r;
    basis -= basis * (r.qty / held);
    pos += pos > 0 ? -r.qty : r.qty;
    cash += r.cash - r.fee; feesPaid += r.fee; slipPaid += r.slip;
    if (!pos) { basis = 0; opener = null; }
    return r;
  };
  // A fill of `side` (+1 YES, -1 NO) at `own` a contract. Against an
  // opposite position it nets first: a YES and a NO in one market are a
  // pair worth $1, which Kalshi settles at once.
  const applyFill = (side, qty, own, fee, rule) => {
    let left = qty;
    if (pos && Math.sign(pos) !== side) {
      const held = Math.abs(pos), c = Math.min(left, held);
      basis -= basis * (c / held); pos += side * c; cash += c; left -= c;
      if (!pos) { basis = 0; opener = null; }
    }
    cash -= qty * own + fee; feesPaid += fee;
    if (left > 0) { if (!pos) opener = rule; pos += side * left; basis += left * own; }
  };
  let resting = null, ti = 0;
  let postedContracts = 0, makerFilled = 0;
  // Feed the tape up to `upTo` to the resting order.
  const consume = upTo => {
    while (ti < trades.length && trades[ti].x <= upTo) {
      const tr = trades[ti++];
      if (!resting || tr.x < resting.live) continue;
      const yes = resting.side > 0;
      if (yes ? !(tr.side === "no" && tr.yp <= resting.yes + 1e-9) : !(tr.side === "yes" && tr.yp >= resting.yes - 1e-9)) continue;
      const through = yes ? tr.yp < resting.yes - 1e-9 : tr.yp > resting.yes + 1e-9;
      let n;
      if (through) n = resting.qty;
      else { n = Math.max(0, Math.min(resting.qty, tr.n - resting.ahead)); resting.ahead = Math.max(0, resting.ahead - tr.n); }
      const room = !pos || Math.sign(pos) === resting.side ? book.maxPosition - Math.abs(pos) : Math.abs(pos) + book.maxPosition;
      n = Math.floor(Math.min(n, room) + 1e-9);
      if (n <= 0) continue;
      const fee = fees ? makerFee(resting.own, n) : 0;
      applyFill(resting.side, n, resting.own, fee, resting.rule);
      makerFilled += n;
      actions.push({ t: tr.x, rule: resting.rule, action: yes ? "buy_yes" : "buy_no", maker: true, want: n, asked: n, qty: n, cash: n * resting.own, fee, closed: 0 });
      resting.qty -= n;
      if (resting.qty <= 0) resting = null;
    }
  };
  const markValue = row => {
    if (!pos) return 0;
    if (mark === "mid" || fill === "mid") return pos > 0 ? pos * mid(row) : -pos * (1 - mid(row));
    return pos > 0 ? pos * row.bid : -pos * (1 - row.ask);
  };

  for (let t = open + book.interval * 1000; t < market.close; t += book.interval * 1000) {
    const row = rowAt(rows, t);
    if (!row || t - row.t > staleMs) { staleTicks++; continue; }
    ticks++;
    if (MAKER) consume(t);
    const sig = signalsAt(t) || {};
    if (sig.price == null || sig.vwap_1h == null || sig.change_5m == null) noSignal++;
    // Rounded to 1e-9: 100 x 0.55 - 50 is 5.000000000000007 in floating
    // point, which reads as "over $5" and fires a target a tick early.
    const ctx = {
      price: r9(mid(row)), spread: r9(row.ask - row.bid), time_to_expiry: (market.close - t) / 1000,
      position_size: Math.abs(pos), unrealized_pnl: r9(markValue(row) - basis),
      unrealized_pnl_per_contract: pos ? r9((markValue(row) - basis) / Math.abs(pos)) : null,
    };
    for (const [k, v] of Object.entries(sig)) ctx[`edge.btc.${k}`] = v;
    const hits = matchRules(book, ctx, mode);
    if (MAKER) {
      // One resting order, kept only while the acting rule buys its side.
      const buy = hits.find(r => r.action === "buy_yes" || r.action === "buy_no");
      const side = buy ? (buy.action === "buy_yes" ? 1 : -1) : 0;
      if (resting && resting.side !== side) resting = null;
      if (buy && !hits.some(r => r.action === "sell_all" && pos)) {
        const yesPx = side > 0 ? row.bid : row.ask, own = r9(side > 0 ? row.bid : 1 - row.ask);
        const room = !pos || Math.sign(pos) === side ? book.maxPosition - Math.abs(pos) : Math.abs(pos) + book.maxPosition;
        const qty = Math.min(buy.size, room);
        const ok = own > 0 && own <= book.priceCeiling + 1e-9 && qty > 0 && t + latencyMs < market.close;
        if (!ok) resting = null;
        else if (!resting || Math.abs(resting.yes - yesPx) > 1e-9) {
          const level = side > 0 ? row.bids?.[0]?.[1] : row.asks?.[0]?.[1];
          resting = { side, yes: yesPx, own, qty, ahead: queue === "front" ? 0 : Number(level) || 0, live: t + latencyMs, rule: buy.name };
          postedContracts += qty;
          actions.push({ t, rule: buy.name, action: buy.action, maker: true, posted: qty, want: buy.size, asked: 0, qty: 0, closed: 0 });
        }
      }
    }
    for (const r of hits) {
      if (MAKER && (r.action === "buy_yes" || r.action === "buy_no")) continue;
      if (MAKER && r.action === "sell_all") resting = null;
      if (r.action === "skip") continue;
      const at = t + latencyMs;
      if (at >= market.close) { actions.push({ t, rule: r.name, action: r.action, qty: 0, why: "past the close" }); continue; }
      const execRow = latencyMs ? rowAt(rows, at) : row;
      if (!execRow || at - execRow.t > staleMs) { actions.push({ t, rule: r.name, action: r.action, qty: 0, why: "no book" }); continue; }
      if (r.action === "sell_all") {
        if (!pos) continue;
        const held = Math.abs(pos), res = reduce(held, execRow);
        actions.push({ t, rule: r.name, action: r.action, want: held, qty: res.qty, cash: res.cash, fee: res.fee, pnlCtx: ctx.unrealized_pnl });
        continue;
      }
      const side = r.action === "buy_yes" ? 1 : -1;
      let want = r.size, closed = 0;
      if (pos && Math.sign(pos) !== side) { const res = reduce(want, execRow); closed = res.qty; want -= res.qty; }
      const room = Math.max(0, book.maxPosition - Math.abs(pos));
      const n = Math.min(want, room);
      let opened = 0, spent = 0, fee = 0;
      if (n > 0) {
        const res = execute(r.action, n, execRow);
        spent = res.cash; fee = res.fee;
        if (res.qty) {
          if (!pos) opener = r.name;
          opened = res.qty; pos += side * res.qty; basis += res.cash;
          cash -= res.cash + res.fee; feesPaid += res.fee; slipPaid += res.slip;
        }
      }
      actions.push({ t, secs: (market.close - t) / 1000, rule: r.name, action: r.action, want: r.size, asked: Math.max(0, n), qty: opened, cash: spent, fee, closed, capped: n < want });
    }
  }
  if (MAKER) { consume(market.close - 1); resting = null; }
  const payout = pos > 0 ? (market.result === "yes" ? pos : 0) : pos < 0 ? (market.result === "no" ? -pos : 0) : 0;
  return { ticker: market.ticker, close: market.close, result: market.result, pnl: cash + payout, fees: feesPaid, slip: MAKER ? null : slipPaid,
    heldAtClose: pos, openerAtClose: opener, payout, actions, ticks, staleTicks, noSignal, postedContracts, makerFilled };
}

// What a walked fill paid beyond the mid of the book it filled against: a
// buy's cost over qty x mid, a sell's shortfall under it. Never negative
// for a taker (a buy cannot fill below the ask, nor a sell above the bid).
function slipOf(kind, w, row) {
  if (!w.qty) return 0;
  const m = mid(row), own = kind === "buy_yes" || kind === "sell_yes" ? m : 1 - m;
  return kind.startsWith("buy") ? w.cash - w.qty * own : w.qty * own - w.cash;
}

export const US_FRESH_MS = 2000;   // as lib/m15Venues.js: an older .us book is not "that second"
const VENUES = ["kalshi", "polyus"];

// The same rule file on Kalshi and Polymarket US at once (see the header).
// kRows: Kalshi's once-a-second rows; uRows: .us rows in the same shape
// ({ t, bid, ask, bids, asks }, YES = Up prices), on the .us exchange's
// clock. Taker only. Returns runWindow's shape plus where it bought.
export function runWindowBoth(book, market, kRows, uRows, signalsAt, opts = {}) {
  const { mode = "first", latencyMs = 0, mult = 1, staleMs = 12000, windowSecs = 900, usFreshMs = US_FRESH_MS } = opts;
  const lim = { priceFloor: book.priceFloor, priceCeiling: book.priceCeiling };
  const open = market.close - windowSecs * 1000;
  const H = { kalshi: { pos: 0, basis: 0 }, polyus: { pos: 0, basis: 0 } };
  const feeOf = { kalshi: fills => kalshiOrderFee(fills, mult), polyus: pmusOrderFee };
  const rate = { kalshi: KALSHI_RATE * mult, polyus: PMUS_FEE_COEF };
  let cash = 0, feesPaid = 0, slipPaid = 0, ticks = 0, staleTicks = 0, noSignal = 0, opener = null;
  const bought = { kalshi: 0, polyus: 0 };
  const routing = { usedUs: 0, saved: 0, compared: 0 };   // buys that took any .us level; what they saved against Kalshi alone
  let unsoldUs = 0;
  const actions = [];
  const net = () => H.kalshi.pos + H.polyus.pos;
  const uAt = (t, maxAge) => {
    const r = uRows && uRows.length ? rowAt(uRows, t) : null;
    return r && t - r.t <= maxAge ? r : null;
  };
  const markOf = (h, row) => (!h.pos ? 0 : h.pos > 0 ? h.pos * row.bid : -h.pos * (1 - row.ask));

  // Sell up to `qty` of what is held, each venue on its own book.
  const reduce = (qty, at, kRow) => {
    let left = qty, got = 0, got$ = 0, fee = 0;
    for (const v of VENUES) {
      const h = H[v], held = Math.abs(h.pos);
      if (!held || left <= 0) continue;
      const row = v === "kalshi" ? kRow : uAt(at, staleMs);
      const want = Math.min(left, held);
      // Counted once per window, as the most it ever held unsellable.
      if (!row) { if (v === "polyus") unsoldUs = Math.max(unsoldUs, want); continue; }
      const kind = h.pos > 0 ? "sell_yes" : "sell_no";
      const w = walk(row, kind, want, lim);
      if (!w.qty) continue;
      const f = feeOf[v](w.fills);
      h.basis -= h.basis * (w.qty / held); h.pos += h.pos > 0 ? -w.qty : w.qty;
      if (!h.pos) h.basis = 0;
      cash += w.cash - f; feesPaid += f; slipPaid += slipOf(kind, w, row);
      got += w.qty; got$ += w.cash; fee += f; left -= w.qty;
    }
    if (!net()) opener = null;
    return { qty: got, cash: got$, fee };
  };
  // Buy `n` of `kind` across both ladders, cheapest all-in first.
  const buy = (kind, n, at, kRow) => {
    const uRow = uAt(at, usFreshMs);
    const levels = [];
    for (const [v, row] of [["kalshi", kRow], ["polyus", uRow]]) {
      if (!row) continue;
      for (const [p, size] of (kind === "buy_yes" ? row.asks : row.bids) || []) {
        const own = kind === "buy_yes" ? p : 1 - p;
        if (own > book.priceCeiling + 1e-9) break;
        const q = Math.floor(size + 1e-9);
        if (q > 0) levels.push({ v, p, q, own, unit: own + rate[v] * own * (1 - own) });
      }
    }
    levels.sort((a, b) => a.unit - b.unit || (a.v === "kalshi" ? -1 : 1));
    const fills = { kalshi: [], polyus: [] };
    let left = n;
    for (const l of levels) {
      if (left <= 0) break;
      const q = Math.min(left, l.q);
      fills[l.v].push([l.p, q]); left -= q;
    }
    let qty = 0, spent = 0, fee = 0;
    const legs = {};
    for (const v of VENUES) {
      const F = fills[v];
      if (!F.length) continue;
      const q = F.reduce((s, [, x]) => s + x, 0), c = F.reduce((s, [p, x]) => s + x * (kind === "buy_yes" ? p : 1 - p), 0), f = feeOf[v](F);
      const row = v === "kalshi" ? kRow : uRow;
      H[v].pos += (kind === "buy_yes" ? 1 : -1) * q; H[v].basis += c;
      cash -= c + f; feesPaid += f; slipPaid += slipOf(kind, { qty: q, cash: c }, row);
      bought[v] += q; legs[v] = q; qty += q; spent += c; fee += f;
    }
    // What the same contracts would have cost on Kalshi alone, at the same moment.
    if (legs.polyus) {
      routing.usedUs++;
      const k = walk(kRow, kind, qty, lim);
      if (k.qty === qty) { routing.compared++; routing.saved += k.cash + kalshiOrderFee(k.fills, mult) - spent - fee; }
    }
    return { qty, cash: spent, fee, legs };
  };

  for (let t = open + book.interval * 1000; t < market.close; t += book.interval * 1000) {
    const row = rowAt(kRows, t);
    if (!row || t - row.t > staleMs) { staleTicks++; continue; }
    ticks++;
    const sig = signalsAt(t) || {};
    if (sig.price == null || sig.vwap_1h == null || sig.change_5m == null) noSignal++;
    const uMark = uAt(t, staleMs) || row;   // no .us book: mark its holdings at Kalshi's touch
    const unreal = markOf(H.kalshi, row) - H.kalshi.basis + markOf(H.polyus, uMark) - H.polyus.basis;
    const ctx = {
      price: r9(mid(row)), spread: r9(row.ask - row.bid), time_to_expiry: (market.close - t) / 1000,
      position_size: Math.abs(net()), unrealized_pnl: r9(unreal),
      unrealized_pnl_per_contract: net() ? r9(unreal / Math.abs(net())) : null,
    };
    for (const [k, v] of Object.entries(sig)) ctx[`edge.btc.${k}`] = v;
    for (const r of matchRules(book, ctx, mode)) {
      if (r.action === "skip") continue;
      const at = t + latencyMs;
      if (at >= market.close) { actions.push({ t, rule: r.name, action: r.action, qty: 0, why: "past the close" }); continue; }
      const kExec = latencyMs ? rowAt(kRows, at) : row;
      if (!kExec || at - kExec.t > staleMs) { actions.push({ t, rule: r.name, action: r.action, qty: 0, why: "no book" }); continue; }
      if (r.action === "sell_all") {
        if (!net()) continue;
        const held = Math.abs(net()), res = reduce(held, at, kExec);
        actions.push({ t, rule: r.name, action: r.action, want: held, qty: res.qty, cash: res.cash, fee: res.fee, pnlCtx: ctx.unrealized_pnl });
        continue;
      }
      const side = r.action === "buy_yes" ? 1 : -1;
      let want = r.size, closed = 0;
      if (net() && Math.sign(net()) !== side) { const res = reduce(want, at, kExec); closed = res.qty; want -= res.qty; }
      // Holdings on both venues share a side; one that could not be closed blocks the opposite buy.
      const blocked = net() && Math.sign(net()) !== side;
      const n = blocked ? 0 : Math.min(want, Math.max(0, book.maxPosition - Math.abs(net())));
      let res = { qty: 0, cash: 0, fee: 0, legs: {} };
      if (n > 0) {
        const wasFlat = !net();
        res = buy(r.action, n, at, kExec);
        if (res.qty && wasFlat) opener = r.name;
      }
      actions.push({ t, secs: (market.close - t) / 1000, rule: r.name, action: r.action, want: r.size, asked: Math.max(0, n), qty: res.qty, cash: res.cash, fee: res.fee, closed, legs: res.legs, capped: n < want });
    }
  }
  let payout = 0;
  for (const v of VENUES) {
    const p = H[v].pos;
    payout += p > 0 ? (market.result === "yes" ? p : 0) : p < 0 ? (market.result === "no" ? -p : 0) : 0;
  }
  return { ticker: market.ticker, close: market.close, result: market.result, pnl: cash + payout, fees: feesPaid, slip: slipPaid,
    heldAtClose: net(), openerAtClose: opener, payout, actions, ticks, staleTicks, noSignal, bought, routing, unsoldUs };
}

// Per-day and overall figures for a list of runWindow results.
const SECS_BUCKETS = [[0, 60, "last 60s"], [60, 120, "60-120s"], [120, 300, "2-5m"], [300, Infinity, "over 5m"]];
const PRICE_BUCKETS = [[0, 0.2, "under 20c"], [0.2, 0.35, "20-35c"], [0.35, 0.65, "35-65c"], [0.65, 0.8, "65-80c"], [0.8, 1.01, "80c+"]];
const bucketOf = (B, x) => (B.find(([lo, hi]) => x >= lo && x < hi) || [null, null, "?"])[2];

export function summarize(results) {
  const byDay = new Map(), byRule = new Map(), byOpener = new Map(), exits = {}, bySecs = new Map(), byPrice = new Map();
  let pnl = 0, fees = 0, traded = 0, wins = 0, contracts = 0, peak = 0, dd = 0, cum = 0, ticks = 0, stale = 0, shortfall = 0, noSignal = 0, posted = 0, makerFilled = 0;
  let slip = 0, slipKnown = true, unsoldUs = 0;
  const bought = { kalshi: 0, polyus: 0 }, routing = { usedUs: 0, saved: 0, compared: 0 }, windowPnl = [];
  const tally = (M, k, w) => { if (!M.has(k)) M.set(k, { key: k, windows: 0, wins: 0, pnl: 0 }); const g = M.get(k); g.windows++; g.pnl += w.pnl; if (w.pnl > 0) g.wins++; };
  for (const w of [...results].sort((a, b) => a.close - b.close)) {
    ticks += w.ticks; stale += w.staleTicks; noSignal += w.noSignal || 0; posted += w.postedContracts || 0; makerFilled += w.makerFilled || 0;
    const day = new Date(w.close).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { day, windows: 0, traded: 0, pnl: 0 });
    const d = byDay.get(day);
    d.windows++;
    const acted = w.actions.some(a => a.qty > 0);
    if (!acted) continue;
    traded++; d.traded++; d.pnl += w.pnl; pnl += w.pnl; fees += w.fees;
    windowPnl.push(w.pnl);
    if (w.slip == null) slipKnown = false; else slip += w.slip;
    if (w.bought) { bought.kalshi += w.bought.kalshi; bought.polyus += w.bought.polyus; }
    if (w.routing) { routing.usedUs += w.routing.usedUs; routing.saved += w.routing.saved; routing.compared += w.routing.compared; }
    unsoldUs += w.unsoldUs || 0;
    if (w.pnl > 0) wins++;
    cum += w.pnl; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak);
    for (const a of w.actions) {
      if (!byRule.has(a.rule)) byRule.set(a.rule, { rule: a.rule, fired: 0, filled: 0, contracts: 0 });
      const g = byRule.get(a.rule);
      g.fired++;
      if (a.qty > 0) { g.filled++; g.contracts += a.qty; }
      if (a.action.startsWith("buy")) { contracts += a.qty; shortfall += (a.asked || 0) - a.qty; }
      if (a.action === "sell_all" && a.qty > 0) exits[a.rule] = (exits[a.rule] || 0) + 1;
    }
    if (w.heldAtClose) exits["held to settlement"] = (exits["held to settlement"] || 0) + 1;
    // A window's P&L is credited to the rule whose order opened it.
    const first = w.actions.find(a => a.action.startsWith("buy") && a.qty > 0);
    const o = first ? first.rule : "(none)";
    if (!byOpener.has(o)) byOpener.set(o, { rule: o, windows: 0, wins: 0, pnl: 0 });
    const g = byOpener.get(o); g.windows++; g.pnl += w.pnl; if (w.pnl > 0) g.wins++;
    // The opening fill: when (seconds to the close) and at what price on the side bought.
    if (first && first.secs != null) tally(bySecs, bucketOf(SECS_BUCKETS, first.secs), w);
    if (first && first.qty > 0 && first.cash != null) tally(byPrice, bucketOf(PRICE_BUCKETS, first.cash / first.qty), w);
  }
  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const dp = days.map(d => d.pnl);
  const mean = dp.length ? dp.reduce((a, b) => a + b, 0) / dp.length : 0;
  const sd = dp.length > 1 ? Math.sqrt(dp.reduce((s, v) => s + (v - mean) ** 2, 0) / (dp.length - 1)) : null;
  // How much of the total a handful of windows carries.
  const sorted = [...windowPnl].sort((a, b) => b - a), K = Math.min(5, Math.floor(sorted.length / 2));
  const sum = a => a.reduce((s, v) => s + v, 0);
  const concentration = { k: K, best: sum(sorted.slice(0, K)), worst: sum(sorted.slice(sorted.length - K)), rest: sum(sorted.slice(K, sorted.length - K)) };
  const half = Math.floor(days.length / 2);
  const halves = days.length >= 2 ? { early: { days: half, pnl: sum(dp.slice(0, half)) }, late: { days: days.length - half, pnl: sum(dp.slice(half)) } } : null;
  const order = (B, M) => B.map(([, , k]) => M.get(k)).filter(Boolean);
  return { windows: results.length, traded, wins, pnl, fees, contracts, maxDrawdown: dd, days, perDay: mean,
    tDays: sd > 1e-12 ? mean / (sd / Math.sqrt(dp.length)) : null,
    sharpeAnnual: sd > 1e-12 ? (mean / sd) * Math.sqrt(365) : null, byRule: [...byRule.values()], byOpener: [...byOpener.values()], exits, ticks, stale, shortfall, noSignal, posted, makerFilled,
    slip: slipKnown ? slip : null, grossAtMid: slipKnown ? pnl + slip + fees : null, bought, routing, unsoldUs,
    concentration, halves, bySecs: order(SECS_BUCKETS, bySecs), byPrice: order(PRICE_BUCKETS, byPrice) };
}
