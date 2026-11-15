// The ladder recorder (docs/research/ladder-step2-plan.md): every book
// change and every trade on Bitcoin's hourly strike ladders in the final
// 16 minutes before each hourly close, on ONE socket, so every market at a
// close shares one sequence and one clock (Kalshi's ts_ms).
//
// At each hourly close H it records the KXBTC15M window closing then, plus
// the KXBTCD and KXBTC markets within ±2.5% of the at-the-money strike
// (lib/ladder.js chooseLadderScope), at most 80 markets. Lines, hourly
// gzipped NDJSON under ladder/ in the PRIVATE stream-archive bucket:
//
//   k:"sel"   the choice for a close: reference strike, tickers
//   k:"mkt"   one per market: strike fields and close, so the analysis
//             needs no REST call
//   k:"full"  the whole book, on every snapshot (subscribe, gap repair,
//             reconnect)
//   k:"d"     EVERY change: side, price, size delta, Kalshi's ts_ms (x), seq
//   k:"tr"    every trade
//   k:"gap" / k:"conn" / k:"health" / k:"end"
//
// It runs BESIDE marketslap-m15-stream, never inside it, and stops itself
// (exit 3, which the unit does not restart) if it falls behind its socket
// or the box runs short of memory: the live research's recorder comes
// first. Read-only Kalshi key through LoadCredential, as m15-stream. It
// sends no order and names no order endpoint.
//
// Recorded Kalshi data is private: never make the bucket public, never
// commit an archive file.

import { mkdirSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { KALSHI_REST, KALSHI_WS, WS_PATH, keyPath, loadKalshiKey, kalshiAuthHeaders } from "../lib/kalshiAuth.js";
import { BookSet } from "../lib/kalshiBook.js";
import { assertCredential } from "../lib/supabaseCredential.js";
import { recorderSource } from "../lib/recorderSource.js";
import { createArchive } from "../lib/streamArchive.js";
import { kalshiWebSocket } from "../lib/plainWebSocket.js";
import { chooseLadderScope } from "../lib/ladder.js";

const env = process.env;
const SUPABASE_URL = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = env.STREAM_BUCKET || "stream-archive";
const DIR = env.LADDER_DIR || env.STATE_DIRECTORY || "/var/lib/marketslap-ladder";
const LADDER_SERIES = (env.LADDER_SERIES || "KXBTCD KXBTC").split(/[\s,]+/).filter(Boolean);
const M15_SERIES = env.LADDER_M15_SERIES || "KXBTC15M";
const PERIOD_MS = Number(env.LADDER_PERIOD_MS || 3600000);       // closes on the hour
const LEAD_MS = Number(env.LADDER_LEAD_SECONDS || 960) * 1000;   // record the final 16 minutes
const SELECT_AHEAD_MS = Number(env.LADDER_SELECT_AHEAD_MS || 60000);
const END_AFTER_MS = Number(env.LADDER_END_AFTER_MS || 10000);
const BAND = Number(env.LADDER_BAND || 0.025), CAP = Number(env.LADDER_CAP || 80);
const RUN_MINUTES = Number(env.LADDER_RUN_MINUTES || 60);
const ROTATE_MS = Number(env.LADDER_ROTATE_MS || 3600000);
const SILENCE_MS = Number(env.LADDER_SILENCE_MS || 30000);
const HEALTH_MS = Number(env.LADDER_HEALTH_MS || 60000);
const UPLOAD_MS = Number(env.LADDER_UPLOAD_MS || 60000);
// The load stop, from the plan: lag p99 over 1s, or under 100MB available.
const LAG_STOP_MS = Number(env.LADDER_LAG_STOP_MS || 1000), LAG_STOP_RUNS = Number(env.LADDER_LAG_STOP_RUNS || 5);
const MEM_STOP_MB = Number(env.LADDER_MEM_STOP_MB || 100), MEM_STOP_RUNS = Number(env.LADDER_MEM_STOP_RUNS || 3);
const SOURCE = recorderSource(env, "LADDER_SOURCE");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Preconditions: all fatal, all before a socket is opened ────────────
if (!SUPABASE_URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (the archive bucket is private)"); process.exit(1); }
const kalshiKeyId = env.KALSHI_KEY_ID;
let kalshiKey;
try { kalshiKey = loadKalshiKey(keyPath(env)); } catch (e) { console.error(`::error::${e.message}`); process.exit(1); }
if (!kalshiKeyId) { console.error("::error::KALSHI_KEY_ID is not set in /etc/marketslap/env — run scripts/kalshi-key-setup.mjs"); process.exit(1); }
const KalshiWS = kalshiWebSocket(env);   // never Node's built-in: see lib/plainWebSocket.js
if (typeof KalshiWS !== "function") { console.error("::error::no WebSocket client available"); process.exit(1); }
await assertCredential(SUPABASE_URL, KEY, { table: "m15_quotes", unavailableIsFatal: false, log });
mkdirSync(DIR, { recursive: true });
log(`source: ${SOURCE}, archive ${DIR} -> ${BUCKET}/ladder, series ${LADDER_SERIES.join(" ")} + ${M15_SERIES}, final ${LEAD_MS / 1000}s of each ${PERIOD_MS / 60000}-minute close`);

const stats = { frames: 0, deltas: 0, fulls: 0, trades: 0, gaps: 0, reconnects: 0, errors: 0, closes: 0, skipped: 0 };
const archive = createArchive({
  dir: DIR, bucket: BUCKET, supabaseUrl: SUPABASE_URL, key: KEY, prefix: "ladder", source: SOURCE, rotateMs: ROTATE_MS, log,
  meta: now => ({ k: "meta", t: now, source: SOURCE, yesLeg: true, leadSeconds: LEAD_MS / 1000, band: BAND, cap: CAP, v: 1 }),
});
const write = o => archive.write(o);
{
  const bad = await archive.probe();
  if (bad) { for (const l of bad) console.error(`::error::${l}`); process.exit(1); }
}
archive.recoverLeftovers();

async function restGet(path) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${KALSHI_REST}${path}`);
      if (r.ok) return await r.json();
      if (r.status !== 429 && r.status < 500) return null;
      const ra = Number(r.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10000) : 1000 * 2 ** i);
    } catch { await sleep(1000 * 2 ** i); }
  }
  return null;
}

// Every market of a series closing exactly at `close`. Null when a page
// could not be read: a partial ladder is not selected from.
async function marketsClosingAt(series, close) {
  const out = [], s = Math.floor(close / 1000);
  let cursor = "";
  do {
    const r = await restGet(`/markets?series_ticker=${series}&min_close_ts=${s}&max_close_ts=${s}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!r) return null;
    for (const m of r.markets || []) if (Date.parse(m.close_time) === close) out.push(m);
    cursor = r.cursor || "";
  } while (cursor);
  return out;
}

