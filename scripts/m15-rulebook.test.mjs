// lib/m15RuleBook.js and lib/btcSignals.js — a rule file run tick by tick.
//
// Pinned here:
//   1. A file the engine cannot read fully is REFUSED: unknown field, op,
//      action, a buy without a size.
//   2. First match wins and `skip` acts by doing nothing; "all" lets every
//      match act. A null value never satisfies a condition.
//   3. Fills walk the book as a taker: YES buys lift offers, NO buys hit
//      bids at 1 - p, the price ceiling stops the walk, what ten levels
//      cannot fill does not fill, and the fee is Kalshi's, per order.
//   4. Opposite-side buys NET against what is held before opening.
//   5. unrealized_pnl is marked at the touch, and a stop or target exits
//      on it; settlement pays the winning side $1.
//   6. Nothing fills at or after the close, with or without delay.
//   7. Signals: a candle still open at t is never read, the hour's VWAP is
//      volume-weighted, change_5m compares with the price 300s earlier,
//      and stale data gives null.
//   8. The strategy file in the repo compiles.
import { readFileSync } from "node:fs";
import { compileRuleBook, matchRules, walk, kalshiOrderFee, runWindow, runWindowBoth, pmusOrderFee, summarize, parseDuration } from "../lib/m15RuleBook.js";
import { toCandles, newTicks, addTick, makeSignals } from "../lib/btcSignals.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const throws = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };

const base = rules => ({ market: { series_ticker: "KXBTC15M" }, risk: { max_position: 1000, price_floor: 0.01, price_ceiling: 0.99 },
  loop: { interval: 10 }, edge: { btc: { fields: ["price", "change_5m"] } }, rules });

console.log("compiling");
{
  ok(throws(() => compileRuleBook(base([{ name: "x", when: { all: [{ field: "rsi", op: ">", value: 1 }] }, action: "skip" }])), /unknown field "rsi"/), "an unknown field is refused");
  ok(throws(() => compileRuleBook(base([{ name: "x", when: { all: [{ field: "price", op: "=>", value: 1 }] }, action: "skip" }])), /unknown op/), "an unknown op is refused");
  ok(throws(() => compileRuleBook(base([{ name: "x", when: { all: [{ field: "price", op: ">", value: 1 }] }, action: "buy_maybe" }])), /unknown action/), "an unknown action is refused");
  ok(throws(() => compileRuleBook(base([{ name: "x", when: { all: [{ field: "price", op: ">", value: 1 }] }, action: "buy_yes" }])), /positive whole size/), "a buy without a size is refused");
  ok(throws(() => compileRuleBook(base([{ name: "x", when: { all: [{ field: "edge.btc.vwap_1h", op: ">", value: 1 }] }, action: "skip" }])), /unknown field/), "an edge field the file does not declare is refused");
  ok(parseDuration("5m") === 300 && parseDuration("30s") === 30 && parseDuration(45) === 45, "durations");
  const real = compileRuleBook(JSON.parse(readFileSync("strategies/momentum-ladder.json", "utf8")));
  ok(real.rules.length === 17 && real.interval === 10 && real.maxPosition === 2001, "the repo's strategy file compiles", `${real.rules.length} rules`);
  ok(real.rules.find(r => r.name === "early_entry_yes").conds[0].value === 300, "its '5m' reads as 300 seconds");
}

console.log("matching");
{
  const b = compileRuleBook(base([
    { name: "stop", when: { all: [{ field: "position_size", op: ">", value: 900 }] }, action: "skip" },
    { name: "a", when: { all: [{ field: "price", op: ">=", value: 0.5 }] }, action: "buy_yes", size: 10 },
    { name: "b", when: { all: [{ field: "edge.btc.change_5m", op: ">", value: 0 }] }, action: "buy_yes", size: 20 },
  ]));
  const ctx = { price: 0.6, position_size: 0, "edge.btc.change_5m": 0.01 };
  ok(matchRules(b, ctx).map(r => r.name).join() === "a", "first match wins");
  ok(matchRules(b, ctx, "all").map(r => r.name).join() === "a,b", "'all' lets every match act");
  ok(matchRules(b, { ...ctx, position_size: 950 }).map(r => r.name).join() === "stop", "skip pre-empts what follows");
  ok(matchRules(b, { price: 0.4, position_size: 0, "edge.btc.change_5m": null }).length === 0, "a null value satisfies nothing");
}

