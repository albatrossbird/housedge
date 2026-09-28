// Record Kalshi's 15-minute markets from the WebSocket, as live as the
// exchange publishes them. Runs on the box beside the polling recorder
// (scripts/m15-record.mjs), which it does not replace.
//
// WHY A SOCKET. The poller reads each book every ~15s. Measured on
// 2026-09-26, KXBTC15M's book changed at least 151 times a SECOND and its
// touch moved 59 times in 30s. A backtest entering in the last minute on
// a 15-second sample is reading a book that has moved dozens of times
// since. The socket delivers every change with the exchange's own
// timestamp, plus the settlement index (CF Benchmarks BRTI) at 5Hz —
// the number these markets actually resolve on.
//
// WHAT IS KEPT (chosen 2026-09-26, "hybrid"):
//   k:"b"    every market's book once a second, when it changed (10s
//            heartbeat): touch, size, depth within 1/3/5c, top 10 levels
//   k:"full" + k:"d"  EVERY change in each window's final two minutes,
//            starting from a full-depth book, so that stretch can be
//            replayed exactly. That is where the entries that matter are.
//   k:"tr"   every public trade
//   k:"i5"   BTC/ETH/SOL/XRP/DOGE indices at 5Hz, all day
//   k:"i1"   every CF Benchmarks index at 1Hz, with its 60s averages
//   k:"gap" / "conn" / "mkt" / "err"  everything a reader needs to tell
//            "the book did not change" from "we were not looking"
//
// WHERE IT GOES. Not Postgres: a full day is millions of rows, several
// times what the 15-second poller writes. Hourly gzipped NDJSON files in
// a PRIVATE Supabase Storage bucket (migration 0029), deleted locally
// only after the upload is confirmed. Kalshi's data terms allow personal
// use and forbid redistributing archived data — the bucket is private and
// must stay that way.
//
// Prices are YES-leg throughout: "b" is the YES bid stack, "a" the YES
// ask stack (Kalshi's NO bids, already converted by use_yes_price).
import { createGzip, constants as zc } from "node:zlib";
import { createWriteStream, mkdirSync, readdirSync, renameSync, readFileSync, unlinkSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { KALSHI_REST, KALSHI_WS, WS_PATH, keyPath, loadKalshiKey, kalshiAuthHeaders } from "../lib/kalshiAuth.js";
import { BookSet } from "../lib/kalshiBook.js";
import { M15_SUFFIX, M15_CATEGORIES } from "../lib/m15.js";
import { assertCredential } from "../lib/supabaseCredential.js";
import { authHeaders } from "../lib/supabaseHeaders.js";
import { recorderSource } from "../lib/recorderSource.js";

const env = process.env;
const SUPABASE_URL = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = env.STREAM_BUCKET || "stream-archive";
const DIR = env.STREAM_DIR || env.STATE_DIRECTORY || "/var/lib/marketslap-stream";
const RUN_MINUTES = Number(env.STREAM_RUN_MINUTES || 60);
// Cycle at minute 1-2 of a window, the furthest point from any window's
// final two minutes, so the restart gap lands where it costs least.
const ALIGN_EXIT = env.STREAM_ALIGN_EXIT !== "0";
const ROTATE_MS = Number(env.STREAM_ROTATE_MS || 3600000);
const SNAPSHOT_MS = Number(env.STREAM_SNAPSHOT_MS || 1000);
const HEARTBEAT_MS = Number(env.STREAM_HEARTBEAT_MS || 10000);
const FINAL_MS = Number(env.STREAM_FINAL_SECONDS || 120) * 1000;
const DISCOVER_MS = Number(env.STREAM_DISCOVER_MS || 60000);
const LOOKAHEAD_S = Number(env.STREAM_LOOKAHEAD_SECONDS || 1800);
const REMOVE_AFTER_CLOSE_MS = Number(env.STREAM_REMOVE_AFTER_CLOSE_MS || 60000);
const SILENCE_MS = Number(env.STREAM_SILENCE_MS || 30000);
const UPLOAD_MS = Number(env.STREAM_UPLOAD_MS || 60000);
const LEVELS = 10;
const SOURCE = recorderSource(env, "M15_SOURCE");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Preconditions: all fatal, all before a socket is opened ────────────
if (!SUPABASE_URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (the archive bucket is private)"); process.exit(1); }
const kalshiKeyId = env.KALSHI_KEY_ID;
let kalshiKey;
try { kalshiKey = loadKalshiKey(keyPath(env)); } catch (e) { console.error(`::error::${e.message}`); process.exit(1); }
if (!kalshiKeyId) { console.error("::error::KALSHI_KEY_ID is not set in /etc/marketslap/env — run scripts/kalshi-key-setup.mjs"); process.exit(1); }
if (typeof WebSocket !== "function") { console.error(`::error::Node ${process.versions.node} has no built-in WebSocket; Node 22+ is required`); process.exit(1); }
await assertCredential(SUPABASE_URL, KEY, { table: "m15_quotes" });
mkdirSync(DIR, { recursive: true });
log(`source: ${SOURCE}, archive ${DIR} -> ${BUCKET}, run ${RUN_MINUTES}m`);

// The bucket is proven the same way the credential is: by using it. A
// missing bucket would otherwise surface an hour from now as a failed
// upload, with an hour of data piling up on a small disk.
{
  const r = await upload(`m15/_probe/${SOURCE}.txt`, Buffer.from(new Date().toISOString()), "text/plain");
  if (!r.ok) {
    console.error(`::error::cannot write to Storage bucket '${BUCKET}': ${r.status} ${r.body}`);
    if (/bucket not found|404/i.test(`${r.status} ${r.body}`)) console.error("::error::run migration 0029_stream_archive_bucket.sql");
    process.exit(1);
  }
}

// ── The archive: hourly gzip files, uploaded then deleted ──────────────
const stats = { frames: 0, deltas: 0, finalDeltas: 0, snaps: 0, trades: 0, i5: 0, i1: 0, gaps: 0, reconnects: 0, lines: 0, uploads: 0, uploadFails: 0, errors: 0 };
let out = null;   // { gz, slot, part, final }

function fileName(startMs) {
  const d = new Date(startMs).toISOString();   // 2026-09-26T15:01:30.123Z
  return `${d.slice(0, 10)}_${d.slice(11, 13)}_${d.replace(/[-:.]/g, "").slice(0, 18)}Z_${SOURCE}.ndjson.gz`;
}
// 2026-09-26_15_20260926T150130123Z_box.ndjson.gz -> m15/2026-09-26/15/20260926T150130123Z_box.ndjson.gz
// Milliseconds in the name: two files may start in the same second (a
// restart right after a rotation) and must not overwrite each other.
const remotePath = name => { const [day, hour, ...rest] = name.split("_"); return `m15/${day}/${hour}/${rest.join("_")}`; };

function openFile(now) {
  const final = join(DIR, fileName(now));
  const part = final + ".part";
  const gz = createGzip(), file = createWriteStream(part);
  gz.pipe(file);
  out = { gz, file, slot: Math.floor(now / ROTATE_MS), part, final };
  write({ k: "meta", t: now, source: SOURCE, yesLeg: true, levels: LEVELS, snapshotMs: SNAPSHOT_MS, finalSeconds: FINAL_MS / 1000, v: 1 });
}

// Finish the gzip and only then drop the .part suffix, so a file without
// it is always complete. A crash leaves a .part, which the next run
// uploads under a "-truncated" name: gzip is readable up to its last
// flush, and the flush below runs every few seconds.
function closeFile() {
  if (!out) return Promise.resolve();
  const { gz, file, part, final } = out;
  out = null;
  return new Promise(res => {
    const done = () => { try { renameSync(part, final); } catch {} res(); };
    file.on("finish", done);
    file.on("error", () => res());
    gz.end();
  });
}

function write(obj) {
  if (!out) return;
  out.gz.write(JSON.stringify(obj) + "\n");
  stats.lines++;
}

function rotateIfDue(now) {
  if (out && Math.floor(now / ROTATE_MS) !== out.slot) {
    const old = closeFile();
    openFile(now);
    old.then(uploadAll);
  }
}

async function upload(path, body, type = "application/gzip") {
  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST", body,
      headers: authHeaders(KEY, { "Content-Type": type, "x-upsert": "true" }),
    });
    return { ok: r.ok, status: r.status, body: r.ok ? "" : (await r.text()).slice(0, 200) };
  } catch (e) { return { ok: false, status: 0, body: e.message }; }
}

