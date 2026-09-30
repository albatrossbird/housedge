// lib/m15Backtest.js — each rule that decides whether a backtest result
// means anything, pinned with hand-built paths.
import { runMarket, summarize, toPathRow, PRESETS } from "../lib/m15Backtest.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

const CLOSE = Date.parse("2026-09-29T12:15:00Z");
const mk = (result = "yes") => ({ ticker: "KXBTC15M-TEST", close: CLOSE, result });
// A row `secs` before the close.
const row = (secs, bid, ask, d = 1000) => ({ t: CLOSE - secs * 1000, secs, bid, ask, bidD1: d, askD1: d });

console.log("pricing and fees");
{
  const s = { entry: { side: "yes", secsMin: 60, secsMax: 120 } };
  const t = runMarket(s, mk("yes"), [row(90, 0.79, 0.80)], { size: 10 });
  // 10 x 0.07 x 0.8 x 0.2 = 0.112 -> rounded UP to 0.12 for the order.
  ok(t && t.entry === 0.80 && t.entryFee === 0.12, "YES is bought at the ask; the fee rounds up per order", JSON.stringify(t));
  ok(near(t.pnl, 10 * 0.20 - 0.12), "a win pays $1 a contract, settlement is free", t.pnl);
  const l = runMarket(s, mk("no"), [row(90, 0.79, 0.80)], { size: 10 });
  ok(near(l.pnl, -8.00 - 0.12), "a loss costs the stake and the fee", l.pnl);
  const n = runMarket({ entry: { side: "no", secsMin: 60, secsMax: 120 } }, mk("no"), [row(90, 0.30, 0.32)], { size: 10 });
  ok(n && near(n.entry, 0.70), "NO is bought at 1 - YES bid (hitting the YES bid queue)", JSON.stringify(n));
}

console.log("no lookahead");
{
  const s = { entry: { side: "yes", secsMin: 0, secsMax: 120 } };
  // Priced like a live market on purpose, so only the close rule can reject them.
  ok(runMarket(s, mk(), [row(0, 0.60, 0.61), row(-5, 0.60, 0.61)]) === null, "a row at or after the close is never traded");
  ok(runMarket(s, mk(), [{ ...row(10, 0.60, 0.61), t: CLOSE + 1000 }]) === null, "nor a row stamped after the close, whatever its secs_to_close says");
  // Momentum must read only rows BEFORE the decision. The path moves up
  // 12c between t-60 and t; a later row reverses it. Entry happens at
  // the row where the move is visible, as YES.
  const m = { entry: { side: "momentum", lookbackSecs: 60, minMoveCents: 10, secsMin: 100, secsMax: 700 } };
  const p = [row(700, 0.40, 0.41), row(640, 0.52, 0.53), row(600, 0.30, 0.31)];
  const t = runMarket(m, mk("yes"), p);
  ok(t && t.side === "yes" && t.entrySecs === 640, "momentum acts on the move it has seen, not the one after", JSON.stringify(t && { side: t.side, s: t.entrySecs }));
  ok(runMarket(m, mk(), [row(640, 0.52, 0.53)]) === null, "no signal when the path does not reach back far enough");
  const f = runMarket({ entry: { ...m.entry, side: "fade" } }, mk(), p);
  ok(f && f.side === "no", "fade takes the other side of the same move");
}

console.log("size is capped by the book");
{
  const s = { entry: { side: "yes", secsMin: 60, secsMax: 120 } };
  const t = runMarket(s, mk(), [row(90, 0.79, 0.80, 7)], { size: 100 });
  ok(t.qty === 7, "100 wanted, 7 resting within 1c: 7 bought", t.qty);
  const u = { ...row(90, 0.79, 0.80), askD1: null };
  ok(runMarket(s, mk(), [u], { size: 10 }) === null, "unknown depth is skipped by default, not assumed");
  ok(runMarket(s, mk(), [u], { size: 10, requireDepth: false })?.qty === 10, "and can be assumed only when asked");
  ok(runMarket(s, mk(), [row(90, 0.79, 0.80, 0)]) === null, "nothing resting, no trade");
}