console.log("fills");
{
  const row = { t: 0, bid: 0.48, ask: 0.50, bids: [[0.48, 100], [0.47, 300]], asks: [[0.50, 100], [0.51, 50], [0.52, 1000]] };
  const y = walk(row, "buy_yes", 200);
  ok(y.qty === 200 && near(y.cash, 100 * 0.50 + 50 * 0.51 + 50 * 0.52), "a YES buy walks the offers", JSON.stringify(y));
  const n = walk(row, "buy_no", 150);
  ok(n.qty === 150 && near(n.cash, 100 * 0.52 + 50 * 0.53), "a NO buy hits YES bids at 1 - p", JSON.stringify(n));
  ok(walk(row, "buy_yes", 5000).qty === 1150, "what the levels cannot fill does not fill");
  ok(walk(row, "buy_yes", 200, { priceCeiling: 0.505 }).qty === 100, "the price ceiling stops the walk");
  ok(near(walk(row, "sell_no", 10).cash, 10 * 0.50), "selling NO lifts YES offers and receives 1 - p");
  ok(kalshiOrderFee([[0.5, 100]]) === 1.75, "fee: 100 at 50c is $1.75, not $1.76", String(kalshiOrderFee([[0.5, 100]])));
  ok(kalshiOrderFee([[0.5, 100], [0.9, 10]]) === Math.ceil((1.75 + 0.063) * 100) / 100, "fee: summed over the order's fills, rounded up once");
}

