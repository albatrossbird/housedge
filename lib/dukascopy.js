// Dukascopy's free tick history as a stand-in for the Pyth prices the
// commodity and FX 15-minute markets settle on.
//
// WHY. Pyth's own API needs a paid key since 2026-08-26 and Kalshi's
// Pyth feed is $1,000 a month. Dukascopy, a Swiss bank, publishes every
// quote it showed, by the hour, for free: gold and silver back to the
// late 1990s, oil, gas and copper from ~2011, the FX majors. These are
// the BANK'S quotes, not an exchange's and not Pyth's, so the question
// this file exists to answer is how far they sit from Pyth — measured
// against Kalshi's own settlement prices, which are Pyth's at every
// window close (lib/m15.js toM15Settlement).
//
// THE FILES. https://datafeed.dukascopy.com/datafeed/<SYM>/<YYYY>/<MM>/<DD>/<HH>h_ticks.bi5
// with the MONTH COUNTED FROM ZERO (October is 09). Each is LZMA-"alone"
// compressed: 20-byte big-endian records of ms into the hour (uint32),
// ask and bid as integers (uint32), ask and bid volume (float32). An
// hour with no quotes is an empty body. Prices are integers in units of
// a power of ten that differs by instrument (oil 101664 is 101.664) and
// is not published, so it is found from the data: the power of ten that
// puts Dukascopy nearest Pyth's own price (scaleFor).
//
// Node has no LZMA, so decoding shells out to xz (xz-utils, on every
// Ubuntu image). Checked 2026-10-26: one oil hour, 21,711 bytes, decoded
// to 129,320 = 6,466 ticks x 20.
//
// Throttled: the sandbox this was written in got 429s after two quick
// requests. One request at a time, paced, backing off on 429 and 5xx.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Kalshi series -> Dukascopy instrument. Gold and the nine
// M15_EXTRA_SERIES; Kalshi's own settlement source per series is on
// /series/<ticker> (checked 2026-10-26: all Pyth). Platinum and
// palladium are a guess at Dukascopy's naming; an instrument that does
// not exist answers 404 and is reported, not fatal.
export const DUKA_SYMBOLS = {
  KXGOLD15M: "XAUUSD", KXSILVER15M: "XAGUSD", KXPLATINUM15M: "XPTUSD", KXPALLADIUM15M: "XPDUSD",
  KXWTI15M: "LIGHTCMDUSD", KXNATGAS15M: "GASCMDUSD", KXCOPPER15M: "COPPERCMDUSD",
  KXEURUSD15M: "EURUSD", KXGBPUSD15M: "GBPUSD", KXUSDJPY15M: "USDJPY",
};

const HOUR = 3600000;
const pad = n => String(n).padStart(2, "0");

export function hourUrl(sym, hourMs) {
  const d = new Date(hourMs);
  return `https://datafeed.dukascopy.com/datafeed/${sym}/${d.getUTCFullYear()}/${pad(d.getUTCMonth())}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}h_ticks.bi5`;
}
// Local copy: <dir>/<SYM>/<YYYY-MM-DD>/<HH>.bi5 (a real month, unlike the URL).
export function hourPath(dir, sym, hourMs) {
  const iso = new Date(hourMs).toISOString();
  return join(dir, sym, iso.slice(0, 10), `${iso.slice(11, 13)}.bi5`);
}

// The weekend, when none of these trade on Dukascopy: Saturday, and
// Sunday before 20:00 UTC (FX reopens 21:00-22:00 UTC). Not fetched.
export const isClosedHour = hourMs => {
  const d = new Date(hourMs), day = d.getUTCDay(), h = d.getUTCHours();
  return day === 6 || (day === 0 && h < 20);
};

