// Record Polymarket US's 15-minute "Up or Down" books from its WebSocket,
// beside the Kalshi recorder (scripts/m15-stream.mjs), so the same window
// can be read on both venues at the same instant.
//
// WHY. Both venues list the SAME claim — same index, same averaging, same
// tie rule, same windows; lib/pmus15.js has the evidence. A gap between
// the two books is real money only if it is wider than both venues' taker
// fees together (~3.5c near 50c) at a size someone could fill. Answering
// that needs both books on one clock, continuously: a screenshot of each
// app, or two REST reads seconds apart, cannot tell a gap from the market
// moving between them. The public REST /book is also CDN-cached for 30s
// and its origin has been seen frozen for minutes, so it is not a live
// source at all.
//
// WHAT IS KEPT. Every whole book the socket sends, when it changed (10s
// heartbeat otherwise), with the exchange's transactTime and the box's
// receive time `t` — the same clock the Kalshi archive uses, which is what
// makes the two files comparable. Every level is stored: the first probe
// from the box (2026-09-29) saw 46 bid and 53 offer levels, where a REST
// read on launch day had shown 10-15 and a 50-level cap was set on that
// basis — which silently cut the deep offers. MAX_LEVELS is now only a
// guard against a runaway message. Every public trade too.
//
//   k:"pb"   book: b = bids best-first, a = offers best-first, [price, qty]
//            Prices are for the market as published: "Up" (the long side),
//            which is Kalshi's YES.
//   k:"tr"   trade
//   k:"mkt"  a window subscribed: slug, start, close, and the Kalshi
//            ticker for the same window
//   k:"err" / "conn"  everything a reader needs to tell "the book did not
//            change" from "we were not looking"
//
// THE KEY. The box's .us key is used IN PLACE, through LoadCredential,
// and ONLY for this socket. It can trade — Polymarket US has no read-only
// keys — so nothing here, or anywhere in the repo, may call an order
// endpoint (scripts/no-order-endpoints.test.mjs). It is shared with
// another long-running service on the box: ONE socket, backoff from 1s
// doubling to 60s, and a refused handshake is not retried forever — the
// key is expected to be deleted one day and that must read as a failure.
//
// Hourly gzipped NDJSON under pmus15/ in the PRIVATE bucket (migration
// 0029), through lib/streamArchive.js like the Kalshi recorder.
import { PMUS_WS, PMUS_WS_PATH, PMUS_GATEWAY, polyUsSecretPath, loadPolyUsSecret, polyUsAuthHeaders } from "../lib/polyUsAuth.js";
import { WINDOW_MS, parsePmusSlug, kalshiM15Ticker, normalizeBook, wantedSlugs } from "../lib/pmus15.js";
import { assertCredential } from "../lib/supabaseCredential.js";
import { recorderSource } from "../lib/recorderSource.js";
import { createArchive } from "../lib/streamArchive.js";

const env = process.env;
const SUPABASE_URL = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = env.STREAM_BUCKET || "stream-archive";
const DIR = env.STREAM_DIR || env.STATE_DIRECTORY || "/var/lib/marketslap-pmus15";
const ASSETS = (env.PMUS_ASSETS || "btc").split(",").map(s => s.trim()).filter(Boolean);
const AHEAD = Number(env.PMUS_AHEAD_WINDOWS ?? 1);
const RUN_MINUTES = Number(env.STREAM_RUN_MINUTES || 60);
const ALIGN_EXIT = env.STREAM_ALIGN_EXIT !== "0";
const ROTATE_MS = Number(env.STREAM_ROTATE_MS || 3600000);
const TICK_MS = Number(env.STREAM_TICK_MS || 1000);
const HEARTBEAT_MS = Number(env.STREAM_HEARTBEAT_MS || 10000);
const REMOVE_AFTER_CLOSE_MS = Number(env.STREAM_REMOVE_AFTER_CLOSE_MS || 60000);
const RETRY_SUB_MS = Number(env.PMUS_RETRY_SUBSCRIBE_MS || 30000);
const SILENCE_MS = Number(env.STREAM_SILENCE_MS || 60000);
const UPLOAD_MS = Number(env.STREAM_UPLOAD_MS || 60000);
const BACKOFF_MS = Number(env.PMUS_BACKOFF_MS || 1000);
const MAX_BACKOFF_MS = 60000;
const MAX_DRIFT_MS = Number(env.PMUS_MAX_DRIFT_MS || 10000);
const MAX_LEVELS = 500;
const SOURCE = recorderSource(env, "PMUS_SOURCE");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fatal = (...lines) => { for (const l of lines) console.error(`::error::${l}`); process.exit(1); };

