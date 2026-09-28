// What the WebSocket archive (scripts/m15-stream.mjs) says, reduced to a
// report. Pure: fed one parsed NDJSON line at a time, in file order, so
// scripts/m15-stream-report.mjs can stream an hour of archive through it
// without holding the hour in memory. scripts/stream-report.test.mjs
// drives it with hand-built lines.
//
// Three questions, in the order a backtest needs them answered:
//
//   1. IS THE RECORD WHOLE? Hours covered, reconnects, silent sockets,
//      sequence gaps, and the longest silence on the 5Hz index — the one
//      feed that never legitimately goes quiet.
//   2. HOW WRONG WAS THE POLLER? Each 15-second m15_quotes row against the
//      stream's book at the same instant. The poller's history is what
//      every backtest so far has used, so its error rate is the error bar
//      on all of them.
//   3. WHAT DOES THE CLOSE LOOK LIKE? For settled windows the stream
//      watched: the mid 5 min / 2 min / 60s / 30s / 10s before close,
//      bucketed, against how often YES actually won. Gross of fees, and
//      small — a first look, not a strategy.

export const OFFSETS_S = [300, 120, 60, 30, 10];
const MAX_SNAP_LAG_MS = 15000;   // the recorder heartbeats every 10s; allow a little slack

const seriesOf = t => String(t).split("-")[0];

export function newReport() {
  return {
    lines: 0, kinds: {}, tMin: Infinity, tMax: -Infinity,
    hours: new Map(),                 // "YYYY-MM-DDTHH" -> lines
    conn: {}, gaps: 0, errors: [],
    series: new Map(),                // series -> { markets:Set, snaps, finalDeltas, trades, contracts }
    snaps: new Map(),                 // ticker -> { t:[], b:[], a:[] }
    markets: new Map(),               // ticker -> { close, strike }
    finalTouches: new Map(),          // ticker -> { changes, last }
    i5: new Map(),                    // index id -> { n, lastT, maxGapMs }
  };
}

function ser(R, t) {
  const s = seriesOf(t);
  if (!R.series.has(s)) R.series.set(s, { markets: new Set(), snaps: 0, finalDeltas: 0, trades: 0, contracts: 0 });
  const o = R.series.get(s); o.markets.add(t); return o;
}

export function feedLine(R, o) {
  if (!o || typeof o !== "object") return;
  R.lines++;
  R.kinds[o.k] = (R.kinds[o.k] || 0) + 1;
  if (Number.isFinite(o.t)) {
    if (o.t < R.tMin) R.tMin = o.t;
    if (o.t > R.tMax) R.tMax = o.t;
    const h = new Date(o.t).toISOString().slice(0, 13);
    R.hours.set(h, (R.hours.get(h) || 0) + 1);
  }
  switch (o.k) {
    case "b": {
      ser(R, o.m).snaps++;
      if (!R.snaps.has(o.m)) R.snaps.set(o.m, { t: [], b: [], a: [] });
      const s = R.snaps.get(o.m);
      s.t.push(o.t); s.b.push(o.b ?? null); s.a.push(o.a ?? null);
      const m = R.markets.get(o.m);
      if (m?.close && o.t >= m.close - 120000 && o.t <= m.close) {
        const f = R.finalTouches.get(o.m) || { changes: 0, last: null };
        const key = `${o.b}/${o.a}`;
        if (f.last !== null && key !== f.last) f.changes++;
        f.last = key; R.finalTouches.set(o.m, f);
      }
      return;
    }
    case "d": ser(R, o.m).finalDeltas++; return;
    case "tr": { const s = ser(R, o.m); s.trades++; s.contracts += Number(o.n) || 0; return; }
    case "mkt": {
      const close = Date.parse(o.close);
      R.markets.set(o.m, { close: Number.isFinite(close) ? close : null, strike: o.strike ?? null });
      ser(R, o.m);
      return;
    }
    case "final": {
      // Written as each window enters its last two minutes. Carries the
      // close time, so a report that starts after a market's `mkt` line
      // was written still knows when that market closes.
      const close = Date.parse(o.close);
      if (!R.markets.has(o.m) && Number.isFinite(close)) R.markets.set(o.m, { close, strike: null });
      return;
    }
    case "i5": {
      const x = R.i5.get(o.id) || { n: 0, lastT: null, maxGapMs: 0 };
      if (x.lastT !== null) x.maxGapMs = Math.max(x.maxGapMs, o.t - x.lastT);
      x.n++; x.lastT = o.t; R.i5.set(o.id, x);
      return;
    }
    case "conn": R.conn[o.ev] = (R.conn[o.ev] || 0) + 1; return;
    case "gap": R.gaps++; return;
    case "err": if (R.errors.length < 10) R.errors.push(`${o.code} ${o.msg}`); return;
  }
}