console.log("a window");
{
  const close = 900000, flat = (t, bid, ask) => ({ t, bid, ask, bids: [[bid, 1000]], asks: [[ask, 1000]] });
  const sig = () => ({ price: 100000, change_5m: 0.01 });
  const b = compileRuleBook(base([
    { name: "tp", when: { all: [{ field: "unrealized_pnl", op: ">", value: 5 }] }, action: "sell_all" },
    { name: "sl", when: { all: [{ field: "unrealized_pnl", op: "<", value: -5 }] }, action: "sell_all" },
    { name: "in", when: { all: [{ field: "position_size", op: "==", value: 0 }, { field: "time_to_expiry", op: "<=", value: "10m" }] }, action: "buy_yes", size: 100 },
  ]));
  // In at 0.50 with 590s left, out when the bid reaches 0.56 (+$6 marked at the bid).
  const rows = [flat(0, 0.49, 0.50), flat(400000, 0.55, 0.56), flat(500000, 0.56, 0.57)];
  const r = runWindow(b, { ticker: "T", close, result: "no" }, rows, sig, { mult: 1, staleMs: 1e9 });
  const buys = r.actions.filter(a => a.action === "buy_yes" && a.qty > 0), sells = r.actions.filter(a => a.action === "sell_all");
  ok(buys.length >= 1 && buys[0].t === 300000, "enters at the first tick with ten minutes or less left", JSON.stringify(buys[0]));
  ok(sells.length && sells[0].rule === "tp" && sells[0].t === 500000, "takes profit when the bid marks it above $5, not at the mid", JSON.stringify(sells[0]));
  ok(!r.actions.some(a => a.rule === "tp" && a.t === 400000), "a mark of exactly $5.00 (100 x 0.55 - 50) does not pass '> 5' through float noise");
  const feeIn = kalshiOrderFee([[0.50, 100]]), feeOut = kalshiOrderFee([[0.56, 100]]);
  ok(near(sells[0].cash, 56, 1e-9), "the exit sells at the bid", String(sells[0].cash));
  const trip = sells[0].cash - sells[0].fee - buys[0].cash - buys[0].fee;
  ok(near(trip, 6 - feeIn - feeOut, 1e-9) && feeIn > 0 && feeOut > 0, "a round trip pays both fees", `${trip} vs ${6 - feeIn - feeOut}`);

  // Netting: long 100 YES, a buy of 150 NO closes the 100 and opens 50 NO.
  const nb = compileRuleBook(base([
    { name: "yes", when: { all: [{ field: "position_size", op: "==", value: 0 }, { field: "price", op: "<", value: 0.6 }] }, action: "buy_yes", size: 100 },
    { name: "no", when: { all: [{ field: "price", op: ">=", value: 0.6 }] }, action: "buy_no", size: 150 },
  ]));
  const nr = runWindow(nb, { ticker: "T", close, result: "no" }, [flat(0, 0.49, 0.50), flat(500000, 0.64, 0.65)], sig, { fees: false, staleMs: 1e9 });
  const firstNo = nr.actions.find(a => a.action === "buy_no");
  ok(firstNo.closed === 100 && firstNo.qty === 50, "an opposite buy closes what is held before opening", JSON.stringify(firstNo));
  ok(nr.heldAtClose < 0, "and leaves a NO position");

  // Settlement, and the close.
  const hold = compileRuleBook(base([{ name: "in", when: { all: [{ field: "position_size", op: "==", value: 0 }] }, action: "buy_yes", size: 10 }]));
  const won = runWindow(hold, { ticker: "T", close, result: "yes" }, [flat(0, 0.39, 0.40)], sig, { fees: false, staleMs: 1e9 });
  ok(near(won.pnl, 10 - 4), "a held winner pays $1 a contract", String(won.pnl));
  const late = runWindow(hold, { ticker: "T", close, result: "yes" }, [flat(0, 0.39, 0.40)], sig, { fees: false, staleMs: 1e9, latencyMs: 900000 });
  ok(late.actions.every(a => a.qty === 0 && a.why === "past the close"), "a delayed order that would land at or after the close does not fill");
  const stale = runWindow(hold, { ticker: "T", close, result: "yes" }, [flat(0, 0.39, 0.40)], sig, { fees: false });
  ok(stale.staleTicks > 0 && stale.actions.filter(a => a.qty > 0).length <= 1, "a book older than the stale limit is not traded on");
  const cap = compileRuleBook({ ...base([{ name: "in", when: { all: [{ field: "price", op: ">", value: 0 }] }, action: "buy_yes", size: 400 }]), risk: { max_position: 1000 } });
  const capped = runWindow(cap, { ticker: "T", close, result: "no" }, [flat(0, 0.39, 0.40)], sig, { fees: false, staleMs: 1e9 });
  ok(capped.heldAtClose === 1000, "max_position caps what is held", String(capped.heldAtClose));
  const midRun = runWindow(hold, { ticker: "T", close, result: "yes" }, [flat(0, 0.30, 0.40)], sig, { fill: "mid", fees: false, staleMs: 1e9 });
  ok(near(midRun.pnl, 10 - 3.5), "the optimistic run fills at the mid");
  const s = summarize([won, capped]);
  ok(s.traded === 2 && near(s.pnl, won.pnl + capped.pnl) && s.days.length === 1, "summary totals", JSON.stringify({ t: s.traded, p: s.pnl }));
}

