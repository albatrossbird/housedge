// The route shape was read off polymarket.us's own markup and verified
// against a live page. It is pinned because "/event/<slug>" looks
// right, is right for non-game markets, and 404s on every game.
// Imported, not sliced out of the source and eval'd. The old version
// took src.slice(indexOf("export function polymarketUsUrl")) to EOF and
// fed it to new Function, so ADDING A SECOND EXPORT to titles.js broke
// the test with a syntax error rather than a failing case — the same
// trap clean-title.test.mjs hit. titles.js imports nothing, so a plain
// import always worked and the hack bought nothing.
import { polymarketUsUrl, polymarketComUrl } from "../lib/titles.js";

const cases = [
  ["aec-mlb-sea-bos-2026-08-31",
   "https://polymarket.us/sports/mlb/mlb-sea-bos-2026-08-31?marketSlug=aec-mlb-sea-bos-2026-08-31"],
  ["aec-atp-marnav-novdjo-2026-08-30",
   "https://polymarket.us/sports/atp/atp-marnav-novdjo-2026-08-30?marketSlug=aec-atp-marnav-novdjo-2026-08-30"],
  ["aec-nfl-car-gb-2025-11-02",
   "https://polymarket.us/sports/nfl/nfl-car-gb-2025-11-02?marketSlug=aec-nfl-car-gb-2025-11-02"],
  // Non-game markets genuinely live at /event/.
  ["nfl-champ-2027-02-14-w", "https://polymarket.us/event/nfl-champ-2027-02-14-w"],
  ["cfb-champ-2027-01-25-w", "https://polymarket.us/event/cfb-champ-2027-01-25-w"],
  // Nothing usable: the listing page beats a URL built from half a slug.
  ["aec-", "https://polymarket.us/"],
  ["", "https://polymarket.us/"],
  [null, "https://polymarket.us/"],
];

let bad = 0;
for (const [slug, want] of cases) {
  const got = polymarketUsUrl(slug);
  if (got !== want) { console.log(`WRONG\n  slug: ${slug}\n  got:  ${got}\n  want: ${want}`); bad++; }
}
console.log(bad ? `${bad} failing` : `all ${cases.length} correct`);


// ── Non-game markets are addressed by their PARENT EVENT ─────────
//
// Every one of these was a 404 in production: the market slug on an
// /event/ route renders the not-found page. Verified against the live
// site — /event/gdpc-us-saa-q3-2026-10-29-gt2pt0 carries the not-found
// marker, /event/us-saa-q3-2026-10-29?marketSlug=... does not.
const eventCases = [
  ["gdpc-us-saa-q3-2026-10-29-gt2pt0", "us-saa-q3-2026-10-29",
   "https://polymarket.us/event/us-saa-q3-2026-10-29?marketSlug=gdpc-us-saa-q3-2026-10-29-gt2pt0"],
  ["enwc-uspres-nom-dem-2028-jonoss", "uspres-nom-dem-2028",
   "https://polymarket.us/event/uspres-nom-dem-2028?marketSlug=enwc-uspres-nom-dem-2028-jonoss"],
  // The event slug drops the date, so this can never be derived.
  ["cpc-btc-100k-10-31-2026", "btc-100k",
   "https://polymarket.us/event/btc-100k?marketSlug=cpc-btc-100k-10-31-2026"],
  // Market IS the event: no redundant query.
  ["btc-100k", "btc-100k", "https://polymarket.us/event/btc-100k"],
  // Not backfilled yet — the old behaviour, which is the best we have.
  ["gdpc-us-saa-q3-2026-10-29-gt2pt0", null,
   "https://polymarket.us/event/gdpc-us-saa-q3-2026-10-29-gt2pt0"],
  // A game ignores the event slug: its own route already works.
  ["aec-mlb-sea-bos-2026-08-31", "mlb-2026",
   "https://polymarket.us/sports/mlb/mlb-sea-bos-2026-08-31?marketSlug=aec-mlb-sea-bos-2026-08-31"],
];

let bad2 = 0;
for (const [slug, ev, want] of eventCases) {
  const got = polymarketUsUrl(slug, ev);
  if (got !== want) { console.log(`WRONG\n  slug: ${slug}  event: ${ev}\n  got:  ${got}\n  want: ${want}`); bad2++; }
}
console.log(bad2 ? `${bad2} failing (event cases)` : `all ${eventCases.length} event cases correct`);

// ── polymarket.com ──────────────────────────────────────────────
// The .com side had the SAME game/event split and nobody checked it
// when .us was fixed. Every sports pair on the site linked to a
// not-found page.
let cf = 0;
const cok = (got, want, what) => {
  if (got !== want) { console.error(`FAIL ${what}\n  got  ${got}\n  want ${want}`); cf++; }
};
// Games live under /sports/<league>/<slug>. Verified live: this URL
// returns 18 mentions of the two teams; /event/ returns zero.
cok(polymarketComUrl("mlb-ari-hou-2026-09-04"),
    "https://polymarket.com/sports/mlb/mlb-ari-hou-2026-09-04", "MLB game");
cok(polymarketComUrl("nfl-gb-min-2026-09-13"),
    "https://polymarket.com/sports/nfl/nfl-gb-min-2026-09-13", "NFL game, different league segment");
cok(polymarketComUrl("mlb-nyy-sd-2026-09-04"),
    "https://polymarket.com/sports/mlb/mlb-nyy-sd-2026-09-04", "two-letter team code");

// Everything else keeps /event/. A futures slug ends in a bare year,
// not an ISO date, so it must NOT be routed as a game.
cok(polymarketComUrl("mlb-world-series-champion-2026"),
    "https://polymarket.com/event/mlb-world-series-champion-2026", "futures stays on /event");
cok(polymarketComUrl("will-trump-visit-greenland-by-december-31"),
    "https://polymarket.com/event/will-trump-visit-greenland-by-december-31", "non-sports stays on /event");
// A game slug with a market suffix is a DIFFERENT market (NRFI, not
// the moneyline) and is not the game page.
cok(polymarketComUrl("mlb-ari-hou-2026-09-04-nrfi"),
    "https://polymarket.com/event/mlb-ari-hou-2026-09-04-nrfi", "suffixed market is not the game route");

// No slug at all beats a route built from nothing.
cok(polymarketComUrl(""), "https://polymarket.com/", "empty slug");
cok(polymarketComUrl(null), "https://polymarket.com/", "null slug");

console.log(cf === 0 ? "all 8 .com cases correct" : `${cf} .com FAILING`);

// ONE exit, after every suite. The .com cases were appended below a
// process.exit() and silently never ran — the file reported success
// while testing nothing, which is worse than a failing test because it
// looks like coverage.
process.exit(bad + bad2 + cf ? 1 : 0);

