// What do the recorded Polymarket US books actually look like? The 24h
// venue compare came back with the two venues agreeing within 1c on 9% of
// samples and mid changes uncorrelated, against a live probe that agreed
// 12 of 15 times — so before any figure from it means anything, this
// checks whether each recorded `pb` line is a WHOLE book, as the recorder
// assumes, or a fragment (an incremental update written as if it were
// whole). The docs do not say which.
//
// Three tests, none of which needs the Kalshi side to be right:
//   1. level counts per line — a whole book is deep and steady; updates
//      are shallow and vary
//   2. self-crossed lines (best bid >= best offer) — a real book never is
//   3. .us TRADES against the recorded .us touch — trades are the venue's
//      own truth; if they print far outside the recorded touch, the
//      recorded touch is not the book
// and then prints a run of raw lines beside Kalshi's touch at the same
// instant, so the shape can be read by eye.
//
//   node scripts/pmus15-inspect.mjs --hours=3
import { archiveReader } from "../lib/archiveRead.js";
import { KALSHI_SERIES } from "../lib/venueCompare.js";
import { parsePmusSlug, kalshiM15Ticker } from "../lib/pmus15.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.STREAM_BUCKET || "stream-archive";
const HOURS = Number((process.argv.find(a => a.startsWith("--hours=")) || "--hours=3").split("=")[1]);
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(1); }

const reader = archiveReader({ url: URL, key: KEY, bucket: BUCKET });
const now = Date.now(), from = now - HOURS * 3600000;
const pFiles = await reader.listRange("pmus15", from, now);
const kFiles = await reader.listRange("m15", from, now);
console.log(`INSPECT .us books, last ${HOURS}h: ${pFiles.length} .us files, ${kFiles.length} Kalshi files`);

const pb = new Map(), tr = new Map(), kal = new Map(), slugOf = new Map(), lineKinds = {};
const push = (M, k, v) => { if (!M.has(k)) M.set(k, []); M.get(k).push(v); };
for (const f of pFiles) await reader.eachLine(f.path, o => {
  lineKinds[o.k] = (lineKinds[o.k] || 0) + 1;
  if (o.k === "mkt" && o.kalshi) slugOf.set(o.kalshi, o.m);
  if (o.k === "pb") push(pb, o.m, o);
  if (o.k === "tr") push(tr, o.m, o);
});
const needle = `"m":"${KALSHI_SERIES}-`;
const ktr = new Map();
for (const f of kFiles) await reader.eachLine(f.path, o => o.k === "b" ? push(kal, o.m, o) : push(ktr, o.m, o),
  line => (line.startsWith('{"k":"b"') || line.startsWith('{"k":"tr"')) && line.includes(needle));
console.log(`line kinds: ${JSON.stringify(lineKinds)}`);

const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const dist = xs => `n=${xs.length} min=${q(xs, 0)} p10=${q(xs, 0.1)} p50=${q(xs, 0.5)} p90=${q(xs, 0.9)} max=${q(xs, 1)}`;

// 1 + 2. Level counts and self-crossing.
const nb = [], na = [], states = {};
let crossed = 0, oneSided = 0, empty = 0, total = 0;
const jumps = [];
for (const lines of pb.values()) {
  lines.sort((x, y) => x.t - y.t);
  let prev = null;
  for (const o of lines) {
    total++;
    states[o.st] = (states[o.st] || 0) + 1;
    nb.push(o.b.length); na.push(o.a.length);
    if (!o.b.length && !o.a.length) empty++;
    else if (!o.b.length || !o.a.length) oneSided++;
    else if (o.b[0][0] >= o.a[0][0]) crossed++;
    if (o.b.length && o.a.length) {
      const mid = (o.b[0][0] + o.a[0][0]) / 2;
      if (prev != null) jumps.push(Math.round(Math.abs(mid - prev) * 1000) / 10);
      prev = mid;
    }
  }
}
const pct = (a, n) => n ? `${(100 * a / n).toFixed(1)}%` : "—";
console.log(`\n1. LEVELS PER LINE (${total.toLocaleString()} pb lines over ${pb.size} markets)`);
console.log(`   bids   ${dist(nb)}`);
console.log(`   offers ${dist(na)}`);
console.log(`   states ${JSON.stringify(states)}`);
console.log(`\n2. SHAPE`);
console.log(`   self-crossed (best bid >= best offer): ${pct(crossed, total)}   one-sided: ${pct(oneSided, total)}   empty: ${pct(empty, total)}`);
console.log(`   |mid change| between consecutive lines, cents: ${dist(jumps)}`);