console.log("resting entries");
{
  const close = 900000, open = 0;
  const flat = (t, bid, ask, bq = 100, aq = 100) => ({ t, bid, ask, bids: [[bid, bq]], asks: [[ask, aq]] });
  const sig = () => ({ price: 100000, change_5m: 0.01 });
  const rows = [flat(0, 0.49, 0.50)];
  // Buy YES while flat and more than 400s remain: one resting bid at 0.49
  // posted at t=10s (the first tick), with 100 already resting there.
  const yesBook = compileRuleBook(base([{ name: "in", when: { all: [{ field: "position_size", op: "==", value: 0 }, { field: "time_to_expiry", op: ">", value: 400 }] }, action: "buy_yes", size: 30 }]));
  const T = (x, yp, n, side) => ({ x, yp, n, side });
  const run = (trades, o = {}, b = yesBook, rs = rows, result = "yes") =>
    runWindow(b, { ticker: "T", close, result }, rs, sig, { entry: "maker", queue: "join", latencyMs: 500, trades, staleMs: 1e9, makerFee: () => 0, ...o });
  const fills = r => r.actions.filter(a => a.maker && a.qty > 0);

  let r = run([T(12000, 0.49, 80, "no"), T(13000, 0.49, 50, "no")]);
  ok(fills(r).length === 1 && fills(r)[0].qty === 30, "join: 100 ahead, 80 then 50 sold into the bid -> 30 filled on the second", JSON.stringify(fills(r)));
  ok(near(r.pnl, 30 - 30 * 0.49), "a resting YES fill pays its own price, no fee, and settles", String(r.pnl));
  r = run([T(12000, 0.49, 80, "no")]);
  ok(fills(r).length === 0, "join: 80 sold is still inside the queue ahead");
  r = run([T(12000, 0.48, 5, "no")]);
  ok(fills(r).length === 1 && fills(r)[0].qty === 30, "a trade THROUGH our price fills what is left");
  r = run([T(12000, 0.49, 5, "no")], { queue: "front" });
  ok(fills(r).length === 1 && fills(r)[0].qty === 5, "front: first in line, filled by the first 5");
  r = run([T(12000, 0.49, 500, "yes")]);
  ok(fills(r).length === 0, "a taker BUYING YES does not fill a resting YES bid");
  r = run([T(10200, 0.48, 500, "no")]);
  ok(fills(r).length === 0, "a trade before the order is live (+500ms) does not fill it");
  r = run([T(505000, 0.48, 500, "no")]);
  ok(fills(r).length === 0, "the order is cancelled once its rule stops acting (400s or less left)");
  r = run([T(500000, 0.48, 500, "no")]);
  ok(fills(r).length === 1, "control: a trade AT the cancelling tick still meets the order, since a cancel takes effect after it");
  r = run([T(12000, 0.48, 500, "no")], { makerFee: (p, n) => 0.07 });
  ok(near(r.fees, 0.07) && near(r.pnl, 30 - 30 * 0.49 - 0.07), "the maker fee function is charged per fill");

  // NO is bought by offering YES at the ask: filled by takers BUYING YES.
  const noBook = compileRuleBook(base([{ name: "in", when: { all: [{ field: "position_size", op: "==", value: 0 }] }, action: "buy_no", size: 10 }]));
  r = run([T(12000, 0.50, 200, "yes")], { queue: "front" }, noBook, rows, "no");
  ok(fills(r)[0]?.qty === 10 && near(r.pnl, 10 - 10 * 0.50), "a NO bid rests as a YES offer at the ask and costs 1 - ask", JSON.stringify(fills(r)));
  r = run([T(895000, 0.50, 200, "yes")], { queue: "front" }, noBook, rows, "no");
  ok(fills(r)[0]?.qty === 10, "a trade after the last tick but before the close still fills the order resting then");
  r = run([T(12000, 0.50, 200, "no")], { queue: "front" }, noBook, rows, "no");
  ok(fills(r).length === 0, "and a taker selling YES does not fill it");

  // Netting: a resting YES bid fills 10 at 0.60 early; later the rule
  // turns to NO, and a resting NO bid (a YES offer at 0.61, NO at 0.39)
  // fills 4. A YES and a NO are a $1 pair, so 4 YES are closed at
  // 1 - 0.39 = 0.61 and 6 stay. YES settles:
  //   -10 x 0.60 - 4 x 0.39 + 4 (pairs) + 6 (settlement) = +2.44
  const net = compileRuleBook(base([
    { name: "yes", when: { all: [{ field: "time_to_expiry", op: ">", value: 600 }] }, action: "buy_yes", size: 10 },
    { name: "no", when: { all: [{ field: "time_to_expiry", op: "<=", value: 600 }] }, action: "buy_no", size: 10 },
  ]));
  r = runWindow(net, { ticker: "T", close, result: "yes" }, [flat(0, 0.60, 0.61)], sig, { entry: "maker", queue: "front", latencyMs: 0, staleMs: 1e9, makerFee: () => 0,
    trades: [T(12000, 0.60, 10, "no"), T(305000, 0.61, 4, "yes")] });
  ok(r.heldAtClose === 6 && near(r.pnl, 2.44), "a resting NO fill nets against YES held: 4 closed as $1 pairs, 6 left", `${r.heldAtClose} ${r.pnl}`);
  const sm = summarize([r]);
  ok(sm.makerFilled === 14 && sm.posted >= 20, "posted and filled contracts are reported", JSON.stringify({ f: sm.makerFilled, p: sm.posted }));
}

