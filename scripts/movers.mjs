// Movers and most-traded across Kalshi, Polymarket US and polymarket.com,
// for the free home page. Runs on the box every 15 minutes
// (deploy/marketslap-movers.timer); the page reads the result through
// /api/movers and never touches a venue.
//
//   node scripts/movers.mjs            read the venues, write `movers`
//   node scripts/movers.mjs --dry      read the venues, print, write nothing
//                                      (needs no Supabase at all)
//
// Writes need SUPABASE_SERVICE_ROLE_KEY: `movers` is readable by anyone
// and writable by no one else (migration 0035).
//
// A venue whose read did not complete keeps its previous rows and fails
// the run. Replacing a venue's lists with what a throttled sweep happened
// to see is the silent no-op this repo keeps being rewritten to stop.
import {
  sweepKalshi, fetchCom, fetchComByIds, sweepUs, usTight, usRow, usBbo,
  snapshotOf, dayAgoSnapshot, SNAPSHOT_EVERY_MS, US_BBO_BUDGET, US_BBO_PAUSE_MS,
  appendHistory, fromHistory, rankVenue, indexPairs, counterpartIds, storedRow,
  kalshiMarketUrl, usUrl, DAY_MS,
} from "../lib/movers.js";
import { fetchUsEventSlugs } from "../lib/polymarketUs.js";
import { pageAll } from "../lib/restPage.js";
import { authHeaders, writeHeaders } from "../lib/supabaseHeaders.js";
import { assertCredential } from "../lib/supabaseCredential.js";

const DRY = process.argv.includes("--dry");
const arg = (name, dflt) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1] ?? dflt);
const US_BUDGET = arg("us-budget", US_BBO_BUDGET);
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!DRY && (!URL_ || !KEY)) {
  console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or pass --dry)");
  process.exit(2);
}

const t0 = Date.now();
const now = Date.now();
const runAt = new Date(now).toISOString();
const nowSec = Math.floor(now / 1000);
const timings = {};
const lap = (k, s) => { timings[k] = Math.round((Date.now() - s) / 1000); console.log(`  ${k} done in ${timings[k]}s`); };
const failures = [];
const warnings = [];

async function rest(path) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: authHeaders(KEY) });
  if (!r.ok) throw new Error(`${path.split("?")[0]}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function write(method, path, body, prefer) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    method, headers: writeHeaders(KEY, { prefer }), body: body == null ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${path.split("?")[0]}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}
async function upsert(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 500) {
    await write("POST", `${table}?on_conflict=${onConflict}`, rows.slice(i, i + 500), "resolution=merge-duplicates,return=minimal");
  }
}
// Ids go in the query string, so chunk them (CLAUDE.md, `.in()`).
async function byIds(table, select, ids, col = "id") {
  const out = [];
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 100) {
    const inList = list.slice(i, i + 100).map(v => `"${String(v).replace(/"/g, "")}"`).join(",");
    out.push(...await rest(`${table}?select=${select}&${col}=in.(${encodeURIComponent(inList)})`));
  }
  return out;
}

// ------------------------------------------------------------ what we hold

let pairs = indexPairs([]);
let history = new Map();
let lastUsTop = [];
let snapAts = [];
if (!DRY) {
  await assertCredential(URL_, KEY, { table: "movers" });
  const s = Date.now();
  // A failed read throws: ranking without pairs would only lose the
  // cross-venue column, but without history every .us row would restart
  // its day, so neither is allowed to read as empty.
  pairs = indexPairs(await pageAll(rest, "pairs", "id,kalshi_id,polymarket_id", "", { key: "id" }));
  for (const h of await pageAll(rest, "mover_history", "market_id,hist", "venue=eq.polymarket_us", { key: "market_id" })) {
    history.set(h.market_id, h.hist);
  }
  lastUsTop = (await rest("movers?select=market_id&venue=eq.polymarket_us&list=eq.traded&limit=1000")).map(r => r.market_id);
  snapAts = await rest("mover_snapshots?select=at&venue=eq.polymarket_us&order=at.desc&limit=100");
  lap("reads", s);
}
const pairedKalshi = new Set(pairs.byKalshi.keys());
const pairedPoly = [...pairs.byPoly.keys()];
const pairedCom = pairedPoly.filter(id => /^\d+$/.test(id));
const pairedUs = pairedPoly.filter(id => !/^\d+$/.test(id));

// ------------------------------------------------------------ the venues

const venues = {};

async function readKalshi() {
  const s = Date.now();
  const k = await sweepKalshi({ keep: id => pairedKalshi.has(id), now });
  lap("kalshi", s);
  if (!k.complete) failures.push(k.failure);
  venues.kalshi = { rows: k.rows, complete: k.complete, note: `${k.pages} pages, ${k.rows.length} markets with volume or a pair` };
}