// 3. Trades against the recorded touch at the trade's receive time.
const at = (arr, t) => { let lo = 0, hi = arr.length - 1, i = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) { i = m; lo = m + 1; } else hi = m - 1; } return i; };
let tIn = 0, tOut = 0, tNoBook = 0; const tDist = [];
for (const [slug, ts] of tr) {
  const books = pb.get(slug); if (!books) { tNoBook += ts.length; continue; }
  for (const x of ts) {
    const i = at(books, x.t); if (i < 0) { tNoBook++; continue; }
    const o = books[i]; if (!o.b.length || !o.a.length || !Number.isFinite(x.p)) { tNoBook++; continue; }
    const lo = Math.min(o.b[0][0], o.a[0][0]), hi = Math.max(o.b[0][0], o.a[0][0]);
    const d = x.p < lo ? lo - x.p : x.p > hi ? x.p - hi : 0;
    tDist.push(Math.round(d * 1000) / 10);
    if (d <= 0.0105) tIn++; else tOut++;
  }
}
console.log(`\n3. .us TRADES vs the recorded .us touch just before them`);
console.log(`   within 1c of the touch: ${pct(tIn, tIn + tOut)} of ${(tIn + tOut).toLocaleString()}   (no book to compare: ${tNoBook})`);
console.log(`   distance outside the touch, cents: ${dist(tDist)}`);

// 4. Trades against KALSHI's touch at the same instant — independent of
// how the .us book was recorded.
let kIn = 0, kN = 0; const kDist = [];
for (const [ticker, ks] of kal) {
  ks.sort((x, y) => x.t - y.t);
  const ts = tr.get(slugOf.get(ticker)); if (!ts) continue;
  for (const x of ts) {
    const i = at(ks, x.t); if (i < 0 || x.t - ks[i].t > 15000 || ks[i].b == null || ks[i].a == null) continue;
    const k = ks[i], d = x.p < k.b ? k.b - x.p : x.p > k.a ? x.p - k.a : 0;
    kN++; if (d <= 0.0205) kIn++; kDist.push(Math.round(d * 1000) / 10);
  }
}
console.log(`\n4. .us TRADES vs KALSHI's touch at the same instant (same claim, Up = YES)`);
console.log(`   within 2c: ${pct(kIn, kN)} of ${kN.toLocaleString()}   distance, cents: ${dist(kDist)}`);

// 4b. The same, per window, and against how stale Kalshi's book was: the
// 1-second record carries x, the exchange's own timestamp for the touch,
// so t - x is how long that touch had stood when it was written.
console.log(`\n4b. PER WINDOW: .us trades within 2c of Kalshi's touch, in-window only`);
console.log(`   ${"slug".padEnd(36)} ${"kalshi ticker".padEnd(26)} kLines  trades  within2c  medDist  kAge p50/p90 s  kalshiMid p50`);
const stale = [];
for (const [ticker, ks] of [...kal.entries()].sort()) {
  const slug = slugOf.get(ticker), ts = slug && tr.get(slug);
  const w = slug ? parsePmusSlug(slug) : null, start = w?.start ?? NaN, close = w?.close ?? NaN;
  const ages = ks.filter(k => Number.isFinite(k.x)).map(k => (k.t - k.x) / 1000);
  stale.push(...ages);
  if (!ts) { console.log(`   ${String(slug || "(no .us slug)").padEnd(36)} ${ticker.padEnd(26)} ${String(ks.length).padStart(6)}  (no .us trades)`); continue; }
  let n = 0, inn = 0; const ds = [];
  for (const x of ts) {
    if (!(x.t >= start && x.t < close)) continue;
    const i = at(ks, x.t); if (i < 0 || x.t - ks[i].t > 15000 || ks[i].b == null) continue;
    const k = ks[i], d = x.p < k.b ? k.b - x.p : x.p > k.a ? x.p - k.a : 0;
    n++; if (d <= 0.0205) inn++; ds.push(Math.round(d * 100));
  }
  const mids = ks.filter(k => k.t >= start && k.t < close && k.b != null).map(k => (k.b + k.a) / 2);
  const f = v => v == null ? "—" : String(Math.round(v * 10) / 10);
  console.log(`   ${slug.padEnd(36)} ${ticker.padEnd(26)} ${String(ks.length).padStart(6)} ${String(n).padStart(7)}  ${pct(inn, n).padStart(8)}  ${String(q(ds, 0.5) ?? "—").padStart(6)}c  ${f(q(ages, 0.5))}/${f(q(ages, 0.9))}  ${q(mids, 0.5)?.toFixed(3) ?? "—"}`);
}
console.log(`   Kalshi touch age at write, all lines, seconds: ${dist(stale.map(a => Math.round(a)))}`);