console.log("signals");
{
  // Candles start 10:00; each closes at minute end. At 11:00:30 the candle
  // that started 11:00 is still open and must not be read.
  const T = Date.parse("2026-10-01T10:00:00Z") / 1000;
  const raw = [];
  for (let i = 0; i <= 60; i++) raw.push([T + i * 60, 99, 101, 100, i === 60 ? 999 : 100 + (i % 2), i === 59 ? 30 : 10]);
  const candles = toCandles(raw);
  const ticks = newTicks();
  const t = (T + 3630) * 1000;
  addTick(ticks, t - 300000, 100000); addTick(ticks, t - 60000, 100050); addTick(ticks, t - 500, 100100); addTick(ticks, t - 400, 100110);
  const at = makeSignals(candles, ticks);
  const s = at(t);
  ok(s.price === 100110, "price: the last tick at or before t (within a second, the latest wins)");
  ok(near(s.change_5m, 100110 / 100000 - 1), "change_5m against the price 300s earlier", String(s.change_5m));
  ok(near(s.velocity_1m, (100110 - 100050) / 60), "velocity_1m: dollars a second over the last minute");
  ok(s.sma_20_1m != null && s.sma_20_1m < 200, "the still-open candle (close 999) is never read", String(s.sma_20_1m));
  // VWAP over candles 10:00..10:59: typical = (101+99+close)/3, volume 10 except 10:59 at 30.
  let num = 0, den = 0;
  for (let i = 0; i < 60; i++) { const c = 100 + (i % 2), v = i === 59 ? 30 : 10; num += ((101 + 99 + c) / 3) * v; den += v; }
  ok(near(s.vwap_1h, num / den, 1e-9), "vwap_1h is volume-weighted over the last 60 completed candles", `${s.vwap_1h} vs ${num / den}`);
  ok(s.high_15m === 101 && s.low_15m === 99, "15-minute high and low");
  ok(at(t + 60000).price === null, "a tick older than ten seconds is not 'now'");
  ok(at(t + 10 * 60000).vwap_1h === null, "candles that stopped minutes ago give null");
  ok(at(T * 1000 + 30000).ema_12_1m === null, "EMA needs twelve completed candles");
}

