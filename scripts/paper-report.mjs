// What the paper bot (scripts/paper-m15.mjs) did over the last N days,
// per series and rule, from paper_trades. Read-only; service-role key
// (the table is private, migration 0031).
//
//   node scripts/paper-report.mjs [--days=7]
import { authHeaders } from "../lib/supabaseHeaders.js";
import { pageAll } from "../lib/restPage.js";
import { summarizePaper } from "../lib/paperM15.js";

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(2); }
const DAYS = Number((process.argv.find(a => a.startsWith("--days=")) || "--days=7").split("=")[1]);
const SINCE = new Date(Date.now() - DAYS * 86400000).toISOString();

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: authHeaders(KEY) });
  if (r.status === 404) { console.log("paper_trades does not exist yet — run migration 0031 and start the paper bot"); process.exit(0); }
  if (!r.ok) throw new Error(`GET ${path.slice(0, 60)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const rows = await pageAll(rest, "paper_trades",
  "id,series,rule,side,close_time,qty_wanted,qty_filled,fill_latency_ms,result,pnl", `close_time=gte.${SINCE}`, { key: "id" });

console.log(`PAPER TRADES — last ${DAYS} days (decided live on Kalshi's book; nothing was sent)`);
if (!rows.length) { console.log("  none yet"); process.exit(0); }
const $ = v => v == null ? "—" : (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
const c = v => v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}c`;
const pct = v => v == null ? "—" : `${(100 * v).toFixed(0)}%`;
let series = null;
for (const g of summarizePaper(rows)) {
  if (g.series !== series) {
    series = g.series;
    console.log(`\n${series}\n  ${"rule".padEnd(13)} ${"days".padStart(4)} ${"fired".padStart(5)} ${"filled".padStart(6)} ${"missed".padStart(6)} ${"win".padStart(5)}  ${"P&L".padStart(8)} ${"per ctr".padStart(8)} ${"latency".padStart(8)}`);
  }
  console.log(`  ${g.rule.padEnd(13)} ${String(g.days).padStart(4)} ${String(g.decisions).padStart(5)} ${pct(g.fillRate).padStart(6)} ${String(g.missed).padStart(6)} ${pct(g.winRate).padStart(5)}  ${$(g.pnl).padStart(8)} ${c(g.pnlPerContract).padStart(8)} ${(g.latencyP50 == null ? "—" : g.latencyP50 + "ms").padStart(8)}`);
}
console.log(`
- "filled" is the share of decisions where a second read of the book still offered the price the rule saw.
  A rule that wins in the backtest but keeps MISSING here is an edge that is gone before an order lands.
- "latency" is the median from the deciding read to the second read: this box, not a trading box.
- P&L counts settled fills only, after Kalshi's taker fee. Still taker-at-the-touch: no queue, no slippage past it.`);
