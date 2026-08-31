// The route shape was read off polymarket.us's own markup and verified
// against a live page. It is pinned because "/event/<slug>" looks
// right, is right for non-game markets, and 404s on every game.
import fs from "node:fs";

const src = fs.readFileSync(new URL("../lib/titles.js", import.meta.url), "utf8");
const body = src.slice(src.indexOf("export function polymarketUsUrl")).replace("export function", "function");
const polymarketUsUrl = new Function(`${body}; return polymarketUsUrl;`)();

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
process.exit(bad ? 1 : 0);