async function readCom() {
  const s = Date.now();
  const c = await fetchCom({ now });
  if (!c.complete) failures.push(c.failure);
  const have = new Set(c.rows.map(r => r.market_id));
  const extra = await fetchComByIds(pairedCom.filter(id => !have.has(id)), { now });
  lap("polymarket", s);
  venues.polymarket = { rows: [...c.rows, ...extra], complete: c.complete, note: `${c.pages} pages, ${c.rows.length} markets, ${extra.length} paired fetched by id` };
}

async function readUs() {
  const s = Date.now();
  let eventOf = new Map();
  // 100 events a page, not the default 500: a 500-event page is 26MB of
  // JSON and peaked this lookup alone at ~300MB, which the box's 400MB
  // cap on this unit killed on the first run (2026-11-27).
  try { eventOf = await fetchUsEventSlugs({ pageSize: 100, maxPages: 200 }); } catch (e) { warnings.push(`.us event slugs: ${e.message}`); }
  const pool = new Map();
  const pairedSet = new Set(pairedUs);
  const sweep = await sweepUs({
    onMarket: m => {
      if (!m?.slug || !(usTight(m) || pairedSet.has(m.slug))) return;
      const r = usRow(m, eventOf.get(m.slug) || null);
      if (r) pool.set(r.market_id, r);
    },
  });
  if (!sweep.complete) failures.push(sweep.failure);
  lap("polymarket_us_list", s);

  // Open GAMES are not in the list at all (CLAUDE.md, Polymarket US), so
  // a paired game has to be described from our own row.
  const missing = pairedUs.filter(id => !pool.has(id));
  if (missing.length && !DRY) {
    for (const m of await byIds("markets", "id,title,side_label,event_ticker,close_time,sport_tag", missing)) {
      pool.set(m.id, {
        venue: "polymarket_us", market_id: m.id, event_id: m.event_ticker || m.id, title: m.title,
        outcome: m.side_label || null, category: ["econ"].includes(m.sport_tag) ? "economics" : ["crypto", "politics"].includes(m.sport_tag) ? m.sport_tag : "sports",
        price: null, prev: null, volume_usd: null, closes_at: m.close_time || null, created_at: null, url: usUrl(m.id, m.event_ticker),
      });
    }
  }

  // MOVES: the day-ago price from our hourly snapshot of every book.
  const snap = dayAgoSnapshot(snapAts, now);
  let dayAgo = {};
  if (snap && !DRY) {
    const got = await rest(`mover_snapshots?select=prices&venue=eq.polymarket_us&at=eq.${encodeURIComponent(snap.at)}`);
    dayAgo = got[0]?.prices || {};
  }

  // Every pool market's figures. Games (not in the list) take their
  // price and day-ago price from the /bbo history below.
  const figures = () => {
    const out = [];
    for (const r of pool.values()) {
      const h = touched.get(r.market_id) ?? history.get(r.market_id);
      const f = fromHistory(h, nowSec);
      const price = r.price ?? f.latest?.[1] ?? null;
      if (price == null) continue;
      const prev = dayAgo[r.market_id] ?? (r.price == null ? f.prev : null);
      out.push({ ...r, price, prev, volume_usd: f.volumeShares == null ? null : f.volumeShares * (prev != null ? (price + prev) / 2 : price) });
    }
    return out;
  };
  const touched = new Map();
  const before = figures();

  // VOLUME: a paced /bbo read of the books that can make a list — every
  // paired one, this run's biggest .us moves and last run's most traded —
  // folded into each book's history (all-time shares, differenced).
  const s2 = Date.now();
  const bigMoves = before.filter(r => r.prev != null).sort((x, y) => Math.abs(y.price - y.prev) - Math.abs(x.price - x.prev)).slice(0, 40).map(r => r.market_id);
  const plan = [...new Set([...bigMoves, ...lastUsTop, ...pairedUs])].filter(id => pool.has(id)).slice(0, US_BUDGET);
  let errors = 0;
  for (const slug of plan) {
    const b = await usBbo(slug);
    if (b.error) { if (!b.notFound) errors++; }
    else if (b.price != null || b.shares != null) touched.set(slug, appendHistory(history.get(slug), [nowSec, b.price, b.shares]));
    await new Promise(r => setTimeout(r, US_BBO_PAUSE_MS));
  }
  lap("polymarket_us_bbo", s2);
  if (plan.length && errors > plan.length * 0.2) warnings.push(`polymarket.us: ${errors} of ${plan.length} /bbo reads failed`);

  const rows = figures();
  venues.polymarket_us = {
    rows, complete: sweep.complete, touched, pool,
    note: `${sweep.pages} pages, pool ${pool.size}, day-ago snapshot ${snap ? snap.at : "none yet"}, read ${touched.size}/${plan.length} books (${errors} errors), ${rows.filter(r => r.prev != null).length} with a move, ${rows.filter(r => r.volume_usd != null).length} with a volume`,
  };
}

// ONE AFTER ANOTHER, not side by side. Together they peaked past the
// unit's 400MB cap on a 1GB box shared with the recorders, and the OOM
// killer ended the first run. Sequential costs about a minute of a
// 15-minute interval.
await readCom();
await readKalshi();
await readUs();