let uploading = false;
async function uploadAll() {
  if (uploading) return;
  uploading = true;
  try {
    for (const name of readdirSync(DIR).filter(n => n.endsWith(".ndjson.gz")).sort()) {
      const body = readFileSync(join(DIR, name));
      const r = await upload(remotePath(name), body);
      if (r.ok) { unlinkSync(join(DIR, name)); stats.uploads++; }
      else { stats.uploadFails++; log(`::warning::upload ${name} failed: ${r.status} ${r.body} — kept locally, will retry`); }
    }
  } finally { uploading = false; }
}

// Leftovers from a run that died mid-file.
for (const name of readdirSync(DIR).filter(n => n.endsWith(".ndjson.gz.part"))) {
  renameSync(join(DIR, name), join(DIR, name.replace(/\.ndjson\.gz\.part$/, "-truncated.ndjson.gz")));
  log(`::warning::found ${name} from a run that did not finish; uploading it as truncated`);
}

// ── Markets: current window plus the next ones, subscribed AHEAD ───────
// Kalshi lists each 15-minute market about a day before it opens, as
// `initialized`. Subscribing then means the first order of every window
// is on the tape; discovering markets only once they are open would miss
// the start of each window by up to a discovery interval.
const markets = new Map();   // ticker -> { close, open, status, strike, final:bool, lastSnap, lastSnapAt }
let series = [];
const restedUntil = new Map();

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

