// A fake Polymarket US market-data socket (and the gateway's Date header)
// for scripts/pmus15-stream.test.mjs. Not a test itself.
//
// Faithful where the recorder could go wrong without noticing:
//   - It VERIFIES the handshake signature against the public key, and the
//     timestamp's freshness. A fake that accepted anything would let a
//     signing bug reach the box, where it is a refused handshake with the
//     HTTP status hidden.
//   - Every marketData is a WHOLE book, keyed `offers` rather than `asks`,
//     prices as {value} strings — the shape the published SDK types.
//   - A slug it does not list gets an error, as an unlisted window would.
//
// installFakePolyUs() replaces globalThis.fetch and globalThis.WebSocket;
// requests to any other host go to `fallback`.
import { verify, createPublicKey } from "node:crypto";

export const FAKE_PMUS_HOST = "fake-polyus.test";
export const FAKE_PMUS_WS = `wss://${FAKE_PMUS_HOST}/v1/ws/markets`;
export const FAKE_PMUS_GATEWAY = `https://${FAKE_PMUS_HOST}/v1`;

export function installFakePolyUs({
  publicKeyPem, keyId = "test-pm-key", listed = () => true, tickMs = 60, heartbeatMs = 300,
  dropSocketAfterMs = null, silentAfterMs = null, clockOffsetMs = 0, gatewayDown = false, fallback,
}) {
  const pub = createPublicKey(publicKeyPem);
  const log = { handshakes: 0, rejected: 0, sockets: 0, commands: [], sent: 0 };
  const mids = new Map();   // slug -> the book's mid, shared across sockets (tests price a "Kalshi" book off it)
  const px = v => ({ value: v.toFixed(4), currency: "USD" });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.host !== FAKE_PMUS_HOST) return fallback(String(url), init, realFetch);
    if (gatewayDown) throw new TypeError("fetch failed");
    const date = new Date(Date.now() + clockOffsetMs).toUTCString();
    return { ok: true, status: 200, headers: { get: k => String(k).toLowerCase() === "date" ? date : null },
      json: async () => ({ events: [] }), text: async () => "{\"events\":[]}" };
  };

  function verifySig(h = {}) {
    const ts = h["X-PM-Timestamp"], sig = h["X-PM-Signature"];
    if (h["X-PM-Access-Key"] !== keyId || !ts || !sig) return false;
    if (Math.abs(Date.now() - Number(ts)) > 30000) return false;
    try { return verify(null, Buffer.from(`${ts}GET/v1/ws/markets`), pub, Buffer.from(sig, "base64")); } catch { return false; }
  }

  class FakeWebSocket {
    constructor(url, opts = {}) {
      this.readyState = 0; this.listeners = {}; this.subs = new Map(); this.timers = [];
      this.index = ++log.sockets;
      const ok = String(url) === FAKE_PMUS_WS && verifySig(opts.headers);
      log.handshakes++;
      setTimeout(() => {
        if (!ok) {
          log.rejected++; this.readyState = 3;
          this.emit("error", { message: "Unexpected server response: 401" });
          this.emit("close", { code: 1006, reason: "" });
          return;
        }
        this.readyState = 1; this.openedAt = Date.now();
        this.emit("open", {});
        this.timers.push(setInterval(() => this.tick(), tickMs));
        this.timers.push(setInterval(() => this.out({ heartbeat: {} }), heartbeatMs));
        if (dropSocketAfterMs != null && this.index === 1) setTimeout(() => this.serverClose(1011, "internal error"), dropSocketAfterMs);
      }, 5);
    }
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
    emit(ev, arg) { for (const fn of this.listeners[ev] || []) fn(arg); }
    silent() { return silentAfterMs != null && this.index === 1 && Date.now() - this.openedAt > silentAfterMs; }
    out(obj) { if (this.readyState === 1 && !this.silent()) { log.sent++; this.emit("message", { data: JSON.stringify(obj) }); } }
    send(text) {
      const m = JSON.parse(text);
      log.commands.push({ socket: this.index, ...m });
      if (m.subscribe) {
        const { requestId, subscriptionType, marketSlugs } = m.subscribe;
        const slug = marketSlugs?.[0];
        if (!listed(slug)) { setTimeout(() => this.out({ requestId, error: `market not found: ${slug}` }), 5); return; }
        this.subs.set(requestId, { type: subscriptionType, slug });
        if (!mids.has(slug)) mids.set(slug, 0.62);   // off 50c: a book symmetric about 50c cannot say which side it is
      }
      if (m.unsubscribe) this.subs.delete(m.unsubscribe.requestId);
    }
    tick() {
      for (const [requestId, s] of this.subs) {
        if (s.type === "SUBSCRIPTION_TYPE_MARKET_DATA") {
          let mid = mids.get(s.slug);
          if (Math.random() < 0.5) { mid = Math.min(0.9, Math.max(0.1, mid + (Math.random() < 0.5 ? -0.01 : 0.01))); mids.set(s.slug, mid); }
          const bids = [0, 1, 2, 3].map(i => ({ px: px(mid - 0.005 - i * 0.01), qty: String(100 + i * 50) }));
          const offers = [0, 1, 2, 3].map(i => ({ px: px(mid + 0.005 + i * 0.01), qty: String(120 + i * 40) }));
          // Deliberately unsorted on the wire, so the reader has to order it.
          this.out({ requestId, subscriptionType: s.type, marketData: { marketSlug: s.slug, bids: bids.reverse(), offers,
            state: "MARKET_STATE_OPEN", stats: { sharesTraded: "1234" }, transactTime: new Date().toISOString() } });
        } else if (Math.random() < 0.2) {
          this.out({ requestId, subscriptionType: s.type, trade: { marketSlug: s.slug, price: px(0.5), quantity: { value: "10" },
            tradeTime: new Date().toISOString(), maker: { side: "SELL", intent: "OPEN" }, taker: { side: "BUY", intent: "OPEN" } } });
        }
      }
    }
    serverClose(code, reason) {
      if (this.readyState !== 1) return;
      this.readyState = 3; this.timers.forEach(clearInterval);
      this.emit("close", { code, reason });
    }
    close() { this.serverClose(1000, "OK"); }
  }
  globalThis.WebSocket = FakeWebSocket;
  return { log, mids };
}
