// lib/sportsBoard.js — what of the scanner's data.json a visitor may see.
import { sanitizeBoard, ROW_FIELDS, venueName } from "../lib/sportsBoard.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };

// Shaped like ev/board.mjs boardRow / boardArb output.
const row = { venue: "kalshi", source: "owls", sport: "americanfootball_nfl", event: "e1", game: "NYJ @ BUF", home: "BUF", away: "NYJ",
  commence: "2026-11-08T18:00:00Z", market: "h2h", family: "main", subject: null, point: null, side: "BUF", dec: 1.4, decNet: 1.38,
  label: "Buffalo", am: -250, price: 0.714, p: 0.75, ev: 0.05, evNet: 0.035, n: 9, disp: 0.02, limit: 120, stake: 37.5,
  flags: ["small"], family2: "x", lead: "kalshi", link: "https://kalshi.com/markets/x", ageS: 12, raw: { secret: 1 } };
const arb = { source: "owls", sport: "baseball_mlb", event: "e2", game: "A @ B", commence: "2026-11-08T18:00:00Z", market: "h2h", margin: 0.01, ret: 0.0101,
  payout: 50, maxPayout: 80, maxStake: 79, maxProfit: 0.8,
  legs: [{ venue: "novig", side: "A", label: "A", am: 110, dec: 2.1, decNet: 2.05, limit: 30, link: "javascript:alert(1)", ageS: 3, key: "k" },
         { venue: "fanduel", side: "B", label: "B", am: -105, dec: 1.95, decNet: 1.95, limit: null, link: "http://x.com", ageS: 5 }] };
const now = Date.parse("2026-11-02T12:05:00Z");
const b = sanitizeBoard({ scannedAt: "2026-11-02T12:00:00.000Z", rows: [row], arbs: [arb], extra: "dropped" }, now);

ok(b.ageSeconds === 300 && b.scannedAt === "2026-11-02T12:00:00.000Z", "the scan's age is reported", JSON.stringify(b).slice(0, 80));
ok(Object.keys(b.rows[0]).sort().join() === [...ROW_FIELDS].sort().join(), "a row carries exactly the whitelisted fields");
ok(!("stake" in b.rows[0]) && !("lead" in b.rows[0]) && !("source" in b.rows[0]) && !("raw" in b.rows[0]), "the scanner's stake, research tag, source and anything unknown are dropped");
ok(!("source" in b.arbs[0]) && !("key" in b.arbs[0].legs[0]), "the same holds for arbs and their legs");
ok(b.rows[0].link === "https://kalshi.com/markets/x" && b.arbs[0].legs[0].link === null && b.arbs[0].legs[1].link === null, "only https links survive: javascript: and http: are nulled");
ok(!("extra" in b), "top-level extras are dropped");
ok(b.rows[0].evNet === 0.035 && b.rows[0].flags.join() === "small", "values pass through");
let threw = 0;
for (const bad of [null, {}, { rows: [], arbs: {} }, { scannedAt: "nope", rows: [], arbs: [] }]) { try { sanitizeBoard(bad); } catch { threw++; } }
ok(threw === 4, "a body that is not a board throws, never reads as an empty one");
ok(sanitizeBoard({ scannedAt: "2026-11-02T12:00:00Z", rows: [{ evNet: Infinity, label: { x: 1 } }], arbs: [] }).rows[0].evNet === null, "non-finite numbers and objects become null");
ok(venueName("williamhill_us") === "Caesars" && venueName("unknown_book") === "unknown_book", "venue names, with an unknown key shown as itself");

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
