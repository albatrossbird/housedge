// Read back the WebSocket archive (scripts/m15-stream.mjs) and report
// on it: is the record whole, how wrong was the 15-second poller, and
// what does the close look like. The reductions live in
// lib/streamReport.js; this file only fetches.
//
// The archive is a PRIVATE Storage bucket, so this needs the
// service-role key. Run it from the 'Stream report' workflow, which has
// the secret, or on the box via systemd-run with the env file.
//
//   node scripts/m15-stream-report.mjs --hours=24
import { authHeaders } from "../lib/supabaseHeaders.js";
import { archiveReader } from "../lib/archiveRead.js";
import { pageAll } from "../lib/restPage.js";
import { newReport, feedLine, comparePoller, closeCalibration, summary, OFFSETS_S } from "../lib/streamReport.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.STREAM_BUCKET || "stream-archive";
const HOURS = Number((process.argv.find(a => a.startsWith("--hours=")) || "--hours=24").split("=")[1]);
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive bucket is private"); process.exit(1); }

const now = Date.now();
const from = now - HOURS * 3600000;

const reader = archiveReader({ url: URL, key: KEY, bucket: BUCKET });
const feedFile = (R, path) => reader.eachLine(path, o => feedLine(R, o));

const rest = async (path) => {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: authHeaders(KEY) });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

// ── The archive ──────────────────────────────────────────────────────
const files = await reader.listRange("m15", from, now);
const mb = files.reduce((s, f) => s + (f.size || 0), 0) / 1e6;
console.log(`STREAM ARCHIVE — last ${HOURS}h: ${files.length} files, ${mb.toFixed(1)} MB compressed (${files.length ? (mb / files.length).toFixed(1) : 0} MB/file)`);
if (!files.length) { console.log("::error::no archive files in the window"); process.exit(1); }

const R = newReport();
let bad = 0;
for (const f of files) bad += await feedFile(R, f.path);
const S = summary(R);

console.log(`\nspan ${S.from} -> ${S.to}, ${S.hoursWithData} hours with data, ${S.lines.toLocaleString()} lines${bad ? `, ${bad} unparseable` : ""}`);
console.log(`lines by kind: ${Object.entries(S.kinds).map(([k, n]) => `${k}=${n.toLocaleString()}`).join(" ")}`);

console.log(`\n1. IS THE RECORD WHOLE?`);
console.log(`   connection events: ${JSON.stringify(S.conn)}`);
console.log(`   sequence gaps: ${S.gaps}${S.errors.length ? `   server errors: ${S.errors.join(" | ")}` : ""}`);
for (const x of S.index5hz) console.log(`   ${x.id.padEnd(12)} 5Hz ticks ${x.ticks.toLocaleString().padStart(9)}   longest silence ${x.maxGapS}s`);

console.log(`\n   per series (snapshots = once-a-second book records; final deltas = every change in the last 2 min):`);
console.log(`   ${"series".padEnd(14)} ${"markets".padStart(7)} ${"snapshots".padStart(10)} ${"finalDeltas".padStart(12)} ${"trades".padStart(8)} ${"contracts".padStart(12)}`);
for (const s of S.series.filter(s => s.snaps || s.trades)) {
  console.log(`   ${s.series.padEnd(14)} ${String(s.markets).padStart(7)} ${String(s.snaps).padStart(10)} ${String(s.finalDeltas).padStart(12)} ${String(s.trades).padStart(8)} ${String(s.contracts).padStart(12)}`);
}
console.log(`   final 2 minutes: ${S.finalWindow.windows} windows, touch changed at a median ${S.finalWindow.medianTouchChanges} of its once-a-second samples (max ${S.finalWindow.maxTouchChanges})`);

// ── 2. The poller against the stream ─────────────────────────────────
const since = new Date(Math.max(from, Date.parse(S.from))).toISOString();
const quotes = await pageAll(rest, "m15_quotes", "id,ticker,observed_at,yes_bid,yes_ask,book_bid,book_ask",
  `observed_at=gte.${since}`, { key: "observed_at", dedupeOn: "id" });   // page on the column the filter uses (m15_quotes_observed_idx)
const P = comparePoller(R, quotes);
const pct = (a, n) => n ? `${(100 * a / n).toFixed(1)}%` : "—";
console.log(`\n2. HOW WRONG WAS THE 15-SECOND POLLER? (${P.compared.toLocaleString()} of ${P.rows.toLocaleString()} poller rows had a stream book within 15s)`);
console.log(`   cached list price (yes_bid/yes_ask):  exact ${pct(P.list.exact, P.list.n)}   within 1c ${pct(P.list.within1c, P.list.n)}   of ${P.list.n.toLocaleString()}`);
console.log(`   direct book read  (book_bid/book_ask): exact ${pct(P.book.exact, P.book.n)}   within 1c ${pct(P.book.within1c, P.book.n)}   of ${P.book.n.toLocaleString()}`);
console.log(`   (the stream sample can be up to 10s older than the poll, so "exact" undercounts on a fast book)`);

// ── 3. The close ─────────────────────────────────────────────────────
const settled = await pageAll(rest, "m15_markets", "ticker,close_time,result",
  `close_time=gte.${since}&close_time=lte.${new Date(now).toISOString()}&result=in.(yes,no)`, { key: "close_time", dedupeOn: "ticker" });
const C = closeCalibration(R, settled);
console.log(`\n3. WHAT DOES THE CLOSE LOOK LIKE? ${C.windows} settled windows with stream data (of ${settled.length} settled). GROSS OF FEES. Small sample.`);
console.log(`   mid before close -> how often YES won   (n in brackets)`);
console.log(`   ${"bucket".padEnd(9)}${OFFSETS_S.map(o => `${o}s`.padStart(12)).join("")}`);
for (let k = 0; k < 10; k++) {
  const row = OFFSETS_S.map(o => { const c = C.table[o][k]; return c.n ? `${(100 * c.yes / c.n).toFixed(0)}% (${c.n})`.padStart(12) : "—".padStart(12); }).join("");
  console.log(`   ${`${k * 10}-${k * 10 + 10}c`.padEnd(9)}${row}`);
}