async function listSeries() {
  const found = new Set();
  for (const cat of M15_CATEGORIES) {
    const r = await restGet(`/series?category=${encodeURIComponent(cat)}`);
    for (const s of r?.series || []) if (s.ticker && M15_SUFFIX.test(s.ticker)) found.add(s.ticker);
  }
  return [...found].sort();
}

let seriesAt = 0;
async function discover() {
  const now = Date.now();
  // Kalshi keeps adding 15-minute series; re-read the list every half hour.
  if (!series.length || now - seriesAt > Number(env.STREAM_SERIES_MS || 1800000)) {
    const fresh = await listSeries();
    if (fresh.length) { series = fresh; seriesAt = now; }
  }
  const seen = new Set();
  for (const s of series) {
    if ((restedUntil.get(s) || 0) > now) { for (const [t, m] of markets) if (m.series === s) seen.add(t); continue; }
    const nowS = Math.floor(now / 1000);
    const r = await restGet(`/markets?series_ticker=${s}&min_close_ts=${nowS}&max_close_ts=${nowS + LOOKAHEAD_S}&limit=20`);
    if (!r) { for (const [t, m] of markets) if (m.series === s) seen.add(t); continue; }   // a failed read keeps what we have
    const ms = (r.markets || []).filter(m => Date.parse(m.close_time) > now);
    if (!ms.length) restedUntil.set(s, now + 5 * 60000);   // out of hours / not yet listed
    for (const m of ms) {
      seen.add(m.ticker);
      const cur = markets.get(m.ticker);
      const info = { series: s, close: Date.parse(m.close_time), open: Date.parse(m.open_time), status: m.status, strike: m.floor_strike ?? null };
      if (!cur || cur.status !== info.status || cur.strike !== info.strike) {
        write({ k: "mkt", t: now, m: m.ticker, st: info.status, open: m.open_time, close: m.close_time, strike: info.strike });
      }
      markets.set(m.ticker, { final: false, lastSnap: null, lastSnapAt: 0, ...cur, ...info });
    }
  }
  const add = [...seen].filter(t => !subscribed.has(t));
  if (add.length) subscribeMarkets(add);
}