// The markets for one close, written to the archive. Null when nothing
// could be selected (named in the log and in a k:"sel" line).
async function select(close) {
  const now = Date.now(), iso = new Date(close).toISOString();
  const ladder = [];
  for (const s of LADDER_SERIES) {
    const ms = await marketsClosingAt(s, close);
    if (!ms) { write({ k: "sel", t: now, close: iso, ref: null, n: 0, why: `could not list ${s}` }); log(`::warning::${iso}: could not list ${s}; this close is not recorded`); return null; }
    ladder.push(...ms);
  }
  const w15 = (await marketsClosingAt(M15_SERIES, close))?.[0] || null;
  const sc = chooseLadderScope(ladder, { band: BAND, cap: CAP, m15: w15?.ticker || null });
  if (sc.ref == null) { write({ k: "sel", t: now, close: iso, ref: null, n: 0, why: "no two-sided threshold quote" }); log(`::warning::${iso}: no quoted ladder (${ladder.length} markets listed); this close is not recorded`); return null; }
  const by = new Map([...ladder, ...(w15 ? [w15] : [])].map(m => [m.ticker, m]));
  write({ k: "sel", t: now, close: iso, ref: sc.ref, n: sc.tickers.length, inBand: sc.inBand, listed: ladder.length, m15: w15?.ticker || null, late: now > close - LEAD_MS });
  for (const t of sc.tickers) {
    const m = by.get(t);
    write({ k: "mkt", t: now, m: t, close: m.close_time, st: m.status, type: m.strike_type, floor: m.floor_strike ?? null, cap: m.cap_strike ?? null, custom: m.custom_strike ?? null });
  }
  log(`${iso}: ${sc.tickers.length} markets (ref ${sc.ref}, ${sc.inBand} in band of ${ladder.length} listed${w15 ? "" : ", NO 15-minute market"})`);
  return sc.tickers;
}