// 6. Kalshi's own trades against Kalshi's recorded touch — the Kalshi
// half of test 3. A reconstructed book that has drifted from the real one
// shows up here whatever the .us side is doing.
{
  let n = 0, inn = 0, crossedK = 0, linesK = 0; const ds = [];
  for (const ks of kal.values()) for (const k of ks) { if (k.b == null || k.a == null) continue; linesK++; if (k.b >= k.a) crossedK++; }
  for (const [ticker, ts] of ktr) {
    const ks = kal.get(ticker); if (!ks) continue;
    for (const x of ts) {
      const i = at(ks, x.t); if (i < 0 || x.t - ks[i].t > 15000 || ks[i].b == null || ks[i].a == null || !Number.isFinite(x.yp)) continue;
      const k = ks[i], lo = Math.min(k.b, k.a), hi = Math.max(k.b, k.a), d = x.yp < lo ? lo - x.yp : x.yp > hi ? x.yp - hi : 0;
      n++; if (d <= 0.0105) inn++; ds.push(Math.round(d * 100));
    }
  }
  console.log(`\n6. KALSHI TRADES vs Kalshi's recorded touch (1-second record, ≤15s old)`);
  console.log(`   within 1c: ${pct(inn, n)} of ${n.toLocaleString()}   distance, cents: ${dist(ds)}`);
  console.log(`   Kalshi recorded books self-crossed (bid >= ask): ${pct(crossedK, linesK)} of ${linesK.toLocaleString()}`);
}

// 7. Trade against trade: each .us trade beside the nearest Kalshi trade
// on the same window within 1 second. Neither book reconstruction is
// involved, so this is the cleanest test that the two are one market.
{
  const ds = []; let n = 0, inn = 0;
  for (const [ticker, kts] of ktr) {
    const ts = tr.get(slugOf.get(ticker)); if (!ts) continue;
    kts.sort((a, b) => a.t - b.t);
    for (const x of ts) {
      if (!Number.isFinite(x.p)) continue;
      const i = at(kts, x.t);
      const cands = [kts[i], kts[i + 1]].filter(k => k && Math.abs(k.t - x.t) <= 1000 && Number.isFinite(k.yp));
      if (!cands.length) continue;
      const k = cands.sort((a, b) => Math.abs(a.t - x.t) - Math.abs(b.t - x.t))[0];
      const d = Math.abs(k.yp - x.p); n++; if (d <= 0.0205) inn++; ds.push(Math.round(d * 100));
    }
  }
  console.log(`\n7. .us TRADE vs nearest KALSHI TRADE within 1s (Up = YES)`);
  console.log(`   within 2c: ${pct(inn, n)} of ${n.toLocaleString()}   |difference|, cents: ${dist(ds)}`);
}

// 8. Is the pairing right? The same trade-vs-trade test with each .us
// window paired against Kalshi windows shifted by -2..+2, and against the
// mirror (Up = NO). The true mapping is the one that agrees; if none does,
// the two venues are not quoting one claim.
{
  const kByClose = new Map();
  for (const [ticker, kts] of ktr) {
    const m = /-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})-/.exec(ticker + "-");
    if (!m) continue;
    kts.sort((a, b) => a.t - b.t);
    kByClose.set(ticker, kts);
  }
  const rows = [];
  for (let shift = -2; shift <= 2; shift++) for (const mirror of [false, true]) {
    let n = 0, inn = 0; const ds = [];
    for (const [slug, ts] of tr) {
      const w = parsePmusSlug(slug); if (!w) continue;
      const ticker = kalshiM15Ticker(w.asset, w.close + shift * 900000);
      const kts = kByClose.get(ticker); if (!kts) continue;
      for (const x of ts) {
        if (!Number.isFinite(x.p)) continue;
        const i = at(kts, x.t);
        const cands = [kts[i], kts[i + 1]].filter(k => k && Math.abs(k.t - x.t) <= 1000 && Number.isFinite(k.yp));
        if (!cands.length) continue;
        const k = cands.sort((a, b) => Math.abs(a.t - x.t) - Math.abs(b.t - x.t))[0];
        const d = Math.abs((mirror ? 1 - k.yp : k.yp) - x.p); n++; if (d <= 0.0205) inn++; ds.push(Math.round(d * 100));
      }
    }
    rows.push(`   shift ${shift >= 0 ? "+" : ""}${shift} window${mirror ? ", MIRROR" : "        "}: within 2c ${pct(inn, n).padStart(6)} of ${String(n).padStart(6)}   median |diff| ${q(ds, 0.5) ?? "—"}c`);
  }
  console.log(`\n8. PAIRING: .us trade vs Kalshi trade within 1s, Kalshi window shifted`);
  for (const r of rows) console.log(r);
}

