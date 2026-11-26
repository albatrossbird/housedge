// The movers lists (lib/movers.js). Each case is a way the first cut got
// a row wrong against the live venues, 2026-11-26.
import {
  mid, kalshiRow, comRow, usRow, rankVenue, appendHistory, fromHistory, usVisitPlan,
  indexPairs, counterpartIds, storedRow, shapeMovers, kalshiCategory, comCategory, usCategory,
  kalshiMarketUrl, DAY_MS, HISTORY_STEP, snapshotOf, dayAgoSnapshot,
} from "../lib/movers.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };
const near = (a, b) => a != null && Math.abs(a - b) < 1e-9;

const NOW = Date.parse("2026-11-26T12:00:00Z");
const old = new Date(NOW - 3 * DAY_MS).toISOString();
const later = new Date(NOW + 30 * DAY_MS).toISOString();

console.log("mid");
ok(near(mid("0.40", "0.44"), 0.42), "two-sided book is its midpoint");
ok(mid("0", "1") === null, "an untraded 0/1 book is not a price");
ok(mid("0.5", "0.4") === null, "a crossed book is not a price");

console.log("kalshiRow");
const ev = { event_ticker: "KXPVSNP", title: "When will P vs NP be resolved?", category: "Science and Technology", markets: [{}, {}] };
const km = {
  ticker: "KXPVSNP-28", event_ticker: "KXPVSNP", status: "active", open_time: old, close_time: later,
  yes_bid_dollars: "0.70", yes_ask_dollars: "0.72", previous_yes_bid_dollars: "0.45", previous_yes_ask_dollars: "0.47",
  previous_price_dollars: "0.46", last_price_dollars: "0.71", volume_24h_fp: "5000", yes_sub_title: "Before 2028",
};
const kr = kalshiRow(km, ev, NOW);
ok(near(kr.price, 0.71) && near(kr.prev, 0.46), "day-ago price is the day-ago MIDPOINT");
ok(near(kr.volume_usd, 5000 * (0.71 + 0.46) / 2), "contracts x average price");
ok(kr.outcome === "Before 2028" && kr.category === "culture", "outcome named on a multi-market event; category mapped");
// The first cut ranked "0 -> 99" rows that were markets SETTLING: no
// trade a day ago reads as previous_price 0.
const settling = kalshiRow({ ...km, previous_yes_bid_dollars: "0", previous_yes_ask_dollars: "1", previous_price_dollars: "0" }, ev, NOW);
ok(settling.prev === null, "no two-sided book a day ago -> no day-ago price, not 0");
ok(kalshiRow({ ...km, open_time: new Date(NOW - 3600e3).toISOString() }, ev, NOW).prev === null, "listed under a day ago -> no day-ago price");
ok(kalshiRow({ ...km, ticker: "KXMVESPORTS-1" }, ev, NOW) === null, "parlay tickers skipped");
ok(kalshiRow({ ...km, status: "finalized" }, ev, NOW) === null, "closed markets skipped");

console.log("comRow");
const cev = { slug: "nba-phx-hou-2026-11-27", title: "Suns vs. Rockets", tags: [{ label: "Sports" }, { label: "Basketball" }], markets: [] };
const cm = { id: "1", lastTradePrice: 0.6, oneDayPriceChange: 0.1, volume24hr: 20000, createdAt: old, endDate: later, outcomes: '["Suns","Rockets"]', active: true, closed: false };
cev.markets = [cm];
const cr = comRow(cm, cev, NOW);
ok(near(cr.prev, 0.5) && cr.outcome === "Suns", "prev = price - oneDayPriceChange; moneyline names its first outcome");
ok(cr.url === "https://polymarket.com/sports/nba/nba-phx-hou-2026-11-27", "a game links to the sports route");
ok(comRow({ ...cm, closed: true }, cev, NOW) === null, "closed market inside an open event skipped");

console.log("usRow");
const ur = usRow({ slug: "cpc-btc-above-yr-12-31-2026-200k", question: "Will Bitcoin be above ___ in 2026?", titleShort: "$200,000", category: "crypto", bestBidQuote: { value: "0.04" }, bestAskQuote: { value: "0.06" }, endDate: later }, "btc-above-2026");
ok(ur.outcome === "$200,000" && near(ur.price, 0.05) && ur.prev === null, "templated family keeps its strike; no history -> no move");
ok(ur.url === "https://polymarket.us/event/btc-above-2026?marketSlug=cpc-btc-above-yr-12-31-2026-200k", ".us link goes through the parent event");

console.log("categories");
ok(kalshiCategory("Elections") === "politics" && kalshiCategory("Financials") === "economics", "kalshi");
ok(comCategory([{ label: "Crypto" }, { label: "Finance" }]) === "crypto", "com: crypto beats finance");
ok(usCategory("macro") === "economics" && usCategory("culture") === "culture", "us");

