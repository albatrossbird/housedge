// A WebSocket client that does NOT ask for compression.
//
// WHY THIS EXISTS. Node's built-in WebSocket always offers
// permessage-deflate and cannot be told not to (a Sec-WebSocket-Extensions
// header passed in is appended to, not replaced). Kalshi accepts it
// ("permessage-deflate; client_no_context_takeover"), and the built-in
// client then inflates every message on the zlib thread pool and waits
// for each one before reading the next. Measured 2026-09-30 on the box:
// ~850 messages a second with the event loop only ~45% busy, while
// Kalshi sent ~2-3x that — the receive lag climbed ~40s a minute until
// Kalshi dropped the connection (close 1006) every 4-15 minutes, and the
// archive was stamped up to 13 minutes late. Benchmarked the same way
// here: 6.8k messages/s compressed with the loop 51% busy, 231k/s plain.
//
// So this speaks RFC 6455 without extensions: an HTTP/1.1 upgrade over
// TLS, unmasked frames in, masked frames out, fragmentation, ping/pong,
// and the close handshake. It presents the subset of the WHATWG
// WebSocket interface the recorder and the probe use — addEventListener,
// send, close, readyState, extensions — so the callers do not change
// shape.
//
// A server that answers with an extension we did not offer, or sends a
// frame with RSV bits set, is a protocol error and the connection is
// failed rather than read: a compressed frame decoded as text would be
// garbage that still parses as bytes.
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";
import { randomBytes, createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HEADER = 16384;

export class PlainWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;

  constructor(url, { headers = {}, ca, handshakeTimeoutMs = 15000 } = {}) {
    this.url = String(url);
    this.readyState = 0;
    this.extensions = "";
    this.protocol = "";
    this._l = { open: [], message: [], error: [], close: [] };
    this._buf = null;
    this._frag = null;          // { op, parts: [] } while a fragmented message is arriving
    this._closeSent = false;
    this._closed = false;
    this._closeFrame = null;    // { code, reason } from the server's close frame

    const u = new URL(this.url);
    const secure = u.protocol === "wss:";
    const port = Number(u.port) || (secure ? 443 : 80);
    const key = randomBytes(16).toString("base64");
    this._accept = createHash("sha1").update(key + GUID).digest("base64");

    const sock = secure
      ? tlsConnect({ host: u.hostname, port, servername: u.hostname, ALPNProtocols: ["http/1.1"], ...(ca ? { ca } : {}) })
      : netConnect({ host: u.hostname, port });
    this._sock = sock;
    sock.setNoDelay(true);
    const req = [
      `GET ${u.pathname || "/"}${u.search} HTTP/1.1`,
      `Host: ${u.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ].join("\r\n") + "\r\n\r\n";
    sock.once(secure ? "secureConnect" : "connect", () => sock.write(req));
    this._hsTimer = setTimeout(() => this._fail(new Error(`handshake timed out after ${handshakeTimeoutMs}ms`), 1006), handshakeTimeoutMs);
    sock.on("data", d => this._onData(d));
    sock.on("error", e => this._fail(e, 1006));
    sock.on("close", () => this._finish(this._closeFrame?.code ?? 1006, this._closeFrame?.reason ?? ""));
  }

  addEventListener(type, fn, opts) {
    if (!this._l[type]) return;
    if (opts?.once) { const w = ev => { this.removeEventListener(type, w); fn(ev); }; this._l[type].push(w); }
    else this._l[type].push(fn);
  }
  removeEventListener(type, fn) { const a = this._l[type]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
  _emit(type, ev) {
    for (const fn of [...(this._l[type] || [])]) {
      // Like EventTarget: a throwing listener is reported, and does not
      // stop the frames already buffered behind it from being read.
      try { fn(ev); } catch (e) { queueMicrotask(() => { throw e; }); }
    }
  }

  send(data) {
    if (this.readyState !== 1) throw new Error("WebSocket is not open");
    this._write(0x1, Buffer.from(String(data)));
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    if (this.readyState === 0) { this._fail(new Error("closed before open"), 1006); return; }
    this.readyState = 2;
    this._sendClose(code, reason);
    // A server that never answers the close handshake is cut off.
    this._closeTimer = setTimeout(() => this._sock.destroy(), 5000);
  }

  // ── internals ──────────────────────────────────────────────────────
  _write(op, payload) {
    const n = payload.length;
    const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | op;
    if (n < 126) head[1] = 0x80 | n;
    else if (n < 65536) { head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); }
    else { head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(n), 2); }
    const mask = randomBytes(4), body = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i & 3];
    this._sock.write(Buffer.concat([head, mask, body]));
  }

  _sendClose(code, reason) {
    if (this._closeSent) return;
    this._closeSent = true;
    const r = Buffer.from(String(reason || ""));
    const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
    try { this._write(0x8, p); } catch {}
  }

  _fail(err, code) {
    if (this._closed) return;
    this._emit("error", { type: "error", message: err?.message || String(err), error: err });
    this._closeFrame = this._closeFrame || { code, reason: "" };
    this._sock.destroy();
    this._finish(code, "");
  }

  _finish(code, reason) {
    if (this._closed) return;
    this._closed = true;
    clearTimeout(this._hsTimer); clearTimeout(this._closeTimer);
    this.readyState = 3;
    this._emit("close", { type: "close", code, reason, wasClean: code !== 1006 });
  }

  _onData(d) {
    this._buf = this._buf && this._buf.length ? Buffer.concat([this._buf, d]) : d;
    if (this.readyState === 0 && !this._handshake()) return;
    let off = 0;
    const b = this._buf;
    while (!this._closed) {
      if (b.length - off < 2) break;
      const b0 = b[off], b1 = b[off + 1];
      const fin = (b0 & 0x80) !== 0, rsv = b0 & 0x70, op = b0 & 0x0f;
      if (b1 & 0x80) return this._protocolError("server frames must not be masked");
      if (rsv) return this._protocolError("RSV bits set — an extension we did not negotiate (compression?)");
      let len = b1 & 0x7f, p = off + 2;
      if (len === 126) { if (b.length - p < 2) break; len = b.readUInt16BE(p); p += 2; }
      else if (len === 127) { if (b.length - p < 8) break; const big = b.readBigUInt64BE(p); if (big > BigInt(Number.MAX_SAFE_INTEGER)) return this._protocolError("frame too large"); len = Number(big); p += 8; }
      if (b.length - p < len) break;
      const payload = b.subarray(p, p + len);
      off = p + len;
      this._frame(fin, op, payload);
    }
    this._buf = off >= b.length ? null : b.subarray(off);
  }

  _handshake() {
    const end = this._buf.indexOf("\r\n\r\n");
    if (end < 0) { if (this._buf.length > MAX_HEADER) this._fail(new Error("handshake response too large"), 1006); return false; }
    const lines = this._buf.subarray(0, end).toString("latin1").split("\r\n");
    this._buf = this._buf.subarray(end + 4);
    const status = Number((lines[0].match(/^HTTP\/1\.1 (\d{3})/) || [])[1]);
    const h = Object.fromEntries(lines.slice(1).map(l => { const i = l.indexOf(":"); return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()]; }));
    if (status !== 101) { this._fail(new Error(`Unexpected server response: ${status || lines[0]}`), 1006); return false; }
    if (h["sec-websocket-accept"] !== this._accept) { this._fail(new Error("bad Sec-WebSocket-Accept"), 1006); return false; }
    if (h["sec-websocket-extensions"]) { this._fail(new Error(`server negotiated an extension we did not offer: ${h["sec-websocket-extensions"]}`), 1006); return false; }
    clearTimeout(this._hsTimer);
    this.readyState = 1;
    this._emit("open", { type: "open" });
    return !this._closed;
  }

  _protocolError(msg) { this._sendClose(1002, ""); this._fail(new Error(msg), 1002); }

  _frame(fin, op, payload) {
    if (op >= 0x8) {
      if (!fin || payload.length > 125) return this._protocolError("bad control frame");
      if (op === 0x9) { if (!this._closeSent) this._write(0xA, Buffer.from(payload)); return; }
      if (op === 0xA) return;
      if (op === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        this._closeFrame = { code, reason };
        this.readyState = 2;
        this._sendClose(code === 1005 ? 1000 : code, "");
        this._sock.end();
        // The server should now close TCP; one that does not is cut off,
        // so the close is always reported.
        clearTimeout(this._closeTimer);
        this._closeTimer = setTimeout(() => this._sock.destroy(), 1000);
        return;
      }
      return this._protocolError(`unknown control opcode ${op}`);
    }
    if (op === 0x0) {
      if (!this._frag) return this._protocolError("continuation without a start");
      this._frag.parts.push(Buffer.from(payload));
      if (!fin) return;
      const { op: o, parts } = this._frag; this._frag = null;
      return this._deliver(o, Buffer.concat(parts));
    }
    if (op !== 0x1 && op !== 0x2) return this._protocolError(`unknown opcode ${op}`);
    if (this._frag) return this._protocolError("new message inside a fragmented one");
    if (!fin) { this._frag = { op, parts: [Buffer.from(payload)] }; return; }
    this._deliver(op, payload);
  }

  _deliver(op, payload) {
    this._emit("message", { type: "message", data: op === 0x1 ? payload.toString("utf8") : Buffer.from(payload) });
  }
}

// Which client a Kalshi socket uses. The tests drive the recorder and the
// probe against scripts/fake-kalshi.mjs, which replaces globalThis.WebSocket
// in-process, so they ask for the global one explicitly; everything else
// gets the client that does not negotiate compression.
export function kalshiWebSocket(env = process.env) {
  return env.KALSHI_WS_CLIENT === "global" ? globalThis.WebSocket : PlainWebSocket;
}