console.log("two venues");
{
  // One window. Buy 100 YES on the first tick only; sell everything once
  // the position is worth $3 over its cost.
  const b = compileRuleBook(base([
    { name: "target", when: { all: [{ field: "unrealized_pnl", op: ">", value: 3 }] }, action: "sell_all" },
    { name: "go", when: { all: [{ field: "position_size", op: "==", value: 0 }, { field: "time_to_expiry", op: ">=", value: 880 }] }, action: "buy_yes", size: 100 },
  ]));
  const close = 9000000, open = close - 900000, m = { ticker: "T", close, result: "yes" };
  const sig = () => ({});
  const K = [
    { t: open + 5000, bid: 0.49, ask: 0.50, bids: [[0.49, 1000]], asks: [[0.50, 60], [0.51, 1000]] },
    { t: open + 18000, bid: 0.60, ask: 0.61, bids: [[0.60, 1000]], asks: [[0.61, 1000]] },
  ];
  const U = [
    { t: open + 9500, bid: 0.48, ask: 0.49, bids: [[0.48, 1000]], asks: [[0.49, 30], [0.52, 1000]] },
    { t: open + 19500, bid: 0.58, ask: 0.59, bids: [[0.58, 1000]], asks: [[0.59, 1000]] },
  ];

  // Kalshi alone, as before: 60 @ .50 + 40 @ .51 = $50.40, fee $1.75; out at
  // the .60 bid for $60.00, fee $1.68: +$6.17. Paid over the mid: $0.90 in
  // (50.40 - 100 x .495) and $0.50 out (100 x .605 - 60).
  const k = runWindow(b, m, K, sig);
  ok(near(k.pnl, 6.17, 1e-6) && near(k.fees, 3.43, 1e-6), "Kalshi alone: in at the asks, out at the bid, both fees", `${k.pnl} ${k.fees}`);
  ok(near(k.slip, 1.40, 1e-6), "slip: what the fills paid beyond the mid", `${k.slip}`);
  const s = summarize([k]);
  ok(near(s.grossAtMid, 11.00, 1e-6), "P&L + slip + fees is the move at the mid: 100 x (.605 - .495)", `${s.grossAtMid}`);

  // The same with no .us book is the same run.
  const k2 = runWindowBoth(b, m, K, [], sig);
  ok(near(k2.pnl, k.pnl, 1e-9) && near(k2.fees, k.fees, 1e-9) && near(k2.slip, k.slip, 1e-9) && k2.bought.polyus === 0 && k2.bought.kalshi === 100,
    "both venues with no .us book reproduces Kalshi alone", `${k2.pnl}`);

  // Polymarket US alone, its own fees: 30 @ .49 + 70 @ .52 = $51.10, fees
  // .0695 x 30 x .49 x .51 = .5210 -> .52 and .0695 x 70 x .52 x .48 = 1.2143
  // -> 1.21. Out at its .58 bid for $58.00, fee 1.6930 -> 1.69: +$3.48.
  const u = runWindow(b, m, U, sig, { feeFn: pmusOrderFee });
  ok(near(u.pnl, 3.48, 1e-6) && near(u.fees, 3.42, 1e-6), "Polymarket US alone: its book and its half-even fee per fill", `${u.pnl} ${u.fees}`);

  // Best of both. All-in a contract: .us .49 = .5074, Kalshi .50 = .5175,
  // Kalshi .51 = .5275, .us .52 = .5373. So 30 on .us, then 60 + 10 on Kalshi.
  // Cost $14.70 + $35.10, fees .52 + 1.23 (.07 x (60 x .25 + 10 x .2499) = 1.2249).
  // Kalshi alone would have paid $52.15 all-in for the same 100: saved $0.60.
  // Out: Kalshi's 70 at .60 ($42.00, fee 1.18), the .us 30 at ITS .58 bid
  // ($17.40, fee .5079 -> .51). -51.55 + 40.82 + 16.89 = +$6.16.
  const both = runWindowBoth(b, m, K, U, sig);
  ok(both.bought.polyus === 30 && both.bought.kalshi === 70, "the cheaper venue first, spilling to the other", JSON.stringify(both.bought));
  ok(near(both.routing.saved, 0.60, 1e-6) && both.routing.usedUs === 1 && both.routing.compared === 1, "what routing saved against Kalshi alone at the same moment", JSON.stringify(both.routing));
  ok(near(both.pnl, 6.16, 1e-6), "each venue's holding is sold on its own book, at its own fee", `${both.pnl}`);
  // Slip, each venue against its own mid: in .15 (.us, mid .485) + .45 (Kalshi,
  // .495); out .35 (Kalshi, .605) + .15 (.us, .585).
  ok(near(both.slip, 1.10, 1e-6), "slip counted on each venue against its own mid", `${both.slip}`);

  // A .us book over 2s old at the decision is not used: all 100 on Kalshi.
  const late = runWindowBoth(b, m, K, [{ ...U[0], t: open + 7500 }, U[1]], sig);
  ok(late.bought.polyus === 0 && late.bought.kalshi === 100, "a .us book over 2s old is not bought from", JSON.stringify(late.bought));

  // No .us book at the exit (none within 12s): Kalshi's 70 sell, the .us 30
  // cannot and are held to settlement, paying $30. Marks fall back to
  // Kalshi's touch: at the 30s tick Kalshi's 70 are +$6.90 and the .us 30
  // +$3.30 at Kalshi's .60. -51.55 + 40.82 + 30 = +$19.27.
  const K3 = [K[0], { ...K[1], t: open + 25000 }];
  const stuck = runWindowBoth(b, m, K3, [U[0]], sig);
  ok(stuck.unsoldUs === 30 && stuck.heldAtClose === 30 && near(stuck.pnl, 19.27, 1e-6), "a .us holding with no .us book to sell into stays held", `${stuck.unsoldUs} ${stuck.heldAtClose} ${stuck.pnl}`);

  // All 100 on .us at .49 ($49.00, fee .0695 x 100 x .2499 = 1.7368 -> 1.74).
  // Kalshi alone: $50.40 + $1.75. Saved $52.15 - $50.74 = $1.41 — $1.40 of
  // price and a cent of fee, so a saving that ignored fees reads $1.40.
  // At the 20s tick the .us holding marks at ITS .52 bid: $52.00 - $49.00 =
  // $3.00, not over $3, so no exit there — marked at Kalshi's .60 it would be
  // $11.00 and sell. It sells at the 30s tick, on .us's .55 bid.
  const U2 = [
    { t: open + 9500, bid: 0.48, ask: 0.49, bids: [[0.48, 1000]], asks: [[0.49, 1000]] },
    { t: open + 19500, bid: 0.52, ask: 0.53, bids: [[0.52, 1000]], asks: [[0.53, 1000]] },
    { t: open + 29500, bid: 0.55, ask: 0.56, bids: [[0.55, 1000]], asks: [[0.56, 1000]] },
  ];
  const K2 = [...K, { ...K[1], t: open + 28000 }];
  const allUs = runWindowBoth(b, m, K2, U2, sig);
  ok(allUs.bought.polyus === 100 && near(allUs.routing.saved, 1.41, 1e-6), "the saving counts both venues' fees", `${JSON.stringify(allUs.bought)} ${allUs.routing.saved}`);
  const exitAt = allUs.actions.find(a => a.action === "sell_all" && a.qty > 0);
  ok(exitAt && exitAt.t === open + 30000, "a .us holding is marked on the .us book, not Kalshi's", exitAt ? `${(exitAt.t - open) / 1000}s` : "no exit");

  // Equal prices: .50 on both. All-in, .us's .0695 fee beats Kalshi's .07, so
  // .us fills first; on price alone the tie would go to Kalshi.
  const tieK = [{ t: open + 5000, bid: 0.49, ask: 0.50, bids: [[0.49, 1000]], asks: [[0.50, 1000]] }];
  const tieU = [{ t: open + 9500, bid: 0.49, ask: 0.50, bids: [[0.49, 1000]], asks: [[0.50, 40]] }];
  const tie = runWindowBoth(b, m, tieK, tieU, sig);
  ok(tie.bought.polyus === 40 && tie.bought.kalshi === 60, "at equal prices the lower fee fills first", JSON.stringify(tie.bought));

  // An opposite buy while a .us holding cannot be sold: Kalshi's 70 close,
  // the .us 30 have no book, and the NO buy is refused rather than leaving
  // YES on one venue and NO on the other.
  const flip = compileRuleBook(base([
    { name: "flip", when: { all: [{ field: "position_size", op: ">", value: 0 }, { field: "time_to_expiry", op: "<=", value: 875 }] }, action: "buy_no", size: 100 },
    { name: "go", when: { all: [{ field: "position_size", op: "==", value: 0 }, { field: "time_to_expiry", op: ">=", value: 880 }] }, action: "buy_yes", size: 100 },
  ]));
  const fl = runWindowBoth(flip, m, K3, [U[0]], sig);
  ok(fl.heldAtClose === 30 && fl.bought.kalshi === 70 && fl.bought.polyus === 30, "an opposite buy waits while a .us holding cannot be sold", `${fl.heldAtClose} ${JSON.stringify(fl.bought)}`);
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