function retireClosed(now) {
  const gone = [...markets].filter(([, m]) => now > m.close + REMOVE_AFTER_CLOSE_MS).map(([t]) => t);
  if (!gone.length) return;
  for (const t of gone) { markets.delete(t); book.drop(t); }
  unsubscribeMarkets(gone);
}

// ── The socket ─────────────────────────────────────────────────────────
let ws = null, book = new BookSet({ yesLeg: true }), nextId = 1, lastFrameAt = Date.now(), lastI5At = Date.now();
const sids = {};                 // channel -> sid
const pending = new Map();       // command id -> channel
const subscribed = new Set();    // tickers the book/trade subscriptions carry
let subscribing = false;
let inFlight = new Set();         // tickers named in the subscribe awaiting its reply

function send(cmd, params, channel) {
  if (!ws || ws.readyState !== 1) return;
  const id = nextId++;
  if (channel) pending.set(id, channel);
  ws.send(JSON.stringify({ id, cmd, params }));
}

function subscribeMarkets(tickers) {
  tickers.forEach(t => subscribed.add(t));
  if (!ws || ws.readyState !== 1) return;          // picked up by the next connect
  if (sids.orderbook_delta == null) {
    if (subscribing) return;
    subscribing = true;
    inFlight = new Set(subscribed);
    // use_yes_price is sent EXPLICITLY — see lib/kalshiBook.js.
    send("subscribe", { channels: ["orderbook_delta"], market_tickers: [...subscribed], use_yes_price: true }, "orderbook_delta");
    send("subscribe", { channels: ["trade"], market_tickers: [...subscribed] }, "trade");
    return;
  }
  if (!tickers.length) return;
  send("update_subscription", { sids: [sids.orderbook_delta], market_tickers: tickers, action: "add_markets" });
  if (sids.trade != null) send("update_subscription", { sids: [sids.trade], market_tickers: tickers, action: "add_markets" });
}

function unsubscribeMarkets(tickers) {
  tickers.forEach(t => subscribed.delete(t));
  if (sids.orderbook_delta != null) send("update_subscription", { sids: [sids.orderbook_delta], market_tickers: tickers, action: "delete_markets" });
  if (sids.trade != null) send("update_subscription", { sids: [sids.trade], market_tickers: tickers, action: "delete_markets" });
}

const px = n => n == null ? null : Math.round(n * 10000) / 10000;

function onFrame(f, now) {
  stats.frames++; lastFrameAt = now;
  switch (f.type) {
    case "orderbook_snapshot":
    case "orderbook_delta": {
      const r = book.apply(f);
      if (r.gap) {
        stats.gaps++;
        write({ k: "gap", t: now, sid: r.gap.sid, expected: r.gap.expected, got: r.gap.got, m: r.gap.tickers });
        // Repair: a fresh snapshot for every market on the subscription.
        if (r.gap.tickers.length) send("update_subscription", { sids: [r.gap.sid], market_tickers: r.gap.tickers, action: "get_snapshot" });
      }
      const t = f.msg?.market_ticker, m = markets.get(t);
      if (f.type === "orderbook_delta") {
        stats.deltas++;
        if (m?.final) {
          stats.finalDeltas++;
          write({ k: "d", t: now, m: t, sd: f.msg.side === "yes" ? "b" : "a", p: Number(f.msg.price_dollars), q: Number(f.msg.delta_fp), x: f.msg.ts_ms ?? null, seq: f.seq });
        }
      } else if (m?.final) {
        writeFull(t, now, "resnapshot");
      }
      return;
    }
    case "trade":
      stats.trades++;
      write({ k: "tr", t: now, m: f.msg.market_ticker, yp: Number(f.msg.yes_price_dollars), n: Number(f.msg.count_fp), side: f.msg.taker_side, x: f.msg.ts_ms ?? null, id: f.msg.trade_id });
      return;
    case "cfbenchmarks_value_5hz":
      stats.i5++; lastI5At = now;
      write({ k: "i5", t: now, id: f.msg.index_id, v: f.msg.value_usd, x: f.msg.source_ts_ms ?? null });
      return;
    case "cfbenchmarks_value": {
      stats.i1++;
      const m = f.msg || {};
      write({ k: "i1", t: now, id: m.index_id, rx: m.received_at ?? null, a60: m.avg_60s_data ?? null, q15: m.last_60s_windowed_average_15min ?? null, data: m.data ?? null });
      return;
    }
    case "subscribed": {
      const ch = f.msg?.channel || pending.get(f.id);
      if (ch) sids[ch] = f.msg.sid;
      if (ch === "orderbook_delta" || ch === "trade") {
        if (ch === "orderbook_delta") subscribing = false;
        // Markets discovered while the subscribe was in flight.
        const late = [...subscribed].filter(t => !inFlight.has(t));
        if (late.length) send("update_subscription", { sids: [f.msg.sid], market_tickers: late, action: "add_markets" });
      }
      write({ k: "conn", t: now, ev: "subscribed", ch, sid: f.msg?.sid });
      return;
    }
    case "error":
      stats.errors++;
      write({ k: "err", t: now, id: f.id ?? null, code: f.msg?.code, msg: f.msg?.msg });
      log(`::warning::socket error ${f.msg?.code} ${f.msg?.msg}${f.msg?.code === 26 ? " — per-subscription market limit reached" : ""}`);
      return;
    case "ok": {
      // Advances the book subscription's sequence — see lib/kalshiBook.js.
      const r = book.apply(f);
      if (r.gap) {
        stats.gaps++;
        write({ k: "gap", t: now, sid: r.gap.sid, expected: r.gap.expected, got: r.gap.got, m: r.gap.tickers });
        if (r.gap.tickers.length) send("update_subscription", { sids: [r.gap.sid], market_tickers: r.gap.tickers, action: "get_snapshot" });
      }
      return;
    }
    default:
      return;   // list_subscriptions, *_indexlist
  }
}

