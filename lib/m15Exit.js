// Leaving a 15-minute position before the close: take profit, stop loss or a
// trailing stop, checked on EVERY recorded book change between the fill and
// the close (scripts/m15-index.mjs, section D4).
//
// The rules were fixed before the first run, so the table cannot be read as
// a menu to pick the luckiest from:
//   tp5 / tp10 / tp15   sell once our side's BID is 5 / 10 / 15c above what we paid
//   sl10 / sl20         sell once it is 10 / 20c below
//   trail10             sell once it falls 10c from its best bid since the fill
//   tp10/sl10           whichever of tp10 and sl10 comes first
// A rule acts once; whatever is not sold is held to settlement.
//
// The sale goes out EXIT_DELAY_MS after the change that triggered it, as a
// limit 1c under the bid seen, and fills against the book then — so a bid
// that is gone by the time the order lands is a miss, not a sale. Selling k
// of our side is buying k of the other side, a $1 pair: lib/sharpManage.js
// books it and pays Kalshi's fee on it, exactly as the 15s-out test did.
//
// rows: { t, bid, ask } on the YES leg, one per change of the touch
// (lib/m15Maker.js changeRows), in time order.

export const EXIT_RULES = [
  { key: "tp5", tp: 0.05 },
  { key: "tp10", tp: 0.10 },
  { key: "tp15", tp: 0.15 },
  { key: "sl10", sl: 0.10 },
  { key: "sl20", sl: 0.20 },
  { key: "trail10", trail: 0.10 },
  { key: "tp10/sl10", tp: 0.10, sl: 0.10 },
];
export const EXIT_DELAY_MS = 250;

const r4 = x => Math.round(x * 1e4) / 1e4;
const EPS = 1e-9;

// Our side's bid at a row: YES reads it, NO is 1 - the YES ask.
export const sideBid = (row, side) => (side === "yes" ? row.bid : r4(1 - row.ask));

// The first change at or after `from` on which `rule` fires, with the bid it
// saw. Null when it never fires early enough for a sale to land before the
// close (the order needs delayMs, and nothing trades at or after the close).
// The book standing at the fill counts as seen AT the fill: a trailing stop
// measures from it, and a bid already past a target there fires at once.
// Counting only the changes after the fill would start the trailing peak at
// whatever the next change happened to be (the first version did, and a
// position that fell 29c straight after its fill never trailed out).
export function exitTrigger(rule, rows, { side, entry, from, close, delayMs = EXIT_DELAY_MS }) {
  let peak = -Infinity, start = 0;
  while (start < rows.length && rows[start].t <= from) start++;
  const seen = start > 0 ? [{ ...rows[start - 1], t: from }, ...rows.slice(start)] : rows.slice(start);
  for (const r of seen) {
    if (r.t + delayMs >= close) break;
    const bid = sideBid(r, side);
    if (!(bid > 0 && bid < 1)) continue;
    if (bid > peak) peak = bid;
    if (rule.tp != null && bid >= entry + rule.tp - EPS) return { t: r.t, bid, why: "tp" };
    if (rule.sl != null && bid <= entry - rule.sl + EPS) return { t: r.t, bid, why: "sl" };
    if (rule.trail != null && bid <= peak - rule.trail + EPS) return { t: r.t, bid, why: "trail" };
  }
  return null;
}
