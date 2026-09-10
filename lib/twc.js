// The Weather Company — the source Kalshi ACTUALLY settles its daily
// temperature markets on.
//
// Every KXHIGH*/KXLOW* rules string ends "according to The Weather
// Company". We record NWS because it is free and public, which means a
// disagreement between Kalshi and our forecast has two possible causes
// and we cannot tell them apart: Kalshi is mispriced, or TWC and NWS
// simply differ. That ambiguity is the single thing standing between
// the weather recorder and a tradeable signal.
//
// Reading TWC collapses it. The trial key is 50,000 calls/day and
// 100/min, which is far more than 24 stations need.
//
// LICENSING IS NOT A DETAIL. The trial is research-only; showing these
// values to MarketSlap users is redistribution and needs a paid
// commercial subscription. Keep that boundary visible in code rather
// than discovering it after building a tab on top of it.

const BASE = "https://api.weather.com";

export class TwcKeyMissing extends Error {}

export async function twcGet(path, { key = process.env.TWC_API_KEY, fetchImpl = fetch } = {}) {
  if (!key) throw new TwcKeyMissing("TWC_API_KEY is not set");
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetchImpl(`${BASE}${path}${sep}apiKey=${encodeURIComponent(key)}&format=json`, {
    headers: { "User-Agent": "marketslap/1.0", "Accept-Encoding": "gzip" },
  });
  if (r.status === 401 || r.status === 403) throw new TwcKeyMissing(`${r.status} — check TWC_API_KEY`);
  if (!r.ok) throw new Error(`twc ${r.status} ${path.slice(0, 60)} ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

// Daily summary for a station, which is where the settled high/low
// lives. `icao` is the same station our CLI_TO_STATION map resolves.
export async function dailyObservations(icao, startDate, endDate, opts = {}) {
  return twcGet(`/v3/wx/history/daily/1day?icaoCode=${encodeURIComponent(icao)}` +
                `&startDate=${startDate}&endDate=${endDate}&units=e`, opts);
}

// TWC reports absent readings as null, and Number(null) is 0 — which
// would store a fabricated 0F as a real observation. Every other
// numeric read in this repo has been bitten by exactly this.
export const num = v => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// The high and low TWC recorded for a day, in Fahrenheit.
export function highLowOf(day) {
  if (!day) return { high: null, low: null };
  return { high: num(day.temperatureMax ?? day.max_temp), low: num(day.temperatureMin ?? day.min_temp) };
}