function writeFull(t, now, why) {
  const L = book.levels(t, 1000);
  if (L) write({ k: "full", t: now, m: t, why, L: [L.bids, L.asks], x: book.touch(t)?.tsMs ?? null });
}

// Once a second: each known book, if it changed; and the final-window edge.
function snapshotTick(now) {
  for (const [t, m] of markets) {
    if (!m.final && now >= m.close - FINAL_MS && now < m.close + REMOVE_AFTER_CLOSE_MS) {
      m.final = true;
      write({ k: "final", t: now, m: t, close: new Date(m.close).toISOString(), fresh: book.isFresh(t) });
      writeFull(t, now, "final-window");
    }
    const tp = book.touch(t);
    if (!tp) continue;
    const d = book.depth(t, [1, 3, 5]);
    const L = book.levels(t, LEVELS);
    const body = { b: px(tp.bid), a: px(tp.ask), bs: tp.bidSize, as: tp.askSize,
      d: [d.bid_1c, d.bid_3c, d.bid_5c, d.ask_1c, d.ask_3c, d.ask_5c], L: [L.bids, L.asks] };
    const key = JSON.stringify(body);
    if (key === m.lastSnap && now - m.lastSnapAt < HEARTBEAT_MS) continue;
    m.lastSnap = key; m.lastSnapAt = now;
    write({ k: "b", t: now, m: t, ...body, x: tp.tsMs });
    stats.snaps++;
  }
}

