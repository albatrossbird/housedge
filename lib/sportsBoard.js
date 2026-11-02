// The sports board: +EV prices and arbitrage pairs from the sports scanner,
// which runs on its own server and rewrites data.json every 5 minutes as
// { scannedAt, rows, arbs }.
//
// The site never talks to the odds feed. /api/sports-board fetches the
// scanner's data.json server-side (SPORTS_BOARD_URL, optionally with
// SPORTS_BOARD_TOKEN) and passes on only what sanitizeBoard keeps. The feed's
// license allows showing DERIVED results publicly, never the raw feed or its
// key, so this is a whitelist, not a blacklist: a field the scanner adds
// later reaches no visitor until it is named here.
//
// Also dropped on purpose:
//   stake    sized from the scanner's own bankroll; not advice to anyone else
//   lead     a research tag ("to test forward, not an edge")
//   source   which upstream a row came from
// and every link that is not plain https, so a bad value cannot become a
// javascript: URL on the page.

export const ROW_FIELDS = ["venue", "sport", "event", "game", "home", "away", "commence", "market", "family", "subject",
  "point", "side", "label", "am", "dec", "decNet", "price", "p", "ev", "evNet", "n", "disp", "limit", "flags", "link", "ageS"];
export const ARB_FIELDS = ["sport", "event", "game", "home", "away", "commence", "market", "family", "subject", "who",
  "point", "margin", "ret", "payout", "maxPayout", "maxStake", "maxProfit"];
export const LEG_FIELDS = ["venue", "side", "label", "am", "dec", "decNet", "limit", "link", "ageS"];

export const VENUE_NAMES = {
  kalshi: "Kalshi", polymarket: "Polymarket US", polymarket_us: "Polymarket US", novig: "Novig", prophetx: "ProphetX",
  draftkings: "DraftKings", fanduel: "FanDuel", betmgm: "BetMGM", williamhill_us: "Caesars", fanatics: "Fanatics",
  hardrockbet: "Hard Rock Bet", espnbet: "ESPN BET", betrivers: "BetRivers", ballybet: "Bally Bet", fliff: "Fliff",
  bovada: "Bovada", betonlineag: "BetOnline", betus: "BetUS", mybookieag: "MyBookie", bet365: "bet365",
};
export const SPORT_NAMES = {
  americanfootball_nfl: "NFL", americanfootball_ncaaf: "College football", baseball_mlb: "MLB",
  basketball_nba: "NBA", icehockey_nhl: "NHL", basketball_ncaab: "College basketball",
};
export const venueName = v => VENUE_NAMES[v] ?? String(v ?? "");
export const sportName = s => SPORT_NAMES[s] ?? String(s ?? "");

const MAX_ROWS = 5000, MAX_ARBS = 2000, MAX_STR = 300;

function clean(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v.slice(0, MAX_STR);
  if (typeof v === "boolean") return v;
  return null;
}
function safeLink(v) {
  if (typeof v !== "string") return null;
  try { const u = new URL(v); return u.protocol === "https:" ? u.toString() : null; } catch { return null; }
}
function pick(o, fields) {
  const out = {};
  for (const k of fields) {
    if (k === "link") out.link = safeLink(o[k]);
    else if (k === "flags") out.flags = Array.isArray(o.flags) ? o.flags.filter(f => typeof f === "string").slice(0, 10).map(f => f.slice(0, 40)) : [];
    else out[k] = clean(o[k]);
  }
  return out;
}

// data.json -> what a visitor may see. Throws on a body that is not the
// board's shape: a broken read must look broken, never like an empty board.
export function sanitizeBoard(j, now = Date.now()) {
  if (!j || typeof j !== "object" || !Array.isArray(j.rows) || !Array.isArray(j.arbs)) throw new Error("not a sports board: expected { scannedAt, rows, arbs }");
  const scanned = Date.parse(j.scannedAt);
  if (!Number.isFinite(scanned)) throw new Error("sports board has no scannedAt");
  const rows = j.rows.filter(r => r && typeof r === "object").slice(0, MAX_ROWS).map(r => pick(r, ROW_FIELDS));
  const arbs = j.arbs.filter(a => a && typeof a === "object" && Array.isArray(a.legs)).slice(0, MAX_ARBS)
    .map(a => ({ ...pick(a, ARB_FIELDS), legs: a.legs.filter(l => l && typeof l === "object").slice(0, 4).map(l => pick(l, LEG_FIELDS)) }));
  return {
    scannedAt: new Date(scanned).toISOString(),
    ageSeconds: Math.max(0, Math.round((now - scanned) / 1000)),
    rows, arbs,
    truncated: j.rows.length > MAX_ROWS || j.arbs.length > MAX_ARBS,
  };
}