// ------------------------------------------------------------ rank and link

const byVenueId = {};
for (const [v, d] of Object.entries(venues)) byVenueId[v] = new Map(d.rows.map(r => [r.market_id, r]));

const ranked = {};
for (const [v, d] of Object.entries(venues)) ranked[v] = rankVenue(d.rows, now);

// The three-segment Kalshi URL where we hold the series slug; the
// search URL otherwise, which is a real route.
if (!DRY) {
  const ids = [...ranked.kalshi.moves, ...ranked.kalshi.traded].map(r => r.market_id);
  try {
    const slugs = new Map((await byIds("markets", "id,series_slug,event_ticker", ids)).map(m => [m.id, m]));
    for (const r of [...ranked.kalshi.moves, ...ranked.kalshi.traded]) {
      const m = slugs.get(r.market_id);
      const u = m && kalshiMarketUrl(r.market_id, m.event_ticker || r.event_id, m.series_slug);
      if (u) r.url = u;
    }
  } catch (e) { warnings.push(`kalshi links: ${e.message}`); }
}

const stored = [];
for (const [v, lists] of Object.entries(ranked)) {
  if (!venues[v].complete) continue;
  for (const list of ["moves", "traded"]) {
    for (const r of lists[list]) {
      const also = counterpartIds(v, r.market_id, pairs)
        .map(c => byVenueId[c.venue]?.get(c.id))
        .filter(Boolean);
      stored.push(storedRow(r, list, also, runAt));
    }
  }
}

// ------------------------------------------------------------ report

const fmt = r => `${r.category.padEnd(9)} ${(r.prev == null ? "" : `${r.prev.toFixed(2)}->`).padStart(6)}${r.price.toFixed(2)}  $${Math.round(r.volume_usd ?? 0).toLocaleString().padStart(10)}  ${String(r.title).slice(0, 60)}${r.outcome ? ` — ${String(r.outcome).slice(0, 30)}` : ""}`;
for (const [v, d] of Object.entries(venues)) {
  console.log(`\n== ${v}: ${d.note}${d.complete ? "" : "  [INCOMPLETE — previous rows kept]"}`);
  for (const list of ["moves", "traded"]) {
    const xs = ranked[v][list];
    const score = list === "moves" ? (r => Math.abs(r.price - r.prev)) : (r => r.volume_usd);
    console.log(`  ${list}: ${xs.length} rows`);
    for (const r of [...xs].sort((a, b) => score(b) - score(a)).slice(0, DRY ? 8 : 4)) console.log(`    ${fmt(r)}`);
  }
}
const OUT = process.argv.find(a => a.startsWith("--out="))?.slice(6);
if (OUT) { (await import("node:fs")).writeFileSync(OUT, JSON.stringify(stored)); console.log(`rows written to ${OUT}`); }
console.log(`\nrows to store: ${stored.length}, with another venue attached: ${stored.filter(r => r.also.length).length}`);

// ------------------------------------------------------------ write

if (!DRY) {
  const s = Date.now();
  try {
    await upsert("movers", stored, "venue,market_id,list");
    // Only a venue whose read completed loses its old rows.
    for (const v of Object.keys(venues).filter(v => venues[v].complete)) {
      await write("DELETE", `movers?venue=eq.${v}&updated_at=lt.${encodeURIComponent(runAt)}`, null, "return=minimal");
    }
    const hist = [...(venues.polymarket_us.touched || new Map())].map(([market_id, h]) => ({ venue: "polymarket_us", market_id, hist: h, updated_at: runAt }));
    await upsert("mover_history", hist, "venue,market_id");
    // One price snapshot an hour, of every tracked .us book.
    const latestSnap = Date.parse(snapAts[0]?.at || 0);
    if (venues.polymarket_us.complete && !(now - latestSnap < SNAPSHOT_EVERY_MS)) {
      await upsert("mover_snapshots", [{ venue: "polymarket_us", at: runAt, prices: snapshotOf(venues.polymarket_us.pool.values()) }], "venue,at");
      await write("DELETE", `mover_snapshots?venue=eq.polymarket_us&at=lt.${encodeURIComponent(new Date(now - 31 * 3600e3).toISOString())}`, null, "return=minimal");
      console.log("wrote a .us price snapshot");
    }
    // A book not visited for two days has no day-ago entry left to give.
    await write("DELETE", `mover_history?updated_at=lt.${encodeURIComponent(new Date(now - 2 * DAY_MS).toISOString())}`, null, "return=minimal");
    console.log(`wrote ${stored.length} movers rows and ${hist.length} .us histories`);
  } catch (e) {
    failures.push(`write: ${e.message}`);
  }
  lap("write", s);
}

console.log(`timings (s): ${JSON.stringify(timings)}, total ${Math.round((Date.now() - t0) / 1000)}s`);
for (const w of warnings) console.log(`::warning::${w}`);
for (const f of failures) console.error(`::error::${f}`);
process.exit(failures.length ? 1 : 0);
