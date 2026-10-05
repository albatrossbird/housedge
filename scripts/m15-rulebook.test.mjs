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
import { compileRuleBook, matchRules, walk, kalshiOrderFee, runWindow, summarize, parseDuration } from "../lib/m15RuleBook.js";
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

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