export function decompress(buf) {
  if (!buf.length) return Buffer.alloc(0);
  const r = spawnSync("xz", ["--format=lzma", "-dc"], { input: buf, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`xz: ${r.error.message} — install xz-utils`);
  if (r.status !== 0) throw new Error(`xz exited ${r.status}: ${String(r.stderr).slice(0, 200)}`);
  return r.stdout;
}

// -> [{ t, ask, bid }] in time order, prices as Dukascopy's integers.
export function decodeTicks(raw, hourMs) {
  const out = [];
  for (let i = 0; i + 20 <= raw.length; i += 20) {
    out.push({ t: hourMs + raw.readUInt32BE(i), ask: raw.readUInt32BE(i + 4), bid: raw.readUInt32BE(i + 8) });
  }
  return out;
}

// One instrument's ticks, read hour by hour from the local copies and
// kept for the last few hours only. `mid(t)` is the mid of the last
// quote at or before t, if it is no older than maxAgeMs; else null.
export function tickReader(dir, sym, { maxAgeMs = 60000, keep = 4, decode = decompress } = {}) {
  const cache = new Map();
  const hourTicks = h => {
    if (cache.has(h)) return cache.get(h);
    const f = hourPath(dir, sym, h);
    const ticks = existsSync(f) ? decodeTicks(decode(readFileSync(f)), h) : null;
    cache.set(h, ticks);
    while (cache.size > keep) cache.delete(cache.keys().next().value);
    return ticks;
  };
  return {
    // null when the hour was never fetched, so "no copy" and "no quote" differ.
    mid(t) {
      for (const h of [Math.floor(t / HOUR) * HOUR, Math.floor(t / HOUR) * HOUR - HOUR]) {
        const ticks = hourTicks(h);
        if (ticks == null) return { missing: true };
        let lo = 0, hi = ticks.length - 1, i = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (ticks[m].t <= t) { i = m; lo = m + 1; } else hi = m - 1; }
        if (i >= 0) {
          const k = ticks[i];
          return t - k.t <= maxAgeMs ? { mid: (k.ask + k.bid) / 2, age: t - k.t } : { stale: true };
        }
      }
      return { stale: true };
    },
  };
}

// Fetch every missing hour in [fromMs, toMs) for each symbol, one
// request at a time. Already-fetched hours (an empty file is an hour
// with no quotes) are skipped, so a run that dies resumes where it was.
export async function fetchHistory({ dir, symbols, fromMs, toMs, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)),
  paceMs = 1500, maxBackoffMs = 600000, log = console.log, deadlineMs = Infinity }) {
  const stats = { fetched: 0, bytes: 0, empty: 0, skipped: 0, throttled: 0, failed: 0, unavailable: [] };
  const live = new Set(symbols), misses = new Map(), got = new Set();
  const first = Math.ceil(fromMs / HOUR) * HOUR;
  for (let h = first; h < toMs; h += HOUR) {
    if (isClosedHour(h)) continue;
    for (const sym of [...live]) {
      const f = hourPath(dir, sym, h);
      if (existsSync(f)) { stats.skipped++; continue; }
      if (Date.now() > deadlineMs) { log(`stopping at the time limit; the next run resumes from ${new Date(h).toISOString()}`); return stats; }
      let backoff = 30000;
      for (;;) {
        let r;
        try { r = await fetchImpl(hourUrl(sym, h)); } catch (e) { r = { status: 0, error: e.message }; }
        if (r.status === 200) {
          const buf = Buffer.from(await r.arrayBuffer());
          mkdirSync(dirname(f), { recursive: true });
          writeFileSync(f + ".tmp", buf); renameSync(f + ".tmp", f);
          stats.fetched++; stats.bytes += buf.length; if (!buf.length) stats.empty++;
          misses.set(sym, 0); got.add(sym);
          break;
        }
        if (r.status === 404) {
          // An instrument that does not exist 404s every hour. Twelve in a
          // row with no success before them: say so and stop asking.
          const n = (misses.get(sym) || 0) + 1; misses.set(sym, n);
          if (n >= 12 && !got.has(sym)) { live.delete(sym); stats.unavailable.push(sym); log(`::warning::${sym}: 404 on every hour tried — not on Dukascopy under this name`); }
          else { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, Buffer.alloc(0)); stats.empty++; }
          break;
        }
        if (r.status === 429 || r.status === 0 || r.status >= 500) {
          stats.throttled++;
          const ra = Number(r.headers?.get?.("retry-after"));
          const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff;
          log(`${sym} ${new Date(h).toISOString().slice(0, 13)}h: ${r.status || r.error} — waiting ${Math.round(wait / 1000)}s`);
          await sleep(wait);
          backoff = Math.min(backoff * 2, maxBackoffMs);
          continue;
        }
        stats.failed++;
        log(`::warning::${sym} ${new Date(h).toISOString().slice(0, 13)}h: HTTP ${r.status} — skipped this run`);
        break;
      }
      await sleep(paceMs);
    }
  }
  return stats;
}

