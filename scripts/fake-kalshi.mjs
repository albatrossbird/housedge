// A fake Kalshi — REST and the WebSocket — for the end-to-end tests of
// the stream probe and the stream recorder. Not a test itself.
//
// It is faithful where a recorder could go wrong without noticing:
//
//   - It VERIFIES our signatures, REST and handshake, with the public
//     key. A fake that accepted anything would let a signing bug through
//     to the box, where it presents as a bare 401.
//   - It holds ONE book per market as the truth and serves it two ways:
//     REST /orderbook in the legacy no-leg encoding, and the socket in
//     whichever encoding the subscription asked for with use_yes_price.
//     Reading either the wrong way produces a different book, so the
//     tests can compare them.
//   - `seq` counts per subscription, and can be made to skip.
//
// installFakeKalshi() replaces globalThis.fetch and globalThis.WebSocket;
// requests to any other host go to `fallback` (the tests' fake PostgREST
// and Storage).
import { verify, constants, createPublicKey, generateKeyPairSync } from "node:crypto";

export const FAKE_HOST = "fake-kalshi.test";
export const FAKE_REST = `https://${FAKE_HOST}/trade-api/v2`;
export const FAKE_WS = `wss://${FAKE_HOST}/trade-api/ws/v2`;

const d4 = m => (m / 1000).toFixed(4);
const s2 = s => s.toFixed(2);

