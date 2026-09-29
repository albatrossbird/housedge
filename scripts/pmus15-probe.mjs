// Prove the Polymarket US socket from the box before recording from it.
// Writes nothing. Run it the way the unit will run the recorder:
//
//   sudo systemd-run --quiet --wait --pipe --uid=marketslap \
//     -p EnvironmentFile=/etc/polyus/id.env \
//     -p LoadCredential=polyus.key:/etc/polyus/polyus.key \
//     /usr/bin/node /opt/marketslap/scripts/pmus15-probe.mjs
//
// Checks, in the order a failure would be diagnosed:
//   node         22+, for the built-in WebSocket
//   secret       loads and is well-formed (its LENGTH is printed, never it)
//   clock        within 10s of the gateway's
//   handshake    the socket opens (a refusal hides its HTTP status, so the
//                clock is checked separately, first)
//   book         a whole two-sided book arrives for the current window
//   same side    the book agrees with Kalshi's live book for the SAME
//                window — Up is Kalshi's YES. Checked against the mirror
//                too: a book that matches 1-price is the Down side, and
//                every gap measured off it would be fiction.
//   trades       the trade subscription is accepted
//
// The key is the box's .us key, which can trade. This script only reads
// the market-data socket.
import { PMUS_WS, PMUS_WS_PATH, PMUS_GATEWAY, polyUsSecretPath, loadPolyUsSecret, polyUsAuthHeaders } from "../lib/polyUsAuth.js";
import { WINDOW_MS, windowStart, pmusSlug, kalshiM15Ticker, normalizeBook } from "../lib/pmus15.js";
import { KALSHI_REST } from "../lib/kalshiAuth.js";
import { readFileSync } from "node:fs";