let backoff = 1000, opened = false;
function connect() {
  opened = false;
  return new Promise(resolve => {
    book = new BookSet({ yesLeg: true });   // sequence numbers restart with the connection
    for (const k of Object.keys(sids)) delete sids[k];
    subscribing = false;
    for (const m of markets.values()) m.lastSnap = null;
    const s = new WebSocket(KALSHI_WS, { headers: kalshiAuthHeaders(kalshiKeyId, kalshiKey, "GET", WS_PATH) });
    ws = s;
    s.addEventListener("open", () => {
      backoff = 1000; opened = true; lastFrameAt = Date.now(); lastI5At = Date.now();
      write({ k: "conn", t: Date.now(), ev: "open" });
      log("socket open");
      send("subscribe", { channels: ["cfbenchmarks_value_5hz"], index_ids: ["all"] }, "cfbenchmarks_value_5hz");
      send("subscribe", { channels: ["cfbenchmarks_value"], index_ids: ["all"] }, "cfbenchmarks_value");
      if (subscribed.size) subscribeMarkets([]);
      // Any market that is in its final window gets a fresh full book on
      // the new connection's first snapshot (see onFrame).
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
openFile(started);
let stopping = false;
const stop = async (why) => {
  if (stopping) return; stopping = true;
  log(`stopping: ${why}`);
  write({ k: "conn", t: Date.now(), ev: "stop", why });
  try { ws?.close(); } catch {}
  await closeFile();
  printStats();
  process.exit(0);
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

function printStats() {
  let backlog = 0;
  try { backlog = readdirSync(DIR).filter(n => n.endsWith(".ndjson.gz")).length; } catch {}
  let free = null;
  try { const s = statfsSync(DIR); free = (s.bavail * s.bsize / 1e9).toFixed(1); } catch {}
  log(`frames=${stats.frames} deltas=${stats.deltas} finalDeltas=${stats.finalDeltas} snaps=${stats.snaps} trades=${stats.trades} i5=${stats.i5} i1=${stats.i1} gaps=${stats.gaps} reconnects=${stats.reconnects} errors=${stats.errors} markets=${markets.size} uploads=${stats.uploads} uploadFails=${stats.uploadFails} backlog=${backlog} diskFreeGB=${free}`);
  if (free != null && Number(free) < 1) log(`::warning::less than 1GB free under ${DIR} — uploads are not keeping up`);
}

await discover();
log(`${series.length} series, ${markets.size} markets in the next ${LOOKAHEAD_S / 60} minutes`);

// Timers run independently of the socket, so the file keeps rotating and
// the gap stays visible while disconnected.
setInterval(() => {
  const now = Date.now();
  rotateIfDue(now);
  snapshotTick(now);
  if (ws && ws.readyState === 1) {
    // A socket that stays open and says nothing is the failure a close
    // event never reports. The 1Hz index is always flowing.
    if (now - lastFrameAt > SILENCE_MS) { log(`::warning::no frames for ${SILENCE_MS / 1000}s — reconnecting`); write({ k: "conn", t: now, ev: "silent" }); ws.close(); }
    else if (now - lastI5At > SILENCE_MS && !stats.i5silentWarned) { stats.i5silentWarned = true; log("::warning::5Hz index silent while the socket is alive"); }
  }
  const ran = (now - started) / 60000;
  if (ran >= RUN_MINUTES && !stopping) {
    const inWindow = (now % 900000) / 1000;
    if (!ALIGN_EXIT || (inWindow >= 60 && inWindow < 120) || ran >= RUN_MINUTES + 16) stop("cycle");
  }
}, SNAPSHOT_MS);
setInterval(() => out?.gz.flush(zc.Z_SYNC_FLUSH), 5000);
setInterval(() => { retireClosed(Date.now()); discover().catch(e => log(`::warning::discovery: ${e.message}`)); }, DISCOVER_MS);
setInterval(() => uploadAll().catch(e => log(`::warning::upload: ${e.message}`)), UPLOAD_MS);
setInterval(printStats, Number(env.STREAM_STATS_MS || 300000));
uploadAll().catch(() => {});

// A handshake that keeps failing is a credential or clock problem, which
// retrying will not fix. Exit, so StartLimitBurst stops the unit and it
// shows as failed — the fourteen hours the poller once spent retrying a
// rejected key is the thing this avoids.
let refusedInARow = 0;
while (!stopping) {
  await connect();
  if (stopping) break;
  refusedInARow = opened ? 0 : refusedInARow + 1;
  if (refusedInARow >= Number(env.STREAM_MAX_REFUSED || 5)) {
    console.error(`::error::the socket refused ${refusedInARow} handshakes in a row — check the Kalshi key (run scripts/kalshi-ws-probe.mjs) and the clock`);
    await closeFile();
    process.exit(1);
  }
  stats.reconnects++;
  log(`socket closed; reconnecting in ${backoff / 1000}s`);
  await sleep(backoff);
  backoff = Math.min(backoff * 2, 30000);
}
