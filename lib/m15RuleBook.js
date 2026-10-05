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

const OPS = {
  ">": (a, b) => a > b, ">=": (a, b) => a >= b, "<": (a, b) => a < b,
  "<=": (a, b) => a <= b, "==": (a, b) => a === b, "!=": (a, b) => a !== b,
};
const ACTIONS = new Set(["skip", "sell_all", "buy_yes", "buy_no"]);
const BASE_FIELDS = new Set(["price", "spread", "time_to_expiry", "position_size", "unrealized_pnl"]);
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
    entry = "taker", queue = "join", trades = [], makerFee = () => 0 } = opts;
  const MAKER = entry === "maker";
  const lim = { priceFloor: book.priceFloor, priceCeiling: book.priceCeiling };
  const open = market.close - windowSecs * 1000;
  let pos = 0, basis = 0, cash = 0, feesPaid = 0, ticks = 0, staleTicks = 0, noSignal = 0;
  const actions = [];
  let opener = null;   // the rule that opened the position currently held

  const execute = (kind, qty, execRow) => {
    if (qty <= 0) return { qty: 0, cash: 0, fee: 0 };
    if (fill === "mid") {
      const p = mid(execRow), own = kind === "buy_yes" || kind === "sell_yes" ? p : 1 - p;
      return { qty, cash: qty * own, fee: 0 };
    }
    const w = walk(execRow, kind, qty, lim);
    return { qty: w.qty, cash: w.cash, fee: fees ? kalshiOrderFee(w.fills, mult) : 0 };
  };
  // Close `qty` of what is held (pos > 0 YES, < 0 NO).
  const reduce = (qty, execRow) => {
    const held = Math.abs(pos);
    const r = execute(pos > 0 ? "sell_yes" : "sell_no", Math.min(qty, held), execRow);
    if (!r.qty) return r;
    basis -= basis * (r.qty / held);
    pos += pos > 0 ? -r.qty : r.qty;
    cash += r.cash - r.fee; feesPaid += r.fee;
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
          cash -= res.cash + res.fee; feesPaid += res.fee;
        }
      }
      actions.push({ t, rule: r.name, action: r.action, want: r.size, asked: Math.max(0, n), qty: opened, cash: spent, fee, closed, capped: n < want });
    }
  }
  if (MAKER) { consume(market.close - 1); resting = null; }
  const payout = pos > 0 ? (market.result === "yes" ? pos : 0) : pos < 0 ? (market.result === "no" ? -pos : 0) : 0;
  return { ticker: market.ticker, close: market.close, result: market.result, pnl: cash + payout, fees: feesPaid,
    heldAtClose: pos, openerAtClose: opener, payout, actions, ticks, staleTicks, noSignal, postedContracts, makerFilled };
}

// Per-day and overall figures for a list of runWindow results.
export function summarize(results) {
  const byDay = new Map(), byRule = new Map(), byOpener = new Map(), exits = {};
  let pnl = 0, fees = 0, traded = 0, wins = 0, contracts = 0, peak = 0, dd = 0, cum = 0, ticks = 0, stale = 0, shortfall = 0, noSignal = 0, posted = 0, makerFilled = 0;
  for (const w of [...results].sort((a, b) => a.close - b.close)) {
    ticks += w.ticks; stale += w.staleTicks; noSignal += w.noSignal || 0; posted += w.postedContracts || 0; makerFilled += w.makerFilled || 0;
    const day = new Date(w.close).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { day, windows: 0, traded: 0, pnl: 0 });
    const d = byDay.get(day);
    d.windows++;
    const acted = w.actions.some(a => a.qty > 0);
    if (!acted) continue;
    traded++; d.traded++; d.pnl += w.pnl; pnl += w.pnl; fees += w.fees;
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
  }
  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const dp = days.map(d => d.pnl);
  const mean = dp.length ? dp.reduce((a, b) => a + b, 0) / dp.length : 0;
  const sd = dp.length > 1 ? Math.sqrt(dp.reduce((s, v) => s + (v - mean) ** 2, 0) / (dp.length - 1)) : null;
  return { windows: results.length, traded, wins, pnl, fees, contracts, maxDrawdown: dd, days, perDay: mean,
    sharpeAnnual: sd > 1e-12 ? (mean / sd) * Math.sqrt(365) : null, byRule: [...byRule.values()], byOpener: [...byOpener.values()], exits, ticks, stale, shortfall, noSignal, posted, makerFilled };
}