export function installFakeKalshi({
  publicKeyPem, keyId = "test-key-id", scopes = ["read"],
  markets = ["KXBTC15M-26SEP261500-00", "KXETH15M-26SEP261500-00"],
  closeTimes = {},              // ticker -> ISO close time
  statuses = {},                // ticker -> status (default active)
  seqSkipAt = null,             // skip one seq number after this many frames on a sid
  dropSocketAfterMs = null,     // server closes the first socket after this long
  tickMs = 40, idxMs = 200,
  ignoreYesPrice = false,       // CONTROL: serve legacy encoding whatever was asked
  fallback = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => [], text: async () => "[]" }),
} = {}) {
  // The account's keys. /api_keys/generate adds one and DELETE removes
  // one, so the key-setup script can be tested against the same fake.
  const keys = new Map();
  if (publicKeyPem) keys.set(keyId, { name: "temp", scopes, pub: createPublicKey(publicKeyPem) });
  const log = { handshakes: 0, rejected: 0, commands: [], restAuth: 0, sockets: 0, generated: [], deleted: [] };
  const signer = (headers, method, path) => {
    const h = k => headers?.[k] ?? headers?.get?.(k);
    const id = h("KALSHI-ACCESS-KEY"), rec = keys.get(id);
    if (!rec) return null;
    const ts = h("KALSHI-ACCESS-TIMESTAMP"), sig = h("KALSHI-ACCESS-SIGNATURE");
    if (!ts || !sig || Math.abs(Date.now() - Number(ts)) > 30000) return null;
    const data = Buffer.from(`${ts}${method}${path}`);
    try {
      const good = rec.pub.asymmetricKeyType === "ed25519"
        ? verify(null, data, rec.pub, Buffer.from(sig, "base64"))
        : verify("sha256", data, { key: rec.pub, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(sig, "base64"));
      return good ? id : null;
    } catch { return null; }
  };
  const verifySig = (...a) => signer(...a) != null;

  // The truth: YES bids and NO bids, both keyed in their OWN leg's price
  // (integer tenths of a cent), exactly as Kalshi's legacy REST serves them.
  const books = new Map();
  for (const t of markets) {
    books.set(t, {
      yes: new Map([[380, 4981.98], [370, 1644.6], [360, 200]]),
      no: new Map([[610, 291.65], [600, 1094], [590, 50]]),
    });
  }
  const snapshotMsg = (t, yesLeg) => {
    const b = books.get(t);
    return {
      market_ticker: t, market_id: `id-${t}`,
      yes_dollars_fp: [...b.yes].sort((a, c) => a[0] - c[0]).map(([p, s]) => [d4(p), s2(s)]),
      no_dollars_fp: [...b.no].sort((a, c) => a[0] - c[0]).map(([p, s]) => [d4(yesLeg ? 1000 - p : p), s2(s)]),
    };
  };

  const json = (body, status = 200, extra = {}) => ({
    ok: status < 400, status,
    headers: { get: k => ({ date: new Date().toUTCString(), ...extra })[String(k).toLowerCase()] ?? null },
    json: async () => body, text: async () => JSON.stringify(body),
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.host !== FAKE_HOST) return fallback(String(url), init, realFetch);
    const path = u.pathname.replace(/^\/trade-api\/v2/, "");
    const method = (init.method || "GET").toUpperCase();
    if (path === "/exchange/status") return json({ trading_active: true, exchange_active: true });
    if (path === "/markets" && u.searchParams.get("series_ticker")) {
      const s = u.searchParams.get("series_ticker");
      return json({ markets: markets.filter(t => t.startsWith(s + "-")).map(t => ({
        ticker: t, event_ticker: t.split("-").slice(0, 2).join("-"), status: statuses[t] || "active", floor_strike: 80000,
        close_time: closeTimes[t] || new Date(Date.now() + 600000).toISOString(),
        open_time: new Date(Date.now() - 300000).toISOString(),
      })) });
    }
    if (path === "/series") {
      const cat = u.searchParams.get("category");
      const series = [...new Set(markets.map(t => t.split("-")[0]))];
      return json({ series: cat === "Crypto" ? series.map(t => ({ ticker: t, title: t })) : [] });
    }
    const ob = path.match(/^\/markets\/([^/]+)\/orderbook$/);
    if (ob) {
      const t = decodeURIComponent(ob[1]);
      if (!books.has(t)) return json({ error: "not found" }, 404);
      const m = snapshotMsg(t, false);
      return json({ orderbook_fp: { yes_dollars: m.yes_dollars_fp, no_dollars: m.no_dollars_fp } });
    }
    // Everything below is authenticated.
    const caller = signer(init.headers, method, u.pathname);
    if (!caller) return json({ error: { code: "authentication_error" } }, 401);
    log.restAuth++;
    const canWrite = keys.get(caller).scopes.some(s => s.startsWith("write"));
    if (path === "/api_keys" && method === "GET")
      return json({ api_keys: [...keys].map(([api_key_id, k]) => ({ api_key_id, name: k.name, scopes: k.scopes })) });
    if (path === "/api_keys/generate" && method === "POST") {
      if (!canWrite) return json({ error: { code: "insufficient_scope" } }, 403);
      const b = JSON.parse(init.body || "{}");
      const type = b.key_type || "rsa";
      const { privateKey, publicKey } = type === "rsa" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ed25519");
      const id = `gen-${keys.size + 1}`;
      keys.set(id, { name: b.name, scopes: b.scopes || ["read", "write"], pub: publicKey });
      log.generated.push({ id, ...b });
      return json({ api_key_id: id, key_type: type,
        private_key: privateKey.export({ type: type === "rsa" ? "pkcs1" : "pkcs8", format: "pem" }) }, 201);
    }
    const del = path.match(/^\/api_keys\/([^/]+)$/);
    if (del && method === "DELETE") {
      if (!canWrite) return json({ error: { code: "insufficient_scope" } }, 403);
      if (!keys.delete(decodeURIComponent(del[1]))) return json({ error: "not found" }, 404);
      log.deleted.push(decodeURIComponent(del[1]));
      return { ok: true, status: 204, headers: { get: () => null }, json: async () => null, text: async () => "" };
    }
    if (path.startsWith("/cfbenchmarks/")) return json({ error: "not entitled" }, 403);
    return json({ error: "not found" }, 404);
  };

  // ── The socket ───────────────────────────────────────────────────────
  class FakeWebSocket {
    constructor(url, opts = {}) {
      this.url = url; this.readyState = 0; this.listeners = {}; this.subs = new Map(); this.timers = [];
      this.nextSid = 1; this.index = ++log.sockets;
      const ok = String(url).startsWith(FAKE_WS) && verifySig(opts.headers, "GET", "/trade-api/ws/v2");
      log.handshakes++;
      setTimeout(() => {
        if (!ok) {
          log.rejected++;
          this.readyState = 3;
          this.emit("error", { message: "Unexpected server response: 401" });
          this.emit("close", { code: 1006, reason: "" });
          return;
        }
        this.readyState = 1;
        this.emit("open", {});
        this.timers.push(setInterval(() => this.tick(), tickMs));
        this.timers.push(setInterval(() => this.index5(), idxMs));
        this.timers.push(setInterval(() => this.index1(), idxMs * 5));
        if (dropSocketAfterMs != null && this.index === 1) setTimeout(() => this.serverClose(1011, "internal error"), dropSocketAfterMs);
      }, 5);
    }
    addEventListener(type, fn, o = {}) { (this.listeners[type] ||= []).push({ fn, once: o.once }); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(l => l.fn !== fn); }
    emit(type, ev) {
      for (const l of [...(this.listeners[type] || [])]) { if (l.once) this.removeEventListener(type, l.fn); l.fn(ev); }
      if (typeof this[`on${type}`] === "function") this[`on${type}`](ev);
    }
    frame(obj) { if (this.readyState === 1) setImmediate(() => this.readyState === 1 && this.emit("message", { data: JSON.stringify(obj) })); }
    push(sid, type, msg) {
      const sub = this.subs.get(sid); if (!sub) return;
      sub.seq++; sub.sent++;
      if (seqSkipAt != null && sub.sent === seqSkipAt && !sub.skipped) { sub.skipped = true; sub.seq++; }
      this.frame({ type, sid, seq: sub.seq, msg });
    }
    serverClose(code, reason) {
      if (this.readyState !== 1) return;
      this.readyState = 3; this.timers.forEach(clearInterval);
      this.emit("close", { code, reason });
    }
    close() { this.serverClose(1000, ""); }
    send(raw) {
      const c = JSON.parse(raw); log.commands.push(c);
      const p = c.params || {};
      if (c.cmd === "subscribe") {
        for (const ch of p.channels || []) {
          const sid = this.nextSid++;
          const tickers = p.market_tickers || (p.market_ticker ? [p.market_ticker] : []);
          this.subs.set(sid, { channel: ch, tickers: new Set(tickers), yesLeg: p.use_yes_price === true && !ignoreYesPrice, seq: 0, sent: 0, indices: new Set(p.index_ids || []) });
          this.frame({ id: c.id, type: "subscribed", msg: { channel: ch, sid } });
          if (ch === "orderbook_delta") for (const t of tickers) if (books.has(t)) this.push(sid, "orderbook_snapshot", snapshotMsg(t, this.subs.get(sid).yesLeg));
        }
        return;
      }
      if (c.cmd === "update_subscription") {
        const sid = p.sid ?? p.sids?.[0]; const sub = this.subs.get(sid);
        if (!sub) return this.frame({ id: c.id, type: "error", msg: { code: 7, msg: "Unknown subscription ID" } });
        const tickers = p.market_tickers || [];
        if (p.action === "add_markets") {
          tickers.forEach(t => sub.tickers.add(t));
          sub.seq++; this.frame({ id: c.id, type: "ok", sid, seq: sub.seq, msg: { market_tickers: [...sub.tickers] } });
          if (sub.channel === "orderbook_delta") for (const t of tickers) if (books.has(t)) this.push(sid, "orderbook_snapshot", snapshotMsg(t, sub.yesLeg));
        } else if (p.action === "delete_markets") {
          tickers.forEach(t => sub.tickers.delete(t));
          sub.seq++; this.frame({ id: c.id, type: "ok", sid, seq: sub.seq, msg: { market_tickers: [...sub.tickers] } });
        } else if (p.action === "get_snapshot") {
          for (const t of tickers) if (books.has(t)) this.push(sid, "orderbook_snapshot", snapshotMsg(t, sub.yesLeg));
        } else if (p.action === "indexlist") {
          this.frame({ id: c.id, type: `${sub.channel}_indexlist`, sid, msg: { index_ids: ["BRTI", "ETHUSD_RTI"] } });
        } else if (p.action === "subscribe_indices") {
          (p.index_ids || []).forEach(i => sub.indices.add(i));
          this.frame({ id: c.id, type: "ok", sid, msg: {} });
        }
        return;
      }
      if (c.cmd === "list_subscriptions") {
        return this.frame({ id: c.id, type: "list_subscriptions", msg: [...this.subs].map(([sid, s]) => ({ sid, channel: s.channel })) });
      }
    }
    // One random change to one book, pushed to every subscription on it.
    // Kept uncrossed: YES bids 0.30-0.38, NO bids 0.59-0.61 (YES asks 0.39-0.41).
    tick() {
      for (const t of markets) {
        const b = books.get(t);
        const yesSide = Math.random() < 0.5;
        const p = yesSide ? 300 + 10 * Math.floor(Math.random() * 9) : 590 + 10 * Math.floor(Math.random() * 3);
        const side = yesSide ? b.yes : b.no;
        const cur = side.get(p) || 0;
        let delta = Math.round((Math.random() * 200 - 80) * 100) / 100;
        if (cur + delta <= 0) delta = -cur;
        if (delta === 0) continue;
        const next = Math.round((cur + delta) * 100) / 100;
        if (next > 0) side.set(p, next); else side.delete(p);
        for (const [sid, sub] of this.subs) {
          if (sub.channel !== "orderbook_delta" || !sub.tickers.has(t)) continue;
          this.push(sid, "orderbook_delta", {
            market_ticker: t, market_id: `id-${t}`, side: yesSide ? "yes" : "no",
            price_dollars: d4(yesSide || !sub.yesLeg ? p : 1000 - p), delta_fp: s2(delta), ts_ms: Date.now(),
          });
        }
        if (Math.random() < 0.05) for (const [sid, sub] of this.subs) {
          if (sub.channel === "trade" && sub.tickers.has(t)) this.push(sid, "trade", {
            trade_id: `tr-${Math.random()}`, market_ticker: t, yes_price_dollars: "0.4500", no_price_dollars: "0.5500",
            count_fp: "10.00", taker_side: "yes", ts: Math.floor(Date.now() / 1000), ts_ms: Date.now(),
          });
        }
      }
    }
    index5() {
      for (const [sid, sub] of this.subs) {
        if (sub.channel !== "cfbenchmarks_value_5hz") continue;
        for (const id of sub.indices.has("all") ? ["BRTI", "ETHUSD_RTI"] : sub.indices)
          this.push(sid, "cfbenchmarks_value_5hz", { index_id: id, value_usd: 80000 + Math.random(), source_ts_ms: Date.now() - 20, received_at: Date.now(), data: "{}" });
      }
    }
    index1() {
      for (const [sid, sub] of this.subs) {
        if (sub.channel !== "cfbenchmarks_value") continue;
        for (const id of sub.indices.has("all") ? ["BRTI", "ETHUSD_RTI"] : sub.indices)
          this.push(sid, "cfbenchmarks_value", { index_id: id, received_at: Date.now(), data: "{\"value\":\"80000.1\"}",
            avg_60s_data: { value: "80000.05", window_size: 60, window_start_ts_ms: Date.now() - 60000, window_end_ts_exclusive: Date.now() } });
      }
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  const addMarket = (t, { status = "active", close = null } = {}) => {
    markets.push(t); statuses[t] = status; if (close) closeTimes[t] = close;
    books.set(t, { yes: new Map([[350, 100]]), no: new Map([[600, 100]]) });
  };
  return { log, books, addMarket };
}