console.log("rankVenue");
const base = { venue: "kalshi", category: "politics", closes_at: later };
const rows = [
  { ...base, market_id: "A1", event_id: "A", price: 0.7, prev: 0.4, volume_usd: 5000 },
  { ...base, market_id: "A2", event_id: "A", price: 0.6, prev: 0.5, volume_usd: 90000 },
  { ...base, market_id: "B1", event_id: "B", price: 0.5, prev: 0.49, volume_usd: 9000 },
  { ...base, market_id: "C1", event_id: "C", price: 0.9, prev: 0.2, volume_usd: 500 },
  { ...base, market_id: "D1", event_id: "D", price: 0.9, prev: 0.3, volume_usd: 9000, closes_at: new Date(NOW + 3600e3).toISOString() },
];
const r = rankVenue(rows, NOW);
ok(r.moves.map(x => x.market_id).join() === "A1", "moves: one per event (A1 not A2), under 3pts out (B), under $1k out (C), ends today out (D)");
ok(r.traded.map(x => x.market_id).join() === "A2,B1,D1", "traded: one per event by volume, and a market ending today IS in traded");
const settled = rankVenue([{ ...base, market_id: "S1", event_id: "S", price: 0.985, prev: 0.6, volume_usd: 9e5 }, { ...base, market_id: "S2", event_id: "T", price: 0.995, prev: 0.9, volume_usd: 9e5 }], NOW);
ok(settled.moves.length === 0, "moves: a price at 97c+ is a question answered, not a move");
ok(settled.traded.map(x => x.market_id).join() === "S1", "traded: 99c+ clean-up trading left out");
ok(kalshiRow({ ...km, expected_expiration_time: new Date(NOW + 3 * 3600e3).toISOString() }, ev, NOW).closes_at === new Date(NOW + 3 * 3600e3).toISOString(), "a game ends at its expected expiration, not its close_time");
ok(comRow({ ...cm, gameStartTime: new Date(NOW - 3600e3).toISOString() }, cev, NOW).closes_at === new Date(NOW + 3 * 3600e3).toISOString(), ".com game ends 4h after it starts");

console.log("history");
const t = 1_800_000_000;
let h = [];
h = appendHistory(h, [t - 25 * 3600, 0.40, 1000]);
h = appendHistory(h, [t - 12 * 3600, 0.45, 3000]);
h = appendHistory(h, [t - 12 * 3600 + 60, 0.46, 3100]);
ok(h.length === 2 && h[1][2] === 3100, "entries closer than a step replace the last one");
h = appendHistory(h, [t, 0.55, 6000]);
const f = fromHistory(h, t);
ok(near(f.prev, 0.40), "day-ago entry is the one nearest 24h ago");
ok(near(f.volumeShares, 5000 * 24 / 25), "volume scaled from the actual 25h span to a day");
ok(fromHistory([[t - 10 * 3600, 0.4, 1], [t, 0.5, 2]], t).prev === null, "no entry 18-30h old -> no day figure");
ok(appendHistory([[t - 40 * 3600, 0.1, 1]], [t, 0.2, 2]).length === 1, "entries past the keep window drop");
ok(HISTORY_STEP < 3600, "a step is shorter than an hour");

console.log("snapshots");
ok(JSON.stringify(snapshotOf([{ market_id: "a", price: 0.12345 }, { market_id: "b", price: null }])) === '{"a":0.123}', "snapshot: rounded prices, no nulls");
const snaps = [20, 23, 26, 33].map(h => ({ at: new Date(NOW - h * 3600e3).toISOString() }));
ok(dayAgoSnapshot(snaps, NOW).at === snaps[1].at, "day-ago snapshot is the one nearest 24h");
ok(dayAgoSnapshot([{ at: new Date(NOW - 5 * 3600e3).toISOString() }], NOW) === null, "none in 18-30h -> none");

console.log("usVisitPlan");
const pool = new Set(["a", "b", "c", "d", "e", "p"]);
const p0 = usVisitPlan(pool, { priority: ["p", "zz"], budget: 3, runIndex: 0 });
const p1 = usVisitPlan(pool, { priority: ["p"], budget: 3, runIndex: 1 });
ok(p0.includes("p") && !p0.includes("zz") && p0.length === 3, "priority first, and only if in the pool");
ok(p0.filter(x => x !== "p").join() !== p1.filter(x => x !== "p").join(), "the rest rotates run to run");

console.log("pairs");
const pairs = indexPairs([{ kalshi_id: "K1", polymarket_id: "123" }, { kalshi_id: "K1", polymarket_id: "aec-nfl-a-b-2026-11-27" }]);
ok(counterpartIds("kalshi", "K1", pairs).map(c => c.venue).sort().join() === "polymarket,polymarket_us", "kalshi -> both poly venues");
ok(counterpartIds("polymarket", "123", pairs).map(c => `${c.venue}:${c.id}`).join() === "kalshi:K1,polymarket_us:aec-nfl-a-b-2026-11-27", "poly -> kalshi and the other poly");

console.log("shapeMovers");
const at = new Date(NOW - 300e3).toISOString();
const s1 = storedRow({ ...rows[0], title: "A", url: "u" }, "moves", [{ venue: "polymarket_us", market_id: "us-a", price: 0.66, prev: 0.5, url: "v" }], at);
const s2 = storedRow({ venue: "polymarket_us", market_id: "us-a", event_id: "x", category: "politics", title: "A on US", price: 0.66, prev: 0.5, volume_usd: 2000 }, "moves", [], at);
ok(s1.also[0].market_id === "us-a", "stored counterpart keeps its id");
const shaped = shapeMovers([s1, s2], NOW);
ok(shaped.moves.all.length === 1 && shaped.moves.all[0].venue === "kalshi", "a claim moving on two venues is one row, the bigger move leading");
ok(near(shaped.moves.all[0].also[0].change, 0.16), "the other venue's move rides along");
ok(shaped.venues.kalshi.ageSeconds === 300, "age per venue");

console.log("links");
ok(kalshiMarketUrl("KXFED-26DEC-T4.00", "KXFED-26DEC", "fed-funds-rate") === "https://kalshi.com/markets/kxfed/fed-funds-rate/kxfed-26dec", "three-segment Kalshi url");
ok(kalshiMarketUrl("KXFED-26DEC-T4.00", "KXFED-26DEC", null) === null, "no slug -> no constructed url");

if (bad) { console.error(`\n${bad} failed`); process.exit(1); }
console.log("\nall passed");