// The power of ten that puts Dukascopy's integers nearest Pyth's price,
// by the median relative error over the windows given.
export function scaleFor(pairs) {
  let best = null;
  for (let k = 0; k <= 7; k++) {
    const d = 10 ** k, errs = pairs.map(([raw, v]) => Math.abs(raw / d - v) / Math.abs(v)).sort((a, b) => a - b);
    const med = errs[Math.floor(errs.length / 2)];
    if (best == null || med < best.med) best = { div: d, med };
  }
  return best?.div ?? null;
}

const q = (xs, p) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null;

// One series: Kalshi's settled windows [{ close, strike, value, result }]
// against Dukascopy's mid at each window's open and close.
//   level    how far Dukascopy's price sits from Pyth's at the close
//   side     whether Dukascopy's own move over the window (close minus
//            open) points the way Kalshi settled. Its own move, not its
//            level against Kalshi's strike, so a steady gap between the
//            two prices does not count against it. That is the question
//            a 15-minute up/down market asks.
//   close    the same, on the fifth of windows that settled nearest the
//            strike, where a proxy is most likely to be wrong.
export function compareSeries(windows, reader, { windowMs = 900000 } = {}) {
  const rows = [], why = { missing: 0, stale: 0 };
  for (const w of windows) {
    const a = reader.mid(w.close - windowMs), b = reader.mid(w.close);
    if (a.missing || b.missing) { why.missing++; continue; }
    if (a.mid == null || b.mid == null) { why.stale++; continue; }
    rows.push({ ...w, d0: a.mid, d1: b.mid, age: b.age });
  }
  if (!rows.length) return { n: 0, why };
  const div = scaleFor(rows.map(r => [r.d1, r.value]));
  const gap = rows.map(r => r.d1 / div - r.value);
  const absBp = gap.map((g, i) => Math.abs(g) / rows[i].value * 1e4).sort((x, y) => x - y);
  const sides = rows.map(r => {
    const move = r.d1 - r.d0;
    return move === 0 ? null : (move > 0) === (r.result === "yes");
  });
  const rate = s => { const k = s.filter(x => x != null); return { n: k.length, agree: k.filter(Boolean).length, flat: s.length - k.length }; };
  const byMargin = rows.map((r, i) => [Math.abs(r.value - (r.strike ?? r.value)), sides[i]]).sort((x, y) => x[0] - y[0]);
  const near = byMargin.slice(0, Math.max(1, Math.floor(byMargin.length / 5))).map(x => x[1]);
  return {
    n: rows.length, why, div,
    level: { medianBp: q(absBp, 0.5), p90Bp: q(absBp, 0.9), biasMedian: [...gap].sort((x, y) => x - y)[Math.floor(gap.length / 2)] },
    side: rate(sides), close: rate(near),
    ageP50s: q(rows.map(r => r.age).sort((x, y) => x - y), 0.5) / 1000,
  };
}
