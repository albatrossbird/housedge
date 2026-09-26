// Prove the Kalshi WebSocket works FROM THE BOX before a recorder is
// built on it. Everything here was read from Kalshi's docs; this is the
// part the docs cannot tell us — whether our key, our clock, our Node and
// our datacenter IP get a working stream, and whether the book we keep
// from it agrees with the book REST serves.
//
// Run on the box (the key is read through LoadCredential, never pasted):
//
//   sudo systemd-run --quiet --wait --pipe --uid=marketslap \
//     -p EnvironmentFile=/etc/marketslap/env \
//     -p LoadCredential=kalshi.pem:/etc/marketslap/kalshi-read.pem \
//     /usr/bin/node /opt/marketslap/scripts/kalshi-ws-probe.mjs
//
// Writes nothing. Exits 1 if any required check fails.
import { statfsSync } from "node:fs";
import { KALSHI_REST, KALSHI_WS, WS_PATH, keyPath, loadKalshiKey, kalshiAuthHeaders, kalshiAuthed } from "../lib/kalshiAuth.js";
import { BookSet } from "../lib/kalshiBook.js";
import { bookDepth } from "../lib/m15.js";

const SECONDS = Number(process.env.PROBE_SECONDS || 45);
const SAMPLE_MS = Number(process.env.PROBE_SAMPLE_MS || 2000);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok === true ? "PASS" : ok === false ? "FAIL" : "info"}  ${name}: ${detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ── The machine ────────────────────────────────────────────────────────
const major = Number(process.versions.node.split(".")[0]);
check("node", major >= 22 && typeof WebSocket === "function",
  `v${process.versions.node}, global WebSocket ${typeof WebSocket}` + (major < 22 ? " — Node 22+ is required (built-in WebSocket with handshake headers)" : ""));

try {
  const fs = statfsSync(process.cwd());
  const gb = fs.bavail * fs.bsize / 1e9;
  check("disk", gb >= 2, `${gb.toFixed(1)} GB free under ${process.cwd()}`);
} catch (e) { check("disk", null, e.message); }

// ── The key ────────────────────────────────────────────────────────────
const keyId = process.env.KALSHI_KEY_ID;
let key = null;
try {
  key = loadKalshiKey(keyPath());
  check("key", !!keyId, `${key.asymmetricKeyType} key loaded; KALSHI_KEY_ID ${keyId ? "set" : "MISSING from /etc/marketslap/env"}`);
} catch (e) { check("key", false, e.message); }

// Kalshi rejects a stale timestamp; a drifting clock looks like a bad key.
try {
  const t0 = Date.now();
  const r = await fetch(`${KALSHI_REST}/exchange/status`);
  const t1 = Date.now();
  const server = Date.parse(r.headers.get("date"));
  const skew = Math.round((t0 + t1) / 2 - server);
  // The Date header has one-second resolution, so ±1.5s is the noise floor.
  check("clock", Math.abs(skew) < 5000, `local minus Kalshi ≈ ${skew} ms (Date header is 1s resolution)`);
} catch (e) { check("clock", false, e.message); }

if (!key || !keyId) finish();

// ── Authenticated REST, and what the key is ALLOWED to do ─────────────
// The recorder only reads. A key that can trade sitting on a box is a
// liability with no upside, so a write scope is a FAIL, not a note.
const keys = await kalshiAuthed("GET", "/api_keys", { keyId, key });
if (!keys.ok) {
  check("rest auth", false, `GET /api_keys -> ${keys.status} ${JSON.stringify(keys.body).slice(0, 200)}`);
} else {
  check("rest auth", true, "GET /api_keys -> 200");
  const mine = (keys.body.api_keys || []).find(k => k.api_key_id === keyId);
  const scopes = mine?.scopes || null;
  const writes = (scopes || []).filter(s => s.startsWith("write"));
  check("key scope", !!scopes && writes.length === 0,
    scopes ? `scopes [${scopes.join(", ")}]${writes.length ? " — this key CAN TRADE; replace it with a read-only one" : ""}` : "this key id is not in the account's key list");
  const others = (keys.body.api_keys || []).filter(k => k.api_key_id !== keyId);
  if (others.length) check("other keys", null, `${others.length} other key(s) on the account: ${others.map(k => `${k.name} [${(k.scopes || []).join(",")}]`).join("; ")}`);
  if (keys.body.api_key_region_expiration_ts != null)
    check("region attestation", keys.body.api_key_region_expiration_ts * 1000 > Date.now(),
      `expires ${new Date(keys.body.api_key_region_expiration_ts * 1000).toISOString()}`);
}

// ── A live market to watch ─────────────────────────────────────────────
// `second` is the NEXT window, listed ahead as `initialized`. Subscribing
// to it before it opens is how the recorder avoids missing the first
// seconds of every window, so the add/remove test uses it.
let ticker = null, second = null;
{
  const now = Math.floor(Date.now() / 1000);
  const r = await fetch(`${KALSHI_REST}/markets?series_ticker=KXBTC15M&min_close_ts=${now}&max_close_ts=${now + 2400}&limit=20`).then(r => r.json()).catch(() => null);
  const ms = (r?.markets || []).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  ticker = ms.find(m => m.status === "active")?.ticker || null;
  second = ms.find(m => m.status !== "active" && m.ticker !== ticker)?.ticker || null;
}
check("live market", !!ticker, ticker ? `${ticker}${second ? ` (+ next window ${second}, not yet open, for the add/remove test)` : " (no upcoming window listed)"}` : "no open KXBTC15M market");
if (!ticker) finish();

// ── The socket ─────────────────────────────────────────────────────────
const book = new BookSet({ yesLeg: true });
const seen = { types: {}, errors: [], subscribed: {}, sids: {}, deltaLagMs: [], idxLagMs: [], trades: 0, idx5: 0, idx1: 0,
  gaps: [], indexlist: null, getSnapshot: false, added: false, addedSnapshot: false, removed: false, listSubs: null, closed: null };
let nextId = 1;
const pending = new Map();   // id -> label
const send = (ws, cmd, params, label) => { const id = nextId++; pending.set(id, label); ws.send(JSON.stringify({ id, cmd, ...(params ? { params } : {}) })); return id; };

const t0 = Date.now();
let ws;
try {
  ws = new WebSocket(KALSHI_WS, { headers: kalshiAuthHeaders(keyId, key, "GET", WS_PATH) });
} catch (e) { check("ws connect", false, e.message); finish(); }

const opened = await new Promise(res => {
  ws.addEventListener("open", () => res(true), { once: true });
  ws.addEventListener("error", e => res(e?.message || "error"), { once: true });
  ws.addEventListener("close", e => res(`closed ${e.code} ${e.reason || ""}`), { once: true });
  setTimeout(() => res("timeout after 15s"), 15000);
});
check("ws connect", opened === true, opened === true ? `open in ${Date.now() - t0} ms` : `${opened} — a 401 here with REST passing means the WS path was signed wrong`);
if (opened !== true) finish();

ws.addEventListener("close", e => { seen.closed = { code: e.code, reason: e.reason, atS: Math.round((Date.now() - t0) / 1000) }; });
ws.addEventListener("message", ev => {
  const now = Date.now();
  let f; try { f = JSON.parse(ev.data); } catch { return; }
  seen.types[f.type] = (seen.types[f.type] || 0) + 1;
  const label = f.id != null ? pending.get(f.id) : null;
  if (f.type === "error") { seen.errors.push(`${label || "?"}: code ${f.msg?.code} ${f.msg?.msg}`); return; }
  if (f.type === "subscribed") { seen.subscribed[f.msg.channel] = f.msg.sid; seen.sids[f.msg.sid] = f.msg.channel; return; }
  if (f.type === "list_subscriptions" || label === "list") { seen.listSubs = f.msg; return; }
  if (f.type === "ok") {
    if (label === "add") seen.added = true;
    if (label === "remove") seen.removed = true;
    return;
  }
  if (/_indexlist$/.test(f.type)) { seen.indexlist = f.msg; return; }
  if (f.type === "orderbook_snapshot" || f.type === "orderbook_delta") {
    const r = book.apply(f);
    if (r.gap) seen.gaps.push(r.gap);
    if (f.type === "orderbook_delta" && f.msg?.ts_ms) seen.deltaLagMs.push(now - f.msg.ts_ms);
    if (f.type === "orderbook_snapshot" && f.msg?.market_ticker === second) seen.addedSnapshot = true;
    if (f.type === "orderbook_snapshot" && label === "snap") seen.getSnapshot = true;
    if (f.type === "orderbook_snapshot" && seen.snapAsked && f.msg?.market_ticker === ticker) seen.getSnapshot = true;
    return;
  }
  if (f.type === "trade") { seen.trades++; return; }
  if (f.type === "cfbenchmarks_value_5hz") { seen.idx5++; if (f.msg?.source_ts_ms) seen.idxLagMs.push(now - f.msg.source_ts_ms); seen.lastIdx5 = f.msg; return; }
  if (f.type === "cfbenchmarks_value") { seen.idx1++; seen.lastIdx1 = f.msg; return; }
});

// `use_yes_price` is sent EXPLICITLY. Kalshi has announced the default
// flips and the flag is then removed; lib/kalshiBook.js explains why a
// recorder must never rely on the default.
send(ws, "subscribe", { channels: ["orderbook_delta"], market_tickers: [ticker], use_yes_price: true }, "book");
send(ws, "subscribe", { channels: ["trade"], market_tickers: [ticker] }, "trade");
send(ws, "subscribe", { channels: ["cfbenchmarks_value_5hz"], index_ids: ["BRTI"] }, "idx5");
send(ws, "subscribe", { channels: ["cfbenchmarks_value"], index_ids: ["BRTI"] }, "idx1");
await sleep(SAMPLE_MS * 1.5);

// ── Cross-check: the socket's book against REST's, at the same moment ──
// REST /orderbook is uncached and in the LEGACY no-leg encoding, read by
// the same bookDepth() the polling recorder uses, so it is an independent
// reference. If use_yes_price were misread, the ask side would sit on the
// wrong side of the book and this disagrees by tens of cents, not ticks.
const samples = [];
const sampleEnd = t0 + SECONDS * 1000;
let step = 0;
while (Date.now() < sampleEnd) {
  step++;
  if (step === 3 && seen.subscribed.orderbook_delta != null) { seen.snapAsked = true; send(ws, "update_subscription", { sids: [seen.subscribed.orderbook_delta], market_tickers: [ticker], action: "get_snapshot" }, "snap"); }
  if (step === 4 && seen.subscribed.cfbenchmarks_value_5hz != null) send(ws, "update_subscription", { sid: seen.subscribed.cfbenchmarks_value_5hz, action: "indexlist" }, "indexlist");
  if (step === 5 && second && seen.subscribed.orderbook_delta != null) send(ws, "update_subscription", { sids: [seen.subscribed.orderbook_delta], market_tickers: [second], action: "add_markets" }, "add");
  if (step === 8 && second && seen.subscribed.orderbook_delta != null) send(ws, "update_subscription", { sids: [seen.subscribed.orderbook_delta], market_tickers: [second], action: "delete_markets" }, "remove");
  if (step === 9) send(ws, "list_subscriptions", null, "list");

  const r = await fetch(`${KALSHI_REST}/markets/${encodeURIComponent(ticker)}/orderbook`).then(r => r.json()).catch(() => null);
  const rest = bookDepth(r);
  const live = book.touch(ticker);
  if (live && live.bid != null && live.ask != null && rest.book_bid != null && rest.book_ask != null) {
    samples.push({
      dBid: Math.abs(live.bid - rest.book_bid), dAsk: Math.abs(live.ask - rest.book_ask),
      crossed: live.bid != null && live.ask != null && live.bid >= live.ask,
    });
  }
  await sleep(SAMPLE_MS);
}

// ── Verdicts ───────────────────────────────────────────────────────────
const secs = (Date.now() - t0) / 1000;
check("subscribe", ["orderbook_delta", "trade", "cfbenchmarks_value_5hz", "cfbenchmarks_value"].every(c => seen.subscribed[c] != null),
  `subscribed: ${Object.keys(seen.subscribed).join(", ") || "none"}`);
check("errors", seen.errors.length === 0, seen.errors.length ? seen.errors.join(" | ") : "none");
check("book snapshot", book.stats.snapshots > 0, `${book.stats.snapshots} snapshot(s), ${book.stats.deltas} deltas (${(book.stats.deltas / secs).toFixed(1)}/s), ${book.stats.droppedUntrusted} dropped as untrusted`);

const within = x => x <= 0.0105;
const close = samples.filter(s => within(s.dBid) && within(s.dAsk)).length;
const exact = samples.filter(s => s.dBid < 0.0005 && s.dAsk < 0.0005).length;
const crossed = samples.filter(s => s.crossed).length;
const worst = samples.length ? Math.max(...samples.map(s => Math.max(s.dBid, s.dAsk))) : null;
check("book vs REST", samples.length >= 5 && close / samples.length >= 0.7 && crossed === 0,
  `${samples.length} samples: ${exact} exact, ${close} within 1c, ${crossed} crossed, worst ${worst == null ? "—" : (worst * 100).toFixed(1) + "c"} (the book moves between the two reads, so exact is not expected every time)`);

check("sequence", seen.gaps.length === 0, seen.gaps.length ? `${seen.gaps.length} gap(s): ${JSON.stringify(seen.gaps.slice(0, 3))}` : "no gaps");
check("get_snapshot", seen.getSnapshot, seen.getSnapshot ? "re-snapshot on request works (this is how a gap is repaired)" : "no snapshot came back — gap repair would have to resubscribe");
if (second) check("add/remove market", seen.added && seen.addedSnapshot && seen.removed,
  `add ok=${seen.added}, snapshot for added market=${seen.addedSnapshot}, remove ok=${seen.removed}`);
check("trades", null, `${seen.trades} public trade(s) on ${ticker} in ${secs.toFixed(0)}s`);
check("BRTI 5Hz", seen.idx5 > secs * 2, `${seen.idx5} ticks (${(seen.idx5 / secs).toFixed(1)}/s), last ${seen.lastIdx5?.value_usd ?? "—"}; source->us median ${median(seen.idxLagMs) ?? "—"} ms`);
check("BRTI 1Hz", seen.idx1 > secs * 0.5, `${seen.idx1} ticks; 60s avg ${seen.lastIdx1?.avg_60s_data?.value ?? "—"}`);
check("delta latency", null, `exchange->us median ${median(seen.deltaLagMs) ?? "—"} ms (includes clock skew)`);
if (seen.indexlist) check("indexlist", null, JSON.stringify(seen.indexlist).slice(0, 200));
if (seen.listSubs) check("list_subscriptions", null, JSON.stringify(seen.listSubs).slice(0, 200));
// Kalshi pings every 10s and drops a client that does not pong. Node's
// WebSocket answers pings itself and does not surface them, so surviving
// several intervals is the evidence.
check("keep-alive", seen.closed == null, seen.closed ? `closed at ${seen.closed.atS}s: ${seen.closed.code} ${seen.closed.reason}` : `still open after ${secs.toFixed(0)}s (${Math.floor(secs / 10)} ping intervals)`);
check("frame types", null, JSON.stringify(seen.types));
ws.close();

// The index over REST needs a separate entitlement. Not required — the
// socket carries it — so this is a note, not a check.
const cf = await kalshiAuthed("GET", "/cfbenchmarks/values?id=BRTI", { keyId, key });
check("CF REST passthrough", null, `GET /cfbenchmarks/values -> ${cf.status}${cf.ok ? "" : " (not entitled — the socket carries the index anyway)"}`);

finish();

function finish() {
  const failed = results.filter(r => r.ok === false);
  console.log(`\n${failed.length ? `FAILED: ${failed.map(r => r.name).join(", ")}` : "ALL REQUIRED CHECKS PASSED"}`);
  process.exit(failed.length ? 1 : 0);
}