// 9. Where in the window do they disagree? Trade vs trade by time to close.
{
  const B = [[600, 1e9, ">10m"], [300, 600, "5-10m"], [120, 300, "2-5m"], [60, 120, "1-2m"], [0, 60, "<1m"], [-1e9, 0, "after close"]];
  const acc = Object.fromEntries(B.map(([, , k]) => [k, { n: 0, inn: 0, ds: [] }]));
  for (const [ticker, kts] of ktr) {
    const slug = slugOf.get(ticker), ts = slug && tr.get(slug); if (!ts) continue;
    const close = parsePmusSlug(slug).close;
    for (const x of ts) {
      const i = at(kts, x.t);
      const cands = [kts[i], kts[i + 1]].filter(k => k && Math.abs(k.t - x.t) <= 1000 && Number.isFinite(k.yp));
      if (!cands.length || !Number.isFinite(x.p)) continue;
      const k = cands.sort((a, b) => Math.abs(a.t - x.t) - Math.abs(b.t - x.t))[0];
      const ttc = (close - x.t) / 1000, b = B.find(([lo, hi]) => ttc >= lo && ttc < hi)[2];
      const d = Math.abs(k.yp - x.p); acc[b].n++; if (d <= 0.0205) acc[b].inn++; acc[b].ds.push(Math.round(d * 100));
    }
  }
  console.log(`\n9. TRADE vs TRADE by time to close (as paired)`);
  for (const [k, v] of Object.entries(acc)) console.log(`   ${k.padEnd(12)} within 2c ${pct(v.inn, v.n).padStart(6)} of ${String(v.n).padStart(6)}   median |diff| ${q(v.ds, 0.5) ?? "—"}c`);
}

// 10. Twenty trade pairs side by side, from the middle of the busiest window.
{
  const [ticker, kts] = [...ktr.entries()].filter(([t]) => tr.get(slugOf.get(t))).sort((a, b) => b[1].length - a[1].length)[0] || [];
  if (ticker) {
    const slug = slugOf.get(ticker), ts = tr.get(slug);
    console.log(`\n10. RAW TRADES ${slug} / ${ticker}`);
    const mid = Math.floor(ts.length / 2);
    for (const x of ts.slice(mid, mid + 20)) {
      const i = at(kts, x.t), k = kts[i];
      console.log(`   ${new Date(x.t).toISOString().slice(11, 23)}  .us ${x.p} x${x.q} ${x.side || ""}/${x.intent || ""}   kalshi ${k ? `${new Date(k.t).toISOString().slice(11, 23)} yes ${k.yp} x${k.n} ${k.side || ""}` : "—"}`);
    }
  }
}

// 5. A run of raw lines from the busiest market, beside Kalshi.
const busiest = [...pb.entries()].sort((x, y) => y[1].length - x[1].length)[0];
if (busiest) {
  const [slug, lines] = busiest;
  const ticker = [...slugOf.entries()].find(([, s]) => s === slug)?.[0];
  const ks = (ticker && kal.get(ticker)) || [];
  const mid = Math.floor(lines.length / 2);
  console.log(`\n5. RAW: ${slug} (Kalshi ${ticker || "?"}), 25 consecutive lines from mid-window`);
  const fmt = L => L.slice(0, 3).map(([p, q]) => `${p}x${Math.round(q)}`).join(" ");
  for (const o of lines.slice(mid, mid + 25)) {
    const i = at(ks, o.t), k = i >= 0 ? ks[i] : null;
    console.log(`   ${new Date(o.t).toISOString().slice(11, 23)}  nb=${String(o.b.length).padStart(3)} na=${String(o.a.length).padStart(3)}  bids ${fmt(o.b).padEnd(36)} offers ${fmt(o.a).padEnd(36)} | kalshi ${k ? `${k.b}/${k.a}` : "—"}`);
  }
}
