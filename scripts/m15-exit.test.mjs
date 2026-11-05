// lib/m15Exit.js — when each exit rule fires — and the sale's booking
// through lib/sharpManage.js, which locks in the $1 pair.
import { EXIT_RULES, exitTrigger, sideBid } from "../lib/m15Exit.js";
import { fillManage, managedPnl } from "../lib/sharpManage.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const R = k => EXIT_RULES.find(r => r.key === k);
const close = 100000;
const row = (t, bid, ask) => ({ t, bid, ask });
const opts = (side, entry, from = 0) => ({ side, entry, from, close, delayMs: 250 });

// YES bought at 0.50: bid climbs 0.49 -> 0.54 -> 0.55 -> 0.61, then falls.
const up = [row(1000, 0.49, 0.50), row(2000, 0.54, 0.55), row(3000, 0.55, 0.56), row(4000, 0.61, 0.62), row(5000, 0.50, 0.51), row(6000, 0.30, 0.31)];
let x = exitTrigger(R("tp5"), up, opts("yes", 0.50));
ok(x && x.t === 3000 && x.bid === 0.55 && x.why === "tp", "tp5 fires on the first bid 5c over the price paid, not before", JSON.stringify(x));
x = exitTrigger(R("tp10"), up, opts("yes", 0.50));
ok(x && x.t === 4000, "tp10 waits for 0.60 or better");
ok(exitTrigger(R("tp15"), up, opts("yes", 0.50)) === null, "tp15 never fires on a path that tops out at 0.61");
x = exitTrigger(R("sl10"), up, opts("yes", 0.50));
ok(x && x.t === 6000 && x.why === "sl", "sl10 fires once the bid is 10c under the price paid");
x = exitTrigger(R("trail10"), up, opts("yes", 0.50));
ok(x && x.t === 5000 && x.why === "trail", "trail10 fires 10c under the best bid since the fill (0.61 -> 0.50)", JSON.stringify(x));
x = exitTrigger(R("tp10/sl10"), up, opts("yes", 0.50));
ok(x && x.why === "tp" && x.t === 4000, "the bracket takes whichever comes first");

// NO side: its bid is 1 - the YES ask.
const down = [row(1000, 0.49, 0.50), row(2000, 0.38, 0.39)];
ok(sideBid(down[1], "no") === 0.61, "NO's bid is 1 - YES's ask");
x = exitTrigger(R("tp10"), down, opts("no", 0.50));
ok(x && x.t === 2000 && x.bid === 0.61, "a NO position takes profit when YES falls", JSON.stringify(x));

// The book standing at the fill is the trailing stop's starting point.
const drop = [row(500, 0.49, 0.50), row(3000, 0.38, 0.39)];
x = exitTrigger(R("trail10"), drop, opts("yes", 0.50, 1000));
ok(x && x.t === 3000, "trail10 measures from the bid standing at the fill (0.49), not from the next change", JSON.stringify(x));
x = exitTrigger(R("tp5"), [row(500, 0.60, 0.61), row(3000, 0.62, 0.63)], opts("yes", 0.50, 1000));
ok(x && x.t === 1000 && x.bid === 0.60, "a bid already past the target at the fill fires at the fill", JSON.stringify(x));

// Timing.
x = exitTrigger(R("trail10"), [row(1000, 0.70, 0.71), row(2000, 0.49, 0.50), row(3000, 0.45, 0.46), row(4000, 0.38, 0.39)], opts("yes", 0.50, 2500));
ok(x && x.t === 4000, "a peak from before the fill is not counted: trailing starts at the bid standing at the fill", JSON.stringify(x));
ok(exitTrigger(R("tp5"), [row(close - 200, 0.70, 0.71)], opts("yes", 0.50)) === null, "a trigger the sale could not land on before the close does not fire");
ok(exitTrigger(R("tp5"), [row(close - 300, 0.70, 0.71)], opts("yes", 0.50)) !== null, "one that can, does");

// The sale: 10 YES bought at 0.50, sold at a 0.60 bid. Selling YES at 0.60 is
// buying NO at 0.40: a $1 pair, so the result no longer depends on who wins.
const pos = { side: "yes", n: 10, cost: 5.0, fee: 0.18 };
const snap = { bids: [[0.60, 100]], asks: [[0.61, 100]] };
const m = fillManage(snap, "yes", { action: "sell", bid: 0.60 }, 10, { mult: 1 });
ok(m.k === 10 && Math.abs(m.cost - 4.0) < 1e-9 && m.side === "no", "the sale buys 10 NO at 0.40", JSON.stringify(m));
const win = managedPnl({ ...pos, won: true }, m), lose = managedPnl({ ...pos, won: false }, m);
ok(Math.abs(win - lose) < 1e-9 && Math.abs(win - (1 - 0.18 - m.fee)) < 1e-9, "a full sale locks in +$1 less both fees, win or lose", `${win} ${lose}`);
const gone = fillManage({ bids: [[0.50, 100]], asks: [[0.51, 100]] }, "yes", { action: "sell", bid: 0.60 }, 10, { mult: 1 });
ok(gone.k === 0, "a bid that is gone when the order lands is a miss, and the position is held");

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