// ── Preconditions: all fatal, all before a socket is opened ────────────
if (!SUPABASE_URL || !KEY) fatal("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (the archive bucket is private)");
const keyId = env.PM_KEY_ID;
if (!keyId) fatal("PM_KEY_ID is not set — the unit loads it from /etc/polyus/id.env");
let secret;
try { secret = loadPolyUsSecret(polyUsSecretPath(env)); } catch (e) { fatal(e.message); }
if (typeof WebSocket !== "function") fatal(`Node ${process.versions.node} has no built-in WebSocket; Node 22+ is required`);
if (!ASSETS.length) fatal("PMUS_ASSETS is empty");

// A skewed clock is refused at the handshake, and Node hides the HTTP
// status of a refused handshake — so measure it here, where it can be
// named, against the gateway's own Date header (a public, unsigned read).
{
  let drift = null;
  try {
    const t0 = Date.now();
    const r = await fetch(`${PMUS_GATEWAY}/events?limit=1&_=${t0}`);
    const d = Date.parse(r.headers.get("date") || "");
    if (Number.isFinite(d)) drift = (t0 + Date.now()) / 2 - d;
  } catch {}
  if (drift == null) log("::warning::could not read the gateway's clock; a skewed clock would show up as refused handshakes");
  // Date has one-second resolution, so a second of disagreement is noise.
  else if (Math.abs(drift) > MAX_DRIFT_MS) fatal(`this box's clock is ${(drift / 1000).toFixed(1)}s off the gateway's; signatures need ~30s or better — fix NTP (timedatectl) first`);
}

await assertCredential(SUPABASE_URL, KEY, { table: "m15_quotes" });

const stats = { frames: 0, books: 0, booksWritten: 0, trades: 0, heartbeats: 0, errors: 0, reconnects: 0 };
const archive = createArchive({
  dir: DIR, bucket: BUCKET, supabaseUrl: SUPABASE_URL, key: KEY, prefix: "pmus15", source: SOURCE, rotateMs: ROTATE_MS, log,
  meta: now => ({ k: "meta", t: now, source: SOURCE, venue: "polymarket_us", side: "up", assets: ASSETS, heartbeatMs: HEARTBEAT_MS, v: 1 }),
});
const write = archive.write;
{
  const bad = await archive.probe();
  if (bad) fatal(...bad);
}
archive.recoverLeftovers();
// Printing the secret's length is allowed; its content never is.
log(`source: ${SOURCE}, assets ${ASSETS.join(",")}, archive ${DIR} -> ${BUCKET}/pmus15, run ${RUN_MINUTES}m`);

// ── Windows: the current one and the next, by slug ─────────────────────
// Nothing lists these markets, so the slug is built from the clock. The
// next window is subscribed ahead so its first quotes are on the tape; if
// it is not listed yet the socket says so and it is asked for again.
const subs = new Map();   // slug -> { close, state: "want"|"sent"|"live", retryAt, lastKey, lastAt }
let ws = null, lastFrameAt = Date.now();

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function subscribe(slug, now) {
  const s = subs.get(slug);
  // A retry drops the earlier request first. A subscription the server
  // accepted but has not yet sent anything on (a window before it opens)
  // would otherwise be doubled, and every trade on it recorded twice.
  if (s.state === "sent") {
    send({ unsubscribe: { requestId: `md:${slug}` } });
    send({ unsubscribe: { requestId: `tr:${slug}` } });
  }
  s.state = "sent"; s.retryAt = now + RETRY_SUB_MS;
  send({ subscribe: { requestId: `md:${slug}`, subscriptionType: "SUBSCRIPTION_TYPE_MARKET_DATA", marketSlugs: [slug] } });
  send({ subscribe: { requestId: `tr:${slug}`, subscriptionType: "SUBSCRIPTION_TYPE_TRADE", marketSlugs: [slug] } });
}

