// What is actually in the 15-minute data, for one series.
//
// The FIRST question before any strategy: is there anything here. This
// reports base rates, the settled sample, and how much price PATH we
// hold — kept separate because they come from different places and one
// of them is much thinner than the other:
//
//   m15_markets  BACKFILLED from Kalshi's settled markets, so it goes
//                back months and carries `result`. No price path — a
//                settled market reports only its last price.
//   m15_quotes   RECORDED live since 2026-09-06 and unrecoverable
//                before that. This is the half that decays if the
//                recorder stops.
//
// Reads only. Anon-key readable (migration 0016 grants select), so it
// needs no service-role credential.
//
// Usage: node scripts/m15-analyze.mjs [SERIES ...]
//        node scripts/m15-analyze.mjs KXGOLD15M KXSILVER15M

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL / SUPABASE_ANON_KEY not set"); process.exit(2); }

const series = process.argv.slice(2).filter(a => !a.startsWith("-"));
if (!series.length) series.push("KXGOLD15M", "KXSILVER15M");

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// KEYSET, like every other pager in this repo. An OFFSET pager over a
// table that grows ~50k rows a day is the bug this project has fixed
// four times.
async function readAll(table, select, extra, keyCol = "id") {
  const out = [];
  let last = null;
  for (let page = 0; page < 2000; page++) {
    const after = last == null ? "" : `&${keyCol}=gt.${encodeURIComponent(last)}`;
    const rows = await rest(`${table}?select=${select}&${extra}${after}&order=${keyCol}.asc&limit=1000`);
    out.push(...rows);
    if (rows.length < 1000) return out;
    last = rows[rows.length - 1][keyCol];
  }
  throw new Error(`readAll hit its page cap at ${out.length} rows — TRUNCATED`);
}

const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : "—");
const med = a => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

for (const s of series) {
  console.log(`\n${"=".repeat(64)}\n${s}\n${"=".repeat(64)}`);

  const mk = await readAll("m15_markets",
    "ticker,close_time,result,last_price,volume,open_interest,strike",
    `series=eq.${encodeURIComponent(s)}`, "ticker");

  if (!mk.length) { console.log("  no markets stored"); continue; }

  const settled = mk.filter(m => m.result === "yes" || m.result === "no");
  const yes = settled.filter(m => m.result === "yes").length;
  const times = mk.map(m => m.close_time).filter(Boolean).sort();
  const vols = mk.map(m => Number(m.volume) || 0).filter(v => v > 0);

  console.log(`  markets stored     ${mk.length}`);
  console.log(`  settled            ${settled.length}`);
  console.log(`  window             ${(times[0] || "?").slice(0, 10)} .. ${(times[times.length - 1] || "?").slice(0, 10)}`);
  console.log(`  volume             median ${Math.round(med(vols)).toLocaleString()}  total ${Math.round(vols.reduce((a, b) => a + b, 0)).toLocaleString()}`);

  // THE BASE RATE. A coin-flip market should sit near 50%; a
  // meaningful skew is the first thing any strategy has to beat, and
  // the first thing that would make a naive "always buy NO" look
  // profitable in a backtest for the wrong reason.
  console.log(`  resolved YES       ${yes} of ${settled.length}  (${pct(yes, settled.length)})`);

  // Kalshi's last traded price against what actually happened. If the
  // market is well calibrated these track; a gap is where an edge
  // would live — and is also where a bad backtest finds a fake one.
  const priced = settled.filter(m => Number.isFinite(Number(m.last_price)));
  if (priced.length) {
    const buckets = [[0, .2], [.2, .4], [.4, .6], [.6, .8], [.8, 1.01]];
    console.log(`  calibration of the LAST traded price (n=${priced.length}):`);
    console.log(`    ${"price band".padEnd(12)} ${"n".padStart(6)} ${"resolved YES".padStart(13)}`);
    for (const [lo, hi] of buckets) {
      const b = priced.filter(m => { const p = Number(m.last_price); return p >= lo && p < hi; });
      if (!b.length) continue;
      const by = b.filter(m => m.result === "yes").length;
      console.log(`    ${`${lo.toFixed(1)}-${hi >= 1 ? "1.0" : hi.toFixed(1)}`.padEnd(12)} ${String(b.length).padStart(6)} ${pct(by, b.length).padStart(13)}`);
    }
  }

  // The price PATH. Only exists from the day the recorder started, and
  // a day not recorded is gone for good — so the count is reported
  // even when it is small, rather than the section being skipped.
  // SAMPLE THE MOST RECENT MARKETS, NOT THE FIRST 300.
  //
  // The first version sliced the ticker list as it came back, which is
  // keyset order — alphabetical — and "26AUG" sorts before "26SEP", so
  // it sampled AUGUST markets and asked whether a recorder that only
  // started on 2026-09-06 had quotes for them. It reported `0` and the
  // recorder was working fine.
  //
  // Same defect as the page log that printed only slow pages and made
  // page cost look independent of page size: a biased sample read as
  // if it were the population. Sorted by close_time, newest first.
  const recent = mk
    .filter(m => m.close_time)
    .sort((a, b) => String(b.close_time).localeCompare(String(a.close_time)))
    .slice(0, 300)
    .map(m => m.ticker);
  const q = await readAll("m15_quotes", "id,ticker,secs_to_close,yes_bid,yes_ask",
    `ticker=in.(${recent.map(t => `"${t}"`).join(",")})&`);
  const covered = new Set(q.map(r => r.ticker));
  console.log(`  quote rows         ${q.length} across ${covered.size} of the 300 most recent markets`);
  if (recent.length) {
    console.log(`  newest sampled     ${recent[0]}  (closes ${String(mk.find(m => m.ticker === recent[0]).close_time).slice(0, 16)})`);
  }
  if (q.length) {
    const late = q.filter(r => Number(r.secs_to_close) > 0 && Number(r.secs_to_close) <= 120);
    console.log(`  in the last 2 min  ${late.length} rows — the window a short-horizon signal would trade`);
  }
}
console.log();