const env = process.env;
const SECONDS = Number(env.PROBE_SECONDS || 30);
const SAMPLE_MS = Number(env.PROBE_SAMPLE_MS || 2000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const say = (pass, name, detail = "") => { console.log(`${pass === null ? "info" : pass ? "  ok" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); if (pass === false) failed++; };
const finish = () => { console.log(failed ? `\n${failed} REQUIRED CHECK(S) FAILED` : "\nALL REQUIRED CHECKS PASSED"); process.exit(failed ? 1 : 0); };

const major = Number(process.versions.node.split(".")[0]);
say(major >= 22 && typeof WebSocket === "function", "node", `v${process.versions.node}`);
if (typeof WebSocket !== "function") finish();

let secret;
const keyId = env.PM_KEY_ID;
try {
  const path = polyUsSecretPath(env);
  secret = loadPolyUsSecret(path);
  say(!!keyId, "secret", `${readFileSync(path, "utf8").trim().length} characters; key id ${keyId ? "set" : "MISSING — load /etc/polyus/id.env"}`);
} catch (e) { say(false, "secret", e.message); finish(); }
if (!keyId) finish();

{
  let drift = null;
  try {
    const t0 = Date.now();
    const r = await fetch(`${PMUS_GATEWAY}/events?limit=1&_=${t0}`);
    const d = Date.parse(r.headers.get("date") || "");
    if (Number.isFinite(d)) drift = (t0 + Date.now()) / 2 - d;
  } catch (e) { say(false, "clock", `could not reach the gateway: ${e.message}`); }
  if (drift != null) say(Math.abs(drift) <= 10000, "clock", `${(drift / 1000).toFixed(1)}s from the gateway (1s resolution)`);
}

// The current window unless it is nearly over; then the next.
const now = Date.now();
const start = windowStart(now) + (now - windowStart(now) > WINDOW_MS - 180000 ? WINDOW_MS : 0);
const slug = pmusSlug("btc", start), ticker = kalshiM15Ticker("btc", start + WINDOW_MS);
say(null, "window", `${slug}  ~  ${ticker}`);

const books = [], errors = [];
let heartbeats = 0, messages = 0, trades = 0;
const ws = new WebSocket(PMUS_WS, { headers: polyUsAuthHeaders(keyId, secret, "GET", PMUS_WS_PATH) });
const opened = await new Promise(res => {
  const t = setTimeout(() => res(false), 10000);
  ws.addEventListener("open", () => { clearTimeout(t); res(true); });
  ws.addEventListener("close", () => { clearTimeout(t); res(false); });
});
say(opened, "handshake", opened ? "socket open" : "refused or timed out — a deleted or wrong key, or the clock; Node hides the HTTP status");
if (!opened) finish();
ws.addEventListener("message", ev => {
  let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
  messages++;
  if (m.heartbeat !== undefined) heartbeats++;
  else if (m.error !== undefined) errors.push(`${m.requestId ?? "-"}: ${String(m.error).slice(0, 160)}`);
  else if (m.marketData?.marketSlug === slug) books.push({ t: Date.now(), ...normalizeBook(m.marketData) });
  else if (m.trade) trades++;
});
ws.send(JSON.stringify({ subscribe: { requestId: "probe-md", subscriptionType: "SUBSCRIPTION_TYPE_MARKET_DATA", marketSlugs: [slug] } }));
ws.send(JSON.stringify({ subscribe: { requestId: "probe-tr", subscriptionType: "SUBSCRIPTION_TYPE_TRADE", marketSlugs: [slug] } }));

for (let i = 0; i < 100 && !books.length && !errors.length; i++) await sleep(100);
const first = books[0];
say(!!first && first.b.length > 0 && first.a.length > 0, "book", first
  ? `${first.b.length} bid / ${first.a.length} offer levels, touch ${first.b[0]?.[0]} / ${first.a[0]?.[0]}, transactTime ${first.x ? new Date(first.x).toISOString() : "MISSING"}`
  : errors.length ? `refused: ${errors[0]}` : "no book within 10s");
if (!first) { ws.close(); finish(); }

// Kalshi's /orderbook is not CDN-cached (its /markets list is), so it is
// the live side to compare against. Public; no Kalshi key needed.
const samples = [];
const until = Date.now() + SECONDS * 1000;
while (Date.now() < until) {
  try {
    const r = await fetch(`${KALSHI_REST}/markets/${ticker}/orderbook?_=${Date.now()}`);
    const j = r.ok ? await r.json() : null;
    const ob = j?.orderbook_fp || {};
    const yes = (ob.yes_dollars || []).map(([p]) => Number(p)), no = (ob.no_dollars || []).map(([p]) => Number(p));
    const us = books[books.length - 1];
    if (yes.length && no.length && us?.b.length && us?.a.length) {
      const kb = Math.max(...yes), ka = 1 - Math.max(...no);
      samples.push({ same: Math.max(Math.abs(us.b[0][0] - kb), Math.abs(us.a[0][0] - ka)),
        mirror: Math.max(Math.abs((1 - us.a[0][0]) - kb), Math.abs((1 - us.b[0][0]) - ka)) });
    }
  } catch {}
  await sleep(SAMPLE_MS);
}
const within = (k, c) => samples.filter(s => s[k] <= c + 1e-9).length;
const n = samples.length;
const agree = within("same", 0.02), mirror = within("mirror", 0.02);
say(n >= 5 && agree >= 0.7 * n && agree > mirror, "same side",
  n < 5 ? `only ${n} paired samples` : `${agree}/${n} within 2c of Kalshi YES (exact ${within("same", 0)}), ${mirror}/${n} against the mirror`);
if (n >= 5 && mirror > agree) say(false, "same side", "the book matches Kalshi's NO: it is the Down side");

say(!errors.some(e => e.startsWith("probe-tr")), "trades", `${trades} trade message(s) in ${SECONDS}s${errors.length ? `; errors: ${errors.join(" | ")}` : ""}`);
say(null, "socket", `${messages} messages, ${books.length} books, ${heartbeats} heartbeats in ~${SECONDS + 1}s`);
ws.send(JSON.stringify({ unsubscribe: { requestId: "probe-md" } }));
ws.send(JSON.stringify({ unsubscribe: { requestId: "probe-tr" } }));
ws.close(1000, "OK");
finish();