function plan(now) {
  for (const slug of wantedSlugs(now, ASSETS, AHEAD)) {
    if (subs.has(slug)) continue;
    const p = parsePmusSlug(slug);
    subs.set(slug, { close: p.close, state: "want", retryAt: 0, lastKey: null, lastAt: 0 });
    write({ k: "mkt", t: now, m: slug, start: new Date(p.start).toISOString(), close: new Date(p.close).toISOString(), kalshi: kalshiM15Ticker(p.asset, p.close) });
  }
  for (const [slug, s] of subs) {
    if (now > s.close + REMOVE_AFTER_CLOSE_MS) {
      send({ unsubscribe: { requestId: `md:${slug}` } });
      send({ unsubscribe: { requestId: `tr:${slug}` } });
      subs.delete(slug);
      continue;
    }
    // "sent" with no book yet by retryAt: ask again. An unlisted market
    // may answer with an error, or may answer with nothing at all.
    if (ws?.readyState === 1 && (s.state === "want" || (s.state === "sent" && now >= s.retryAt))) subscribe(slug, now);
  }
}

const slugOfRequest = id => typeof id === "string" && /^(md|tr):/.test(id) ? id.slice(3) : null;

function onMessage(msg, now) {
  stats.frames++; lastFrameAt = now;
  if (msg.heartbeat !== undefined) { stats.heartbeats++; return; }
  if (msg.error !== undefined) {
    stats.errors++;
    write({ k: "err", t: now, id: msg.requestId ?? null, msg: String(msg.error).slice(0, 300) });
    const slug = slugOfRequest(msg.requestId), s = slug && subs.get(slug);
    if (s && s.state !== "live") s.retryAt = now + RETRY_SUB_MS;
    else log(`::warning::socket error: ${String(msg.error).slice(0, 200)}`);
    return;
  }
  if (msg.marketData) {
    stats.books++;
    const md = msg.marketData, slug = md.marketSlug, s = subs.get(slug);
    if (!s) return;
    s.state = "live";
    const bk = normalizeBook(md);
    const body = { st: bk.st, b: bk.b.slice(0, MAX_LEVELS), a: bk.a.slice(0, MAX_LEVELS) };
    const key = JSON.stringify(body);
    if (key === s.lastKey && now - s.lastAt < HEARTBEAT_MS) return;
    s.lastKey = key; s.lastAt = now;
    const vol = Number(md.stats?.sharesTraded);
    write({ k: "pb", t: now, m: slug, x: bk.x, ...body, vol: Number.isFinite(vol) ? vol : null });
    stats.booksWritten++;
    return;
  }
  if (msg.trade) {
    stats.trades++;
    const tr = msg.trade, x = Date.parse(tr.tradeTime || "");
    write({ k: "tr", t: now, m: tr.marketSlug, p: Number(tr.price?.value), q: Number(tr.quantity?.value ?? tr.quantity),
      side: tr.taker?.side ?? null, intent: tr.taker?.intent ?? null, x: Number.isFinite(x) ? x : null });
  }
}