// ── Health and the load stop ───────────────────────────────────────────
const memAvailableMB = () => {
  try { const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8")); return m ? Math.round(Number(m[1]) / 1024) : null; } catch { return null; }
};
const health = { lags: [], frames: 0, elu: performance.eventLoopUtilization(), ext: null, slow: 0, lowMem: 0 };
let loadStop = null;
function writeHealth(now) {
  const L = health.lags.sort((a, b) => a - b), q = p => L.length ? L[Math.min(L.length - 1, Math.floor(p * L.length))] : null;
  const e = performance.eventLoopUtilization(health.elu); health.elu = performance.eventLoopUtilization();
  const h = { k: "health", t: now, frames: health.frames, lagP50: q(0.5), lagP99: q(0.99), lagMax: L.length ? L[L.length - 1] : null, elu: Math.round(e.utilization * 1000) / 1000, ext: health.ext, memMB: memAvailableMB(), rssMB: Math.round(process.memoryUsage().rss / 1048576) };
  write(h);
  health.slow = h.lagP99 != null && h.lagP99 > LAG_STOP_MS ? health.slow + 1 : 0;
  health.lowMem = h.memMB != null && h.memMB < MEM_STOP_MB ? health.lowMem + 1 : 0;
  if (health.slow >= LAG_STOP_RUNS) loadStop = `receive lag p99 ${h.lagP99}ms, over ${LAG_STOP_MS}ms for ${health.slow} checks in a row`;
  if (health.lowMem >= MEM_STOP_RUNS) loadStop = `${h.memMB}MB of memory available, under ${MEM_STOP_MB}MB for ${health.lowMem} checks in a row`;
  health.last = h;
  health.lags = []; health.frames = 0;
}

// ── The socket: one connection per recorded close ──────────────────────
let ws = null, book = new BookSet({ yesLeg: true }), nextId = 1, lastFrameAt = Date.now();
let exWatermark = null, exSeenAt = 0;
// Kalshi's clock while frames are flowing, the box's when they are not.
const exNow = now => (exWatermark != null && now - exSeenAt < SILENCE_MS) ? exWatermark : now;
let bookSid = null;

function send(cmd, params) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ id: nextId++, cmd, params }));
}

function writeFull(t, now, why) {
  const L = book.levels(t, 1000);
  if (L) { write({ k: "full", t: now, m: t, why, L: [L.bids, L.asks], x: book.touch(t)?.tsMs ?? null }); stats.fulls++; }
}

function repair(gap, now) {
  stats.gaps++;
  write({ k: "gap", t: now, sid: gap.sid, expected: gap.expected, got: gap.got, m: gap.tickers });
  if (gap.tickers.length) send("update_subscription", { sids: [gap.sid], market_tickers: gap.tickers, action: "get_snapshot" });
}

function onFrame(f, now) {
  stats.frames++; lastFrameAt = now; health.frames++;
  const ts = f.msg?.ts_ms;
  if (Number.isFinite(ts) && (f.type === "orderbook_delta" || f.type === "trade")) {
    health.lags.push(now - ts);
    if (exWatermark == null || ts > exWatermark) exWatermark = ts;
    exSeenAt = now;
  }
  switch (f.type) {
    case "orderbook_snapshot":
    case "orderbook_delta": {
      const r = book.apply(f);
      if (r.gap) repair(r.gap, now);
      const t = f.msg?.market_ticker;
      if (f.type === "orderbook_delta") {
        stats.deltas++;
        write({ k: "d", t: now, m: t, sd: f.msg.side === "yes" ? "b" : "a", p: Number(f.msg.price_dollars), q: Number(f.msg.delta_fp), x: f.msg.ts_ms ?? null, seq: f.seq });
      } else {
        writeFull(t, now, "snapshot");
      }
      return;
    }
    case "trade":
      stats.trades++;
      write({ k: "tr", t: now, m: f.msg.market_ticker, yp: Number(f.msg.yes_price_dollars), n: Number(f.msg.count_fp), side: f.msg.taker_side, x: f.msg.ts_ms ?? null, id: f.msg.trade_id });
      return;
    case "subscribed":
      if (f.msg?.channel === "orderbook_delta") bookSid = f.msg.sid;
      write({ k: "conn", t: now, ev: "subscribed", ch: f.msg?.channel, sid: f.msg?.sid });
      return;
    case "error":
      stats.errors++;
      write({ k: "err", t: now, id: f.id ?? null, code: f.msg?.code, msg: f.msg?.msg });
      log(`::warning::socket error ${f.msg?.code} ${f.msg?.msg}${f.msg?.code === 26 ? " — per-subscription market limit reached: lower LADDER_CAP" : ""}`);
      return;
    case "ok": {
      const r = book.apply(f);   // an ok consumes a sequence number: lib/kalshiBook.js
      if (r.gap) repair(r.gap, now);
      return;
    }
    default:
      return;
  }
}

let opened = false;
function connect(tickers) {
  opened = false;
  return new Promise(resolve => {
    book = new BookSet({ yesLeg: true });   // sequence numbers restart with the connection
    bookSid = null;
    const s = new KalshiWS(KALSHI_WS, { headers: kalshiAuthHeaders(kalshiKeyId, kalshiKey, "GET", WS_PATH) });
    ws = s;
    s.addEventListener("open", () => {
      opened = true; lastFrameAt = Date.now();
      health.ext = s.extensions || "";
      write({ k: "conn", t: Date.now(), ev: "open", ext: health.ext });
      // use_yes_price is sent EXPLICITLY — see lib/kalshiBook.js.
      send("subscribe", { channels: ["orderbook_delta"], market_tickers: tickers, use_yes_price: true });
      send("subscribe", { channels: ["trade"], market_tickers: tickers });
    });
    s.addEventListener("message", ev => { let f; try { f = JSON.parse(ev.data); } catch { return; } onFrame(f, Date.now()); });
    s.addEventListener("error", ev => { write({ k: "conn", t: Date.now(), ev: "error", msg: ev?.message || null }); });
    s.addEventListener("close", ev => {
      write({ k: "conn", t: Date.now(), ev: "close", code: ev?.code ?? null, reason: ev?.reason || null });
      if (ws === s) ws = null;
      resolve(ev);
    });
  });
}