// The stream's touch at time t: the latest snapshot at or before t, if
// it is recent enough to still describe the book.
export function touchAt(R, ticker, t) {
  const s = R.snaps.get(ticker);
  if (!s || !s.t.length) return null;
  let lo = 0, hi = s.t.length - 1, i = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (s.t[mid] <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
  if (i < 0 || t - s.t[i] > MAX_SNAP_LAG_MS) return null;
  return { b: s.b[i], a: s.a[i] };
}

// Poller rows ({ticker, observed_at, yes_bid, yes_ask, book_bid, book_ask})
// against the stream at the same instant.
export function comparePoller(R, rows) {
  const out = {
    rows: rows.length, compared: 0,
    list: { exact: 0, within1c: 0, n: 0 },   // yes_bid/yes_ask — the CDN-cached list
    book: { exact: 0, within1c: 0, n: 0 },   // book_bid/book_ask — the uncached book read
  };
  const cmp = (acc, b, a, s) => {
    if (b == null || a == null || s.b == null || s.a == null) return;
    acc.n++;
    const db = Math.abs(b - s.b), da = Math.abs(a - s.a);
    if (db < 0.0005 && da < 0.0005) acc.exact++;
    if (db <= 0.0105 && da <= 0.0105) acc.within1c++;
  };
  for (const r of rows) {
    const t = Date.parse(r.observed_at);
    const s = touchAt(R, r.ticker, t);
    if (!s) continue;
    out.compared++;
    cmp(out.list, r.yes_bid, r.yes_ask, s);
    cmp(out.book, r.book_bid, r.book_ask, s);
  }
  return out;
}

// Settled windows (m15_markets rows with result yes/no and close_time)
// the stream watched: mid at each offset before close, by 10c bucket.
export function closeCalibration(R, settled) {
  const table = {};
  for (const off of OFFSETS_S) table[off] = Array.from({ length: 10 }, () => ({ n: 0, yes: 0 }));
  let used = 0;
  for (const m of settled) {
    const close = Date.parse(m.close_time);
    const r = String(m.result || "").toLowerCase();
    if (!Number.isFinite(close) || (r !== "yes" && r !== "no")) continue;
    let any = false;
    for (const off of OFFSETS_S) {
      const s = touchAt(R, m.ticker, close - off * 1000);
      if (!s || s.b == null || s.a == null) continue;
      const mid = (s.b + s.a) / 2;
      const k = Math.min(9, Math.max(0, Math.floor(mid * 10)));
      table[off][k].n++; if (r === "yes") table[off][k].yes++;
      any = true;
    }
    if (any) used++;
  }
  return { windows: used, table };
}

export function summary(R) {
  const series = [...R.series].map(([s, o]) => ({ series: s, markets: o.markets.size, snaps: o.snaps, finalDeltas: o.finalDeltas, trades: o.trades, contracts: Math.round(o.contracts) }))
    .sort((x, y) => y.snaps - x.snaps);
  const finals = [...R.finalTouches.values()].map(f => f.changes).sort((a, b) => a - b);
  const med = a => a.length ? a[Math.floor(a.length / 2)] : null;
  return {
    lines: R.lines, kinds: R.kinds,
    from: Number.isFinite(R.tMin) ? new Date(R.tMin).toISOString() : null,
    to: Number.isFinite(R.tMax) ? new Date(R.tMax).toISOString() : null,
    hoursWithData: R.hours.size, conn: R.conn, gaps: R.gaps, errors: R.errors,
    series,
    finalWindow: { windows: finals.length, medianTouchChanges: med(finals), maxTouchChanges: finals.length ? finals[finals.length - 1] : null },
    index5hz: [...R.i5].map(([id, x]) => ({ id, ticks: x.n, maxGapS: Math.round(x.maxGapMs / 1000) })),
  };
}
