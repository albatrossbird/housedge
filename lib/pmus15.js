// Polymarket US's 15-minute "Up or Down" markets, and how they line up
// with Kalshi's.
//
// SAME CLAIM, VERIFIED. Checked 2026-09-28 against Kalshi's KXBTC15M:
// both settle on CF Benchmarks' BRTI, each end of the window is the simple
// average of the 60 index prices in the minute before it, rounded to the
// cent, and a tie pays Up / Yes on both. All 24 windows settled that day
// had the same price to beat, the same settlement price to the cent and
// the same outcome. So Polymarket US "Up" IS Kalshi "Yes" for the window
// with the same start and close.
//
// NO INDEX LISTS THEM. They are absent from /v1/events?closed=false and
// /v1/markets?slug= returns nothing for them; only the slug reaches them,
// and the slug is a function of the window's start:
//
//   event   btc-updown-15m-2026-09-28-2130z
//   market  cpc-btc-updown-15m-2026-09-28-2130z     (UTC start, HHMM)
//
// The Kalshi ticker for the same window names its CLOSE in US Eastern
// time: KXBTC15M-26SEP281745-45 closes 17:45 EDT = 21:45 UTC.
export const WINDOW_MS = 15 * 60 * 1000;

export const windowStart = ms => Math.floor(ms / WINDOW_MS) * WINDOW_MS;

export function pmusSlug(asset, startMs) {
  const d = new Date(startMs).toISOString();
  return `cpc-${asset}-updown-15m-${d.slice(0, 10)}-${d.slice(11, 13)}${d.slice(14, 16)}z`;
}

// cpc-btc-updown-15m-2026-09-28-2130z -> { asset: "btc", start, close }
export function parsePmusSlug(slug) {
  const m = /^cpc-([a-z0-9]+)-updown-15m-(\d{4}-\d\d-\d\d)-(\d\d)(\d\d)z$/.exec(String(slug));
  if (!m) return null;
  const start = Date.parse(`${m[2]}T${m[3]}:${m[4]}:00Z`);
  return { asset: m[1], start, close: start + WINDOW_MS };
}

const KALSHI_SERIES = { btc: "KXBTC15M", eth: "KXETH15M", sol: "KXSOL15M", xrp: "KXXRP15M", doge: "KXDOGE15M" };
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// The Kalshi 15-minute ticker for a window, from its close. Eastern time
// through Intl, so the DST change moves with it rather than with a
// hand-written offset.
export function kalshiM15Ticker(asset, closeMs) {
  const series = KALSHI_SERIES[asset];
  if (!series) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "2-digit", month: "numeric", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(closeMs)).map(x => [x.type, x.value]));
  return `${series}-${p.year}${MON[Number(p.month) - 1]}${p.day}${p.hour}${p.minute}-${p.minute}`;
}

// A WebSocket marketData payload -> numbers. `offers` is the ask side;
// reading `asks` returns undefined, which looks exactly like an empty
// book. Bids best-first (descending), offers best-first (ascending).
export function normalizeBook(md) {
  const lv = side => (Array.isArray(side) ? side : [])
    .map(l => [Number(l?.px?.value), Number(l?.qty)])
    .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q));
  const b = lv(md?.bids).sort((x, y) => y[0] - x[0]);
  const a = lv(md?.offers).sort((x, y) => x[0] - y[0]);
  const x = md?.transactTime ? Date.parse(md.transactTime) : null;
  return { b, a, st: md?.state ?? null, x: Number.isFinite(x) ? x : null };
}

// The slugs to hold at `now`: each asset's current window and the next
// `ahead`.
export function wantedSlugs(now, assets, ahead = 1) {
  const s0 = windowStart(now), out = [];
  for (const a of assets) for (let i = 0; i <= ahead; i++) out.push(pmusSlug(a, s0 + i * WINDOW_MS));
  return out;
}