// ── Run ────────────────────────────────────────────────────────────────
const started = Date.now();
archive.open(started);
let stopping = false, recordingUntil = null;
const stop = async (why, code = 0) => {
  if (stopping) return; stopping = true;
  log(`stopping: ${why}`);
  write({ k: "conn", t: Date.now(), ev: "stop", why });
  try { ws?.close(); } catch {}
  await archive.close();
  await archive.uploadAll().catch(() => {});
  printStats();
  process.exit(code);
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

function printStats() {
  log(`frames=${stats.frames} deltas=${stats.deltas} fulls=${stats.fulls} trades=${stats.trades} gaps=${stats.gaps} reconnects=${stats.reconnects} errors=${stats.errors} closes=${stats.closes} skipped=${stats.skipped} lines=${archive.stats.lines} uploads=${archive.stats.uploads} uploadFails=${archive.stats.uploadFails} backlog=${archive.backlog()} diskFreeGB=${archive.diskFreeGB()} memMB=${memAvailableMB()} lagP50=${health.last?.lagP50 ?? "-"}ms lagP99=${health.last?.lagP99 ?? "-"}ms`);
}

setInterval(() => {
  const now = Date.now();
  archive.rotateIfDue(now);
  if (ws && ws.readyState === 1) {
    // Past the close: done with this socket. Silent mid-window: dead.
    if (recordingUntil != null && exNow(now) > recordingUntil) ws.close();
    else if (now - lastFrameAt > SILENCE_MS) { log(`::warning::no frames for ${SILENCE_MS / 1000}s — reconnecting`); write({ k: "conn", t: now, ev: "silent" }); ws.close(); }
  }
  // The load stop is exit 3, which the unit does not restart: a recorder
  // that is hurting the box stays down until a person looks.
  if (loadStop && !stopping) { console.error(`::error::LOAD STOP: ${loadStop}. Not restarting; see docs/research/ladder-step2-plan.md`); stop(`load stop: ${loadStop}`, 3); }
}, 250);
setInterval(() => archive.flush(), 5000);
setInterval(() => archive.uploadAll().catch(e => log(`::warning::upload: ${e.message}`)), UPLOAD_MS);
setInterval(printStats, Number(env.LADDER_STATS_MS || 300000));
setInterval(() => writeHealth(Date.now()), HEALTH_MS);
archive.uploadAll().catch(() => {});

let refusedInARow = 0;
while (!stopping) {
  // The next close whose window has not ended. Start mid-window if the
  // process came up inside one: a partial record is marked late in "sel".
  let now = Date.now();
  let close = Math.ceil(now / PERIOD_MS) * PERIOD_MS;
  const selectAt = close - LEAD_MS - SELECT_AHEAD_MS;
  // Cycle between closes, so new code lands without cutting a record.
  if ((now - started) / 60000 >= RUN_MINUTES && now < selectAt - 5000) { await stop("cycle"); break; }
  while (!stopping && Date.now() < selectAt) await sleep(Math.min(1000, Math.max(50, selectAt - Date.now())));
  if (stopping) break;
  const tickers = await select(close);
  if (!tickers || !tickers.length) {
    stats.skipped++;
    while (!stopping && Date.now() < close + END_AFTER_MS) await sleep(1000);
    continue;
  }
  recordingUntil = close + END_AFTER_MS;
  let backoff = 1000;
  while (!stopping && exNow(Date.now()) <= recordingUntil) {
    await connect(tickers);
    if (stopping || exNow(Date.now()) > recordingUntil) break;
    refusedInARow = opened ? 0 : refusedInARow + 1;
    if (refusedInARow >= Number(env.LADDER_MAX_REFUSED || 5)) {
      console.error(`::error::the socket refused ${refusedInARow} handshakes in a row — check the Kalshi key (run scripts/kalshi-ws-probe.mjs) and the clock`);
      await archive.close();
      process.exit(1);
    }
    stats.reconnects++;
    log(`socket closed mid-window; reconnecting in ${backoff / 1000}s`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 15000);
  }
  recordingUntil = null;
  stats.closes++;
  write({ k: "end", t: Date.now(), close: new Date(close).toISOString(), n: tickers.length });
  printStats();
}
