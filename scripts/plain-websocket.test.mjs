// lib/plainWebSocket.js against a real local server (plain TCP and TLS),
// speaking raw RFC 6455 frames — not against the in-process fake the
// recorder's tests use, which replaces the client altogether.
//
// Pinned here:
//   1. The handshake offers NO extensions, carries the caller's headers,
//      and is refused on a bad accept hash or an extension we never
//      offered.
//   2. Every framing shape the server can send is read: 7-bit, 16-bit and
//      64-bit lengths, many frames in one TCP chunk, one frame split over
//      many chunks, fragmented messages, binary.
//   3. Pings are answered, masked, with their payload; our frames are
//      masked; a compressed (RSV1) frame is a protocol error, not text.
//   4. Close: the server's close frame is echoed and reported with its
//      code; a dropped socket reports 1006; our own close completes.
//   5. Throughput: the point of the module. It must read a burst far
//      faster than the compressed built-in client managed on the box.
import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlainWebSocket, kalshiWebSocket } from "../lib/plainWebSocket.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const frame = (op, payload, { fin = true, rsv = 0 } = {}) => {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const n = p.length;
  const h = n < 126 ? Buffer.from([(fin ? 0x80 : 0) | rsv | op, n])
    : n < 65536 ? Buffer.from([(fin ? 0x80 : 0) | rsv | op, 126, n >> 8, n & 255])
    : (() => { const b = Buffer.alloc(10); b[0] = (fin ? 0x80 : 0) | rsv | op; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([h, p]);
};
// Client frames are masked; decode everything the client sent.
function decodeClient(buf) {
  const out = []; let off = 0;
  while (buf.length - off >= 2) {
    const op = buf[off] & 15, masked = (buf[off + 1] & 0x80) !== 0; let len = buf[off + 1] & 127, p = off + 2;
    if (len === 126) { len = buf.readUInt16BE(p); p += 2; } else if (len === 127) { len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const mask = masked ? buf.subarray(p, p + 4) : null; if (masked) p += 4;
    if (buf.length - p < len) break;
    const body = Buffer.from(buf.subarray(p, p + len)); if (mask) for (let i = 0; i < len; i++) body[i] ^= mask[i & 3];
    out.push({ op, masked, body }); off = p + len;
  }
  return out;
}

// A server whose upgrade handler is the scenario under test.
function serve(onUpgrade, tlsOpts = null) {
  return new Promise(res => {
    const srv = tlsOpts ? https.createServer(tlsOpts) : http.createServer();
    srv.on("upgrade", (req, sock) => {
      sock.on("error", () => {});
      const rx = []; sock.on("data", d => rx.push(d));
      const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + GUID).digest("base64");
      onUpgrade({ req, sock, accept, rx: () => decodeClient(Buffer.concat(rx)), ok101: (extra = "") => sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${extra}\r\n`) });
    });
    srv.listen(0, "127.0.0.1", () => res({ srv, port: srv.address().port }));
  });
}
const events = ws => {
  const e = { open: 0, msgs: [], errors: [], close: null };
  ws.addEventListener("open", () => e.open++);
  ws.addEventListener("message", m => e.msgs.push(m.data));
  ws.addEventListener("error", x => e.errors.push(x.message));
  ws.addEventListener("close", c => { e.close = c; });
  return e;
};
const until = (f, ms = 3000) => new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { if (f()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error("timed out")); } }, 5); });
const wait = ms => new Promise(r => setTimeout(r, ms));

console.log("handshake");
{
  let seen;
  const { srv, port } = await serve(({ req, ok101, sock }) => { seen = req.headers; ok101(); sock.write(frame(1, "hello")); });
  const ws = new PlainWebSocket(`ws://127.0.0.1:${port}/trade-api/ws/v2?x=1`, { headers: { "KALSHI-ACCESS-KEY": "kid", "KALSHI-ACCESS-SIGNATURE": "sig" } });
  const e = events(ws);
  await until(() => e.msgs.length === 1);
  ok(!("sec-websocket-extensions" in seen), "offers NO extensions (no permessage-deflate)", JSON.stringify(seen));
  ok(seen["kalshi-access-key"] === "kid" && seen["kalshi-access-signature"] === "sig", "carries the caller's headers");
  ok(e.open === 1 && ws.readyState === 1 && ws.extensions === "", "opens, with no extensions negotiated");
  ok(e.msgs[0] === "hello", "and reads the first message");
  ws.close(); srv.close();
}
{
  const { srv, port } = await serve(({ sock }) => sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong=\r\n\r\n"));
  const ws = new PlainWebSocket(`ws://127.0.0.1:${port}/`); const e = events(ws);
  await until(() => e.close);
  ok(e.open === 0 && e.close.code === 1006 && /Accept/.test(e.errors[0]), "a bad accept hash never opens", JSON.stringify(e));
  srv.close();
}
{
  const { srv, port } = await serve(({ ok101 }) => ok101("Sec-WebSocket-Extensions: permessage-deflate\r\n"));
  const ws = new PlainWebSocket(`ws://127.0.0.1:${port}/`); const e = events(ws);
  await until(() => e.close);
  ok(e.open === 0 && /extension we did not offer/.test(e.errors[0]), "an extension we never offered is refused, not read", JSON.stringify(e));
  srv.close();
}
{
  const { srv, port } = await serve(({ sock }) => sock.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"));
  const ws = new PlainWebSocket(`ws://127.0.0.1:${port}/`); const e = events(ws);
  await until(() => e.close);
  ok(e.open === 0 && e.close.code === 1006 && /401/.test(e.errors[0]), "a refused handshake says so", JSON.stringify(e));
  srv.close();
}

console.log("framing");
{
  const big = "x".repeat(70000), mid = "m".repeat(300);
  const { srv, port } = await serve(async ({ ok101, sock }) => {
    ok101();
    // Several frames in one chunk.
    sock.write(Buffer.concat([frame(1, "a"), frame(1, mid), frame(1, big)]));
    // One frame dribbled a byte at a time.
    const f = frame(1, '{"type":"orderbook_delta","seq":7}');
    for (const byte of f) { sock.write(Buffer.from([byte])); await wait(1); }
    // A fragmented message: text start, continuation, final continuation.
    sock.write(Buffer.concat([frame(1, "frag-", { fin: false }), frame(0, "men", { fin: false }), frame(0, "ted")]));
    // A ping in the middle of a fragmented message is allowed.
    sock.write(Buffer.concat([frame(1, "p1-", { fin: false }), frame(9, "png"), frame(0, "p2")]));
    sock.write(frame(2, Buffer.from([1, 2, 3])));
  });
  const ws = new PlainWebSocket(`ws://127.0.0.1:${port}/`); const e = events(ws);
  await until(() => e.msgs.length === 7);
  ok(e.msgs[0] === "a" && e.msgs[1] === mid && e.msgs[2] === big, "7-bit, 16-bit and 64-bit lengths, several frames in one chunk");
  ok(e.msgs[3] === '{"type":"orderbook_delta","seq":7}', "a frame split across many chunks");
  ok(e.msgs[4] === "frag-mented" && e.msgs[5] === "p1-p2", "fragmented messages reassemble, with a control frame between fragments");
  ok(Buffer.isBuffer(e.msgs[6]) && e.msgs[6].equals(Buffer.from([1, 2, 3])), "binary arrives as bytes");
  ws.close(); srv.close();
}

console.log("ping, send, masking");
{
  let rx;
  const { srv, port } = await serve(({ ok101, sock, rx: r }) => { rx = r; ok101(); sock.write(frame(9, "are-you-there")); });
  const ws = new PlainWebSocket(`ws://127.0.0.1:${port}/`); const e = events(ws);
  await until(() => e.open);
  ws.send(JSON.stringify({ id: 1, cmd: "subscribe" }));
  await until(() => rx().length >= 2);
  const got = rx();
  const pong = got.find(f => f.op === 10), text = got.find(f => f.op === 1);
  ok(pong && pong.masked && pong.body.toString() === "are-you-there", "a ping is answered with a masked pong carrying its payload");
  ok(text && text.masked && text.body.toString() === '{"id":1,"cmd":"subscribe"}', "what we send is masked and arrives intact");
  ws.close(); srv.close();
}
{
  const { srv, port } = await serve(({ ok101, sock }) => { ok101(); sock.write(frame(1, "x", { rsv: 0x40 })); });
  const ws = new PlainWebSocket(`ws://127.0.0.1:${port}/`); const e = events(ws);
  await until(() => e.close);
  ok(e.msgs.length === 0 && e.close.code === 1002 && /RSV/.test(e.errors[0]), "a compressed (RSV1) frame is a protocol error, never delivered as text", JSON.stringify(e));
  srv.close();
}

console.log("closing");
{
  let rx;
  const { srv, port } = await serve(({ ok101, sock, rx: r }) => { rx = r; ok101(); const p = Buffer.alloc(5); p.writeUInt16BE(1001, 0); p.write("bye", 2); sock.write(frame(8, p)); });
  const ws = new PlainWebSocket(`ws://127.0.0.1:${port}/`); const e = events(ws);
  await until(() => e.close);
  ok(e.close.code === 1001 && e.close.reason === "bye" && e.close.wasClean, "the server's close frame is reported with its code and reason", JSON.stringify(e.close));
  ok(rx().some(f => f.op === 8), "and echoed back");
  srv.close();
}
{
  const { srv, port } = await serve(({ ok101, sock }) => { ok101(); setTimeout(() => sock.destroy(), 50); });
  const ws = new PlainWebSocket(`ws://127.0.0.1:${port}/`); const e = events(ws);
  await until(() => e.close);
  ok(e.open === 1 && e.close.code === 1006 && !e.close.wasClean, "a dropped socket reports 1006 — the code Kalshi's drops arrive as", JSON.stringify(e.close));
  srv.close();
}
{
  const { srv, port } = await serve(({ ok101, sock }) => {
    ok101();
    sock.on("data", d => { for (const f of decodeClient(d)) if (f.op === 8) { sock.write(frame(8, f.body)); sock.end(); } });
  });
  const ws = new PlainWebSocket(`ws://127.0.0.1:${port}/`); const e = events(ws);
  await until(() => e.open);
  ws.close(1000);
  await until(() => e.close);
  ok(e.close.code === 1000 && ws.readyState === 3, "our own close completes the handshake", JSON.stringify(e.close));
  srv.close();
}

console.log("TLS");
{
  const dir = mkdtempSync(join(tmpdir(), "pws-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
  const cert = readFileSync(join(dir, "c.pem")), key = readFileSync(join(dir, "k.pem"));
  const { srv, port } = await serve(({ ok101, sock }) => { ok101(); sock.write(frame(1, "secure")); }, { cert, key });
  const ws = new PlainWebSocket(`wss://localhost:${port}/`, { ca: cert }); const e = events(ws);
  await until(() => e.msgs.length);
  ok(e.msgs[0] === "secure", "wss:// with certificate verification");
  ws.close();
  const bad = new PlainWebSocket(`wss://localhost:${port}/`); const eb = events(bad);
  await until(() => eb.close);
  ok(eb.open === 0 && eb.errors.length, "an untrusted certificate is refused, not ignored", JSON.stringify(eb));
  srv.close();
}

console.log("throughput");
{
  const N = 200000;
  const msg = JSON.stringify({ type: "orderbook_delta", sid: 1, seq: 123456, msg: { market_ticker: "KXBTC15M-26SEP291900-00", price_dollars: "0.4300", delta_fp: "-12.34", side: "yes", ts_ms: 1790000000000 } });
  const f = frame(1, msg);
  const { srv, port } = await serve(({ ok101, sock }) => {
    ok101();
    let sent = 0;
    const pump = () => { while (sent < N) { const n = Math.min(500, N - sent); sent += n; if (!sock.write(Buffer.concat(Array(n).fill(f)))) return sock.once("drain", pump); } };
    pump();
  });
  const ws = new PlainWebSocket(`ws://127.0.0.1:${port}/`);
  let n = 0, t0 = 0;
  ws.addEventListener("open", () => { t0 = performance.now(); });
  ws.addEventListener("message", ev => { JSON.parse(ev.data); n++; });
  await until(() => n === N, 20000);
  const rate = N / ((performance.now() - t0) / 1000);
  ok(rate > 50000, `reads ${Math.round(rate).toLocaleString()} messages/s (the box needs ~3k; the compressed built-in client managed ~850 there)`);
  ws.close(); srv.close();
}

console.log("which client");
ok(kalshiWebSocket({}) === PlainWebSocket, "Kalshi sockets use the uncompressed client by default");
ok(kalshiWebSocket({ KALSHI_WS_CLIENT: "global" }) === globalThis.WebSocket, "the in-process fake is used only when asked for");

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
process.exit(0);
