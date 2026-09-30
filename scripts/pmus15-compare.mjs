// Kalshi KXBTC15M against Polymarket US's 15-minute BTC market, from the
// two WebSocket archives: do the books ever sit far enough apart, for
// long enough and deep enough, to pay both venues' taker fees? The
// reduction is lib/venueCompare.js; this file only fetches and prints.
//
// Needs the service-role key (the archive bucket is private). Run it from
// the 'Venue compare 15m' workflow, or on the box via systemd-run with the
// env file.
//
//   node scripts/pmus15-compare.mjs --hours=24
import { archiveReader } from "../lib/archiveRead.js";
import { newCompare, feedKalshi, feedPmus, summarize, episodeStats, KALSHI_SERIES } from "../lib/venueCompare.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.STREAM_BUCKET || "stream-archive";
const HOURS = Number((process.argv.find(a => a.startsWith("--hours=")) || "--hours=24").split("=")[1]);
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive bucket is private"); process.exit(1); }

const reader = archiveReader({ url: URL, key: KEY, bucket: BUCKET });
const now = Date.now(), from = now - HOURS * 3600000;
const mb = fs => (fs.reduce((s, f) => s + (f.size || 0), 0) / 1e6).toFixed(1);

// The .us archive decides the window: there is nothing to compare before
// its recorder started.
const pFiles = await reader.listRange("pmus15", from, now);
if (!pFiles.length) { console.log("::error::no Polymarket US archive files in the window — is marketslap-pmus15-stream running?"); process.exit(1); }
const kFiles = await reader.listRange("m15", from, now);
if (!kFiles.length) { console.log("::error::no Kalshi archive files in the window"); process.exit(1); }
console.log(`VENUE COMPARE — ${KALSHI_SERIES} vs Polymarket US, last ${HOURS}h`);
console.log(`archives: .us ${pFiles.length} files (${mb(pFiles)} MB), Kalshi ${kFiles.length} files (${mb(kFiles)} MB)`);

const C = newCompare();
let bad = 0;
for (const f of pFiles) bad += await reader.eachLine(f.path, o => feedPmus(C, o));
// The Kalshi archive carries ~30 series; only this one's 1-second books
// are needed, so everything else is skipped before parsing.
const needle = `"m":"${KALSHI_SERIES}-`;
for (const f of kFiles) bad += await reader.eachLine(f.path, o => feedKalshi(C, o), line => line.startsWith('{"k":"b"') && line.includes(needle));
const iso = t => Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : "—";
console.log(`.us books ${iso(C.pmusFirst)} -> ${iso(C.pmusLast)} UTC, Kalshi books ${iso(C.kalshiFirst)} -> ${iso(C.kalshiLast)} UTC${bad ? `, ${bad} unparseable lines` : ""}`);
console.log(`.us recorder: connection events ${JSON.stringify(C.pmusConn)}, socket errors ${C.pmusErrors}, trades seen ${C.pmusTrades.toLocaleString()}`);

const S = summarize(C);
const pct = (a, n) => n ? `${(100 * a / n).toFixed(1)}%` : "—";
console.log(`\n${S.windows} windows on both venues, ${S.samples.toLocaleString()} paired samples (a fresh Kalshi book + the .us book current at that instant)`);
if (!S.samples) { console.log("::error::no paired samples — check both recorders cover the same hours"); process.exit(1); }

console.log(`\n1. SAME MARKET? (touch against touch)`);
console.log(`   both bid and ask equal: ${pct(S.agree.exact, S.samples)}   within 1c: ${pct(S.agree.within1c, S.samples)}`);
console.log(`   away from 50c (${S.agree.decisive.toLocaleString()} samples, where the side is decidable): as Up=YES within 1c ${pct(S.agree.decisiveWithin1c, S.agree.decisive)}, as the MIRROR ${pct(S.agree.mirrorWithin1c, S.agree.decisive)} — the second must be far lower`);

console.log(`\n2. HOW OFTEN DO THE BOOKS CROSS?`);
console.log(`   before fees (one venue's bid above the other's ask): ${pct(S.grossCross, S.samples)} of samples`);
console.log(`   after both venues' taker fees, at the best size the books allow:`);
console.log(`     A  YES on Kalshi + DOWN on .us: ${pct(S.byDir.A.positive, S.samples)}`);
console.log(`     B  UP on .us + NO on Kalshi:    ${pct(S.byDir.B.positive, S.samples)}`);
console.log(`   by time to close:`);
for (const [k, v] of Object.entries(S.byBucket)) console.log(`     ${k.padEnd(6)} ${pct(v.positive, v.samples).padStart(6)} of ${v.samples.toLocaleString()} samples`);

const E = episodeStats(S.episodes);
const hours = (Math.min(C.pmusLast, C.kalshiLast) - Math.max(C.pmusFirst, C.kalshiFirst)) / 3600000;
console.log(`\n3. EPISODES (a run of profitable samples; the dollars are each episode's BEST single moment, not a sum)`);
console.log(`   ${E.n} episodes over ~${hours.toFixed(1)} overlapping hours${hours >= 1 ? ` (~${(E.n / hours * 24).toFixed(0)} a day)` : ""}; ${E.multiSample} lasted 2+ samples`);
if (E.n) {
  console.log(`   duration: median ${E.medianS}s, p90 ${E.p90S}s, max ${E.maxS}s`);
  console.log(`   total if every episode's best moment were filled: $${E.dollars.toFixed(2)} — an UPPER BOUND: both legs at once, no latency, no competition`);
  console.log(`   largest ten:`);
  const top = [...S.episodes].sort((a, b) => b.bestProfit - a.bestProfit).slice(0, 10);
  for (const e of top) {
    console.log(`     ${iso(e.start)}  ${e.dir}  ${String(Math.round((e.last - e.start) / 1000) + 1).padStart(3)}s  ${Math.round(e.ttcStart)}s to close  edge at touch ${(100 * e.bestTouchEdge).toFixed(2)}c  best $${e.bestProfit.toFixed(2)} on ${Math.round(e.bestSize).toLocaleString()} contracts  ${e.ticker}`);
  }
}

console.log(`\n4. WHO MOVES FIRST? correlation of mid changes, .us shifted by N samples (~seconds)`);
if (!S.leadLag) console.log("   not enough samples");
else {
  const row = Object.entries(S.leadLag).sort((x, y) => x[0] - y[0]).map(([lag, c]) => `${lag >= 0 ? "+" : ""}${lag}: ${c == null ? "—" : c.toFixed(2)}`).join("   ");
  console.log(`   ${row}`);
  const best = Object.entries(S.leadLag).filter(([, c]) => c != null).sort((a, b) => b[1] - a[1])[0];
  if (best) console.log(`   peak at ${best[0]}: ${best[0] > 0 ? ".us follows Kalshi" : best[0] < 0 ? "Kalshi follows .us" : "they move together within a sample"} (sample spacing ~1s, so sub-second leads read as 0)`);
}

console.log(`\nCAVEATS: Kalshi depth is its top 10 levels a side (the 1-second record); .us depth is the whole book.`);
console.log(`Maker strategies (resting on .us for its rebate, hedging on Kalshi) are not modelled — they need queue position.`);
