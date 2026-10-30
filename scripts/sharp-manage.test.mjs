// lib/sharpManage.js — selling or adding to a sharp-move position 15s
// before the close. Hand-worked books; every number is checked by hand.
import { sideQuote, decideManage, fillManage, managedPnl } from "../lib/sharpManage.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;

// YES 0.24 bid / 0.26 ask: YES is the underdog, NO the favourite (0.74/0.76).
const dogYes = { bids: [[0.24, 5], [0.23, 20]], asks: [[0.26, 4], [0.27, 30]] };

console.log("sideQuote");
ok(JSON.stringify(sideQuote(dogYes, "yes")) === '{"bid":0.24,"ask":0.26}', "YES reads the book");
ok(JSON.stringify(sideQuote(dogYes, "no")) === '{"bid":0.74,"ask":0.76}', "NO is its mirror");
ok(sideQuote({ bids: [[0.24, 5]], asks: [] }, "yes") === null, "a one-sided book says nothing");

console.log("decideManage");
ok(decideManage(dogYes, "yes").action === "sell", "holding YES at a 0.24 bid: sell");
ok(decideManage(dogYes, "no").action === "add", "holding NO at a 0.76 ask: add");
ok(decideManage({ bids: [[0.30, 1]], asks: [[0.31, 1]] }, "yes").action === "sell", "a bid of exactly 0.30 sells");
ok(decideManage({ bids: [[0.31, 1]], asks: [[0.32, 1]] }, "yes").action === "hold", "0.31 holds");
ok(decideManage({ bids: [[0.73, 1]], asks: [[0.75, 1]] }, "yes").action === "add", "an ask of exactly 0.75 adds");
ok(decideManage({ bids: [[0.73, 1]], asks: [[0.74, 1]] }, "yes").action === "hold", "0.74 holds");
ok(decideManage(null, "yes") === null, "no book: nothing decided");

console.log("fillManage");
{
  // Sell 10 YES at a 0.24 bid seen, limit 0.23: buy NO at <= 0.77, i.e.
  // hit YES bids at >= 0.23. 5 at 0.24 (NO 0.76) and 5 at 0.23 (NO 0.77).
  const d = decideManage(dogYes, "yes"), m = fillManage(dogYes, "yes", d, 10);
  ok(m.side === "no" && m.k === 10 && near(m.cost, 5 * 0.76 + 5 * 0.77), "a sale walks the bids as NO bought", JSON.stringify(m));
  // fee: 0.07 x (5 x .76 x .24 + 5 x .77 x .23) = 0.07 x 1.7975 = 0.125825 -> 0.1259
  ok(near(m.fee, 0.1259), "and pays Kalshi's fee on it, rounded up per order", String(m.fee));
  const thin = fillManage({ bids: [[0.24, 3], [0.20, 50]], asks: [[0.26, 4]] }, "yes", d, 10);
  ok(thin.k === 3, "nothing under the limit is sold: the rest is held", String(thin.k));
}
{
  // Add 10 NO at a 0.76 ask seen, limit 0.77: NO asks are 1 - YES bids,
  // 0.76 x 5 then 0.77 x 20 -> 5 + 5.
  const d = decideManage(dogYes, "no"), m = fillManage(dogYes, "no", d, 10, { addQty: 10 });
  ok(m.side === "no" && m.k === 10 && near(m.cost, 5 * 0.76 + 5 * 0.77), "an add buys more of our side up to 1c over the ask", JSON.stringify(m));
  const w = fillManage(dogYes, "no", d, 10, { addQty: 10, worse: 0.01 });
  ok(near(w.cost, m.cost + 0.10), "'worse' charges a cent more per contract");
}
ok(fillManage(dogYes, "yes", { action: "hold", bid: 0.4, ask: 0.41 }, 10).k === 0, "hold trades nothing");

console.log("managedPnl");
{
  const pos = { side: "yes", n: 10, cost: 4.0, fee: 0.17 };
  // Held: wins 10 - 4.17 = 5.83, loses -4.17.
  ok(near(managedPnl({ ...pos, won: true }, null), 5.83) && near(managedPnl({ ...pos, won: false }, null), -4.17), "held to settlement");
  // Sold all 10 by buying NO for 7.65 + 0.13: 10 pairs pay $10 either way.
  const sale = { side: "no", k: 10, cost: 7.65, fee: 0.13 };
  const a = managedPnl({ ...pos, won: true }, sale), b = managedPnl({ ...pos, won: false }, sale);
  ok(near(a, b) && near(a, 10 - 4.17 - 7.78), "a full sale is the same whatever settles", `${a} ${b}`);
  // Sold 4 of 10: 4 pairs, 6 still riding.
  const part = { side: "no", k: 4, cost: 3.04, fee: 0.06 };
  ok(near(managedPnl({ ...pos, won: true }, part), 10 - 4.17 - 3.10) && near(managedPnl({ ...pos, won: false }, part), 4 - 4.17 - 3.10), "a part sale leaves the rest at risk");
  // Added 10 more YES for 7.6 + 0.13.
  const add = { side: "yes", k: 10, cost: 7.6, fee: 0.13 };
  ok(near(managedPnl({ ...pos, won: true }, add), 20 - 4.17 - 7.73) && near(managedPnl({ ...pos, won: false }, add), -4.17 - 7.73), "an add doubles the bet");
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