let opened = false, openedAt = 0;
function connect() {
  opened = false;
  return new Promise(resolve => {
    for (const s of subs.values()) { s.state = "want"; s.lastKey = null; }
    const s = new WebSocket(PMUS_WS, { headers: polyUsAuthHeaders(keyId, secret, "GET", PMUS_WS_PATH) });
    ws = s;
    s.addEventListener("open", () => {
      opened = true; openedAt = lastFrameAt = Date.now();
      write({ k: "conn", t: Date.now(), ev: "open" });
      log("socket open");
      plan(Date.now());
    });
    s.addEventListener("message", ev => {
      let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      onMessage(m, Date.now());
    });
    s.addEventListener("error", ev => write({ k: "conn", t: Date.now(), ev: "error", msg: ev?.message || null }));
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
let stopping = false;
const stop = async why => {
  if (stopping) return; stopping = true;
  log(`stopping: ${why}`);
  write({ k: "conn", t: Date.now(), ev: "stop", why });
  try { ws?.close(1000, "OK"); } catch {}
  await archive.close();
  printStats();
  process.exit(0);
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

function printStats() {
  const { lines, uploads, uploadFails } = archive.stats, free = archive.diskFreeGB();
  const live = [...subs.values()].filter(s => s.state === "live").length;
  log(`frames=${stats.frames} books=${stats.books} booksWritten=${stats.booksWritten} trades=${stats.trades} heartbeats=${stats.heartbeats} errors=${stats.errors} reconnects=${stats.reconnects} windows=${subs.size} live=${live} lines=${lines} uploads=${uploads} uploadFails=${uploadFails} backlog=${archive.backlog()} diskFreeGB=${free}`);
  if (free != null && Number(free) < 1) log(`::warning::less than 1GB free under ${DIR} — uploads are not keeping up`);
}

setInterval(() => {
  const now = Date.now();
  archive.rotateIfDue(now);
  plan(now);
  // A socket that stays open and says nothing is the failure a close
  // event never reports. The current window's book always has something
  // to say, and the server heartbeats besides.
  if (ws && ws.readyState === 1 && now - lastFrameAt > SILENCE_MS) {
    log(`::warning::no frames for ${SILENCE_MS / 1000}s — reconnecting`);
    write({ k: "conn", t: now, ev: "silent" });
    ws.close();
  }
  const ran = (now - started) / 60000;
  if (ran >= RUN_MINUTES && !stopping) {
    const inWindow = (now % WINDOW_MS) / 1000;
    if (!ALIGN_EXIT || (inWindow >= 60 && inWindow < 120) || ran >= RUN_MINUTES + 16) stop("cycle");
  }
}, TICK_MS);
setInterval(archive.flush, 5000);
setInterval(() => archive.uploadAll().catch(e => log(`::warning::upload: ${e.message}`)), UPLOAD_MS);
setInterval(printStats, Number(env.STREAM_STATS_MS || 300000));
archive.uploadAll().catch(() => {});
plan(Date.now());

// A handshake that keeps failing is a key problem or an outage, and the
// socket cannot say which — Node hides the HTTP status. The public
// gateway can: if it answers while the socket keeps refusing, the key has
// been deleted or rotated (it is expected to be, one day), which retrying
// will not fix and which must read as a failure. If the gateway does not
// answer either, it is an outage, and the recorder keeps trying at the
// capped interval, since a window not recorded is lost for good.
//
// A refused key exits 3, which the unit's RestartPreventExitStatus does
// not restart: with a 60s backoff cap, a restart loop would sit under
// StartLimitBurst and retry a deleted key forever.
const KEY_REFUSED_EXIT = 3;
async function gatewayUp() {
  try { const r = await fetch(`${PMUS_GATEWAY}/events?limit=1&_=${Date.now()}`); return r.ok; } catch { return false; }
}
let refusedInARow = 0, backoff = BACKOFF_MS;
while (!stopping) {
  await connect();
  if (stopping) break;
  // Backoff resets only after a connection that HELD. One the server
  // accepts and then closes straight away is still a failure, and
  // reconnecting to it every second would spend the box's shared rate
  // limit on nothing.
  if (opened) { refusedInARow = 0; if (Date.now() - openedAt > 60000) backoff = BACKOFF_MS; }
  else refusedInARow++;
  if (refusedInARow >= Number(env.STREAM_MAX_REFUSED || 5)) {
    if (await gatewayUp()) {
      await archive.close();
      console.error(`::error::the .us socket refused ${refusedInARow} handshakes in a row while the gateway is up — the key has probably been deleted or rotated (check PM_KEY_ID in /etc/polyus/id.env), or the clock is off. Not restarting.`);
      process.exit(KEY_REFUSED_EXIT);
    }
    log(`::warning::${refusedInARow} refused handshakes and the gateway is not answering either — treating it as an outage, retrying every ${MAX_BACKOFF_MS / 1000}s`);
    write({ k: "conn", t: Date.now(), ev: "outage" });
    refusedInARow = 0; backoff = MAX_BACKOFF_MS;
  }
  stats.reconnects++;
  log(`socket closed; reconnecting in ${backoff / 1000}s`);
  await sleep(backoff);
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
}
