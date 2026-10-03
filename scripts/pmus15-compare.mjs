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
import { newCompare, feedKalshi, feedPmus, summarize, episodeStats, delayStats, KALSHI_SERIES } from "../lib/venueCompare.js";
import { newFinal, feedKalshiFinal, finalReplay, finalDelayStats, finalEpisodeStats } from "../lib/venueFinal.js";

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
// The Kalshi archive carries other series too; only this one's lines are
// parsed: its 1-second books, its final-window record (every change, for
// the replay in 3c), and the recorder's gap and socket events, which say
// where that record cannot be trusted.
const needle = `"m":"${KALSHI_SERIES}-`, anyTicker = `"${KALSHI_SERIES}-`;
const F = newFinal();
const keepK = line =>
  ((line.startsWith('{"k":"b"') || line.startsWith('{"k":"d"') || line.startsWith('{"k":"full"') || line.startsWith('{"k":"final"')) && line.includes(needle))
  || (line.startsWith('{"k":"gap"') && line.includes(anyTicker))
  || line.startsWith('{"k":"conn"');
for (const f of kFiles) bad += await reader.eachLine(f.path, o => { feedKalshi(C, o); feedKalshiFinal(F, o); }, keepK);
const iso = t => Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : "—";
console.log(`.us books ${iso(C.pmusFirst)} -> ${iso(C.pmusLast)} UTC, Kalshi books ${iso(C.kalshiFirst)} -> ${iso(C.kalshiLast)} UTC${bad ? `, ${bad} unparseable lines` : ""}`);
{
  const L = [...C.kalshiLagMs].sort((a, b) => a - b), q = p => L.length ? (L[Math.min(L.length - 1, Math.floor(p * L.length))] / 1000).toFixed(1) : "—";
  console.log(`Kalshi recorder receive lag (box time minus Kalshi's): p50 ${q(0.5)}s, p90 ${q(0.9)}s, max ${q(1)}s — samples are paired on each venue's OWN clock, so this costs coverage, not correctness`);
}
console.log(`.us recorder: connection events ${JSON.stringify(C.pmusConn)}, socket errors ${C.pmusErrors}, trades seen ${C.pmusTrades.toLocaleString()}`);

const S = summarize(C);
const pct = (a, n) => n ? `${(100 * a / n).toFixed(1)}%` : "—";
console.log(`\n${S.windows} windows on both venues, ${S.samples.toLocaleString()} paired samples (a fresh Kalshi book + the .us book current at that instant)`);
if (!S.samples) { console.log("::error::no paired samples — check both recorders cover the same hours"); process.exit(1); }

console.log(`\n1. SAME MARKET? (touch against touch)`);
console.log(`   of ${S.agree.twoSided.toLocaleString()} samples with both books two-sided: bid and ask equal ${pct(S.agree.exact, S.agree.twoSided)}, within 1c ${pct(S.agree.within1c, S.agree.twoSided)}`);
console.log(`   away from 50c (${S.agree.decisive.toLocaleString()} samples, where the side is decidable): as Up=YES within 1c ${pct(S.agree.decisiveWithin1c, S.agree.decisive)}, as the MIRROR ${pct(S.agree.mirrorWithin1c, S.agree.decisive)} — the second must be far lower`);

console.log(`\n2. HOW OFTEN DO THE BOOKS CROSS?`);
console.log(`   before fees (one venue's bid above the other's ask): ${pct(S.grossCross, S.agree.twoSided)} of two-sided samples`);
console.log(`   after both venues' taker fees, at the best size the books allow:`);
console.log(`     A  YES on Kalshi + DOWN on .us: ${pct(S.byDir.A.positive, S.samples)}`);
console.log(`     B  UP on .us + NO on Kalshi:    ${pct(S.byDir.B.positive, S.samples)}`);
console.log(`   by time to close:`);
for (const [k, v] of Object.entries(S.byBucket)) console.log(`     ${k.padEnd(6)} ${pct(v.positive, v.samples).padStart(6)} of ${v.samples.toLocaleString()} samples  (one-sided ${S.oneSided[k].toLocaleString()}; unpaired, no .us book within 15s: ${S.skipped[k].noPmus.toLocaleString()})`);

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

if (E.n) {
  const D = delayStats(S.episodes);
  console.log(`\n3b. AFTER A DELAY: both legs sent at the edge's best moment as limit orders at the prices it walked,`);
  console.log(`    arriving later. "full" = both legs filled in full; "legged" = one leg filled without the other (leg risk)`);
  for (const [d, r] of Object.entries(D)) {
    if (!r.known) continue;
    console.log(`    +${String(d).padStart(4)}ms  full ${pct(r.full, r.known).padStart(6)}  partial ${pct(r.partial, r.known).padStart(6)}  none ${pct(r.none, r.known).padStart(6)}  legged ${pct(r.legged, r.known).padStart(6)}  kept $${r.dollars.toFixed(2)} of $${E.dollars.toFixed(2)}`);
  }
  console.log(`    The Kalshi record is one book a second, so under 1000ms this mostly measures how fast .us moves.`);
}

{
  const R = finalReplay(C, F);
  const X = R.excluded;
  console.log(`\n3c. THE FINAL TWO MINUTES, TO THE MILLISECOND: every Kalshi book change replayed against every .us book,`);
  console.log(`    acting at the FIRST moment an edge appears (no hindsight). Delay runs from the exchange time of the change`);
  console.log(`    that made the edge, so it must cover publication, the socket, deciding, and both orders reaching both venues.`);
  console.log(`    ${R.windows} windows replayed (${R.kalshiEvents.toLocaleString()} Kalshi book changes); left out: ${X.disrupted} interrupted (gap or socket event), ${X.noUs} with no .us book, ${X.noFinal} with no final-window record`);
  if (R.selfCrossed) console.log(`    ::warning::${R.selfCrossed} moments where the replayed Kalshi book crossed itself — the replay is missing changes`);
  const ES = finalEpisodeStats(R.episodes);
  if (!ES.n) console.log(`    no edges after fees in the replayed windows`);
  else {
    const u = ms => pct(ES.under[ms], ES.n);
    console.log(`    ${ES.n} edges; lasted: median ${ES.medianMs}ms, p90 ${ES.p90Ms}ms; under 50ms ${u(50)}, under 100ms ${u(100)}, under 250ms ${u(250)}, under 1s ${u(1000)}`);
    console.log(`    worth $${ES.firstDollars.toFixed(2)} at first sight (vs $${ES.bestDollars.toFixed(2)} at each edge's best moment, which a bot cannot know)`);
    for (const [d, r] of Object.entries(finalDelayStats(R.episodes))) {
      if (!r.known) continue;
      console.log(`    +${String(d).padStart(4)}ms  full ${pct(r.full, r.known).padStart(6)}  partial ${pct(r.partial, r.known).padStart(6)}  none ${pct(r.none, r.known).padStart(6)}  legged ${pct(r.legged, r.known).padStart(6)}  kept $${r.dollars.toFixed(2)} of $${ES.firstDollars.toFixed(2)}`);
    }
    console.log(`    Our own orders do not move these books and nobody reacts to them; the two venues' clocks may differ by a few ms.`);
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