console.log("filters and one entry per market");
{
  const s = { entry: { side: "favourite", secsMin: 60, secsMax: 120, priceMin: 0.65, priceMax: 0.95, maxSpread: 0.03 } };
  ok(runMarket(s, mk(), [row(90, 0.70, 0.80)]) === null, "a spread wider than asked is skipped");
  ok(runMarket(s, mk(), [row(90, 0.50, 0.51)]) === null, "a price outside the band is skipped");
  ok(runMarket(s, mk(), [row(200, 0.80, 0.81)]) === null, "outside the time window is skipped");
  const t = runMarket(s, mk("no"), [row(110, 0.20, 0.21), row(80, 0.10, 0.11)]);
  ok(t && t.side === "no" && near(t.entry, 0.80) && t.entrySecs === 110, "favourite reads the mid; NO at 0.80 is the favourite, entered once", JSON.stringify(t));
}

console.log("exits");
{
  const s = { entry: { side: "yes", secsMin: 300, secsMax: 400 }, exit: { takeProfitCents: 10, stopLossCents: 15, exitAtSecs: 60 } };
  const stop = runMarket(s, mk("yes"), [row(360, 0.69, 0.70), row(330, 0.60, 0.61), row(300, 0.54, 0.55), row(30, 0.98, 0.99)], { size: 10 });
  ok(stop.exits[0]?.why === "stop" && near(stop.exits[0].price, 0.54) && stop.held === 0,
    "stop-loss sells at the BID once it is 15c under entry — and the later recovery does not count", JSON.stringify(stop.exits));
  const fee = x => Math.ceil(10 * 0.07 * x * (1 - x) * 100) / 100;
  ok(near(stop.pnl, -7.0 - fee(0.70) + 5.4 - fee(0.54)), "both fees are paid", stop.pnl);
  const tgt = runMarket(s, mk("no"), [row(360, 0.69, 0.70), row(330, 0.80, 0.81)], { size: 10 });
  ok(tgt.exits[0]?.why === "target" && near(tgt.pnl, 10 * 0.10 - fee(0.70) - fee(0.80)), "target banks the gain even if the market later settles against", tgt.pnl);
  const time = runMarket(s, mk("yes"), [row(360, 0.69, 0.70), row(50, 0.72, 0.73)], { size: 10 });
  ok(time.exits[0]?.why === "time", "flat by the exit time");
  const part = runMarket(s, mk("yes"), [row(360, 0.69, 0.70), { ...row(300, 0.54, 0.55), bidD1: 4 }], { size: 10 });
  ok(part.exits[0]?.qty === 4 && part.held === 6, "an exit takes only what the bid holds; the rest rides to settlement", JSON.stringify(part.exits));
}

console.log("the report");
{
  const s = { entry: { side: "yes", secsMin: 60, secsMax: 120 } };
  const day = (d, res) => ({ ticker: "T" + d + res, close: Date.parse(`2026-09-${d}T12:00:00Z`), result: res });
  const rowsFor = m => [{ t: m.close - 90000, secs: 90, bid: 0.79, ask: 0.80, bidD1: 100, askD1: 100 }];
  const ms = [day(27, "yes"), day(27, "yes"), day(28, "no"), day(29, "yes")];
  const trades = ms.map(m => runMarket(s, m, rowsFor(m), { size: 10 }));
  const S = summarize(trades);
  ok(S.n === 4 && S.days === 3, "four trades are three days — the days are the sample", JSON.stringify(S));
  ok(near(S.pnlSlip1c, S.pnl - 4 * 10 * 0.01), "the 1c-worse line charges every contract a cent", `${S.pnl} ${S.pnlSlip1c}`);
  ok(S.maxDrawdown < 0, "drawdown is reported");
}

console.log("rows and presets");
{
  ok(toPathRow({ observed_at: "2026-09-29T12:13:30Z", secs_to_close: 90, book_bid: 0.4, book_ask: 0.41, bid_depth_1c: 5, ask_depth_1c: null })?.askD1 === null,
    "a null depth stays null through the row mapping");
  ok(toPathRow({ observed_at: "2026-09-29T12:13:30Z", secs_to_close: 90, book_bid: null, book_ask: 0.41 }) === null,
    "a row without the live touch is dropped (pre-2026-09-26, or a failed book read)");
  for (const [name, p] of Object.entries(PRESETS)) {
    let threw = false; try { runMarket(p, mk(), [row(90, 0.5, 0.51)]); } catch { threw = true; }
    ok(!threw, `preset ${name} runs`);
  }
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
