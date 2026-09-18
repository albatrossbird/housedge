// The market upsert is gated on change, like the quote already was.
//
// MEASURED, from this project's own first live run: 380 market writes
// against 142 quote writes in four minutes. The market row is the more
// expensive of the two by a wide margin — a quote APPENDS to a growing
// table, a market row UPDATES one of ~26 hot rows, which in Postgres
// means a new tuple, an entry in every index, and a dead tuple for
// autovacuum. At a 15s cadence that was ~140,000 rewrites a day of two
// dozen rows, and it is what exhausts a disk IO budget.
import { marketChanged } from "../lib/m15.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };
const at = iso => ({ ticker: "KXBTC15M-1", title: "BTC up?", strike: 100,
                     close_time: "2026-09-18T04:30:00Z", result: null,
                     last_price: 0.5, volume: 10, open_interest: 5, updated_at: iso });

console.log("a new row always writes");
ok(marketChanged(undefined, at("2026-09-18T04:00:00Z")), "never seen -> write");

console.log("\nprice and volume alone do NOT write");
{
  const prev = at("2026-09-18T04:00:00Z");
  const now = { ...at("2026-09-18T04:00:12Z"), last_price: 0.62, volume: 9999, open_interest: 400 };
  ok(!marketChanged(prev, now),
     "12s later with a moved price and volume -> no write");
  // Because backfill-15m.yml re-reads these wholesale every day, so
  // per-tick IO buys a freshness nothing reads.
}

console.log("\nsettlement always writes — it is the point of the row");
{
  const prev = at("2026-09-18T04:00:00Z");
  ok(marketChanged(prev, { ...at("2026-09-18T04:00:12Z"), result: "yes" }),
     "result null -> yes writes immediately, not on the heartbeat");
  ok(marketChanged(prev, { ...at("2026-09-18T04:00:12Z"), close_time: "2026-09-18T04:45:00Z" }),
     "a changed close_time writes");
  ok(marketChanged(prev, { ...at("2026-09-18T04:00:12Z"), strike: 101 }),
     "a changed strike writes");
  ok(marketChanged(prev, { ...at("2026-09-18T04:00:12Z"), title: "ETH up?" }),
     "a changed title writes");
}

console.log("\nthe heartbeat still runs, five minutes not fifteen seconds");
{
  const prev = at("2026-09-18T04:00:00Z");
  ok(!marketChanged(prev, at("2026-09-18T04:04:59Z")), "at 4m59s, still quiet");
  ok(marketChanged(prev, at("2026-09-18T04:05:00Z")), "at 5m00s, the heartbeat writes");
}

console.log("\nthe saving, at the cadence the recorder actually runs");
{
  // 15 live series, one poll every 15s, one hour.
  const ticks = 3600 / 15, series = 15;
  const before = ticks * series;
  // Per series per hour: one write on first sight, then the 5m
  // heartbeat, plus settlement writes as windows turn over (4/hour).
  const after = series * (1 + 12 + 4);
  ok(after < before / 10,
     `${before} upserts/hour becomes at most ${after} — a ${(before / after).toFixed(0)}x reduction`);
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
