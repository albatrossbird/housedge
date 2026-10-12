// scripts/m15-bigprint.mjs end to end, against a fake Storage archive and
// a fake PostgREST: one settled Bitcoin window with trades on both venues.
// Pins that Kalshi's yp/side and .us's intent/p become the price the taker
// paid, that each venue is charged its own fee, and that windows are
// reduced as the record passes them.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pmusSlug, kalshiM15Ticker, WINDOW_MS } from "../lib/pmus15.js";

const HERE = new URL(".", import.meta.url).pathname;
let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w}\n${extra}`); } };

const close = Math.floor((Date.now() - 3600000) / WINDOW_MS) * WINDOW_MS;
const iso = ms => new Date(ms).toISOString();
const T = kalshiM15Ticker("btc", close), SLUG = pmusSlug("btc", close - WINDOW_MS);
const k = [
  { k: "tr", t: close - 60000, x: close - 60000, m: T, yp: 0.60, n: 5000, side: "yes", id: "t1" },   // the big print
  { k: "tr", t: close - 60000, x: close - 60000, m: T, yp: 0.60, n: 5000, side: "yes", id: "t1" },   // the same trade, written twice
  { k: "tr", t: close - 59000, x: close - 59000, m: T, yp: 0.64, n: 10, side: "yes" },     // +1000ms, same side
  { k: "tr", t: close - 58000, x: close - 58000, m: T, yp: 0.70, n: 10, side: "no" },      // NO paid 0.30
  { k: "tr", t: close - 50000, m: T, yp: 0.5, n: 10, side: "yes" },                        // no exchange time: dropped
  { k: "tr", t: close - 40000, x: close - 40000, m: "KXETH15M-OTHER-00", yp: 0.5, n: 9999, side: "yes" },
];
const u = [
  { k: "tr", t: close - 30000, x: close - 30000, m: SLUG, p: 0.55, q: 2000, intent: "ORDER_INTENT_BUY_LONG" },   // Up at 0.55
  { k: "tr", t: close - 20000, x: close - 20000, m: SLUG, p: 0.80, q: 5, intent: "ORDER_INTENT_SELL_LONG" },     // Down at 0.20
];
const gz = lines => gzipSync(Buffer.from(lines.map(o => JSON.stringify(o)).join("\n") + "\n")).toString("base64");
const dir = mkdtempSync(join(tmpdir(), "bigprint-"));
const h = join(dir, "h.mjs");
writeFileSync(h, `
  const reply = (status, body, raw) => ({ ok: status < 400, status, headers: { get: () => null },
    json: async () => body, text: async () => JSON.stringify(body),
    body: raw ? new ReadableStream({ start(c) { c.enqueue(raw); c.close(); } }) : null });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/rest/v1/m15_markets")) {
      if (!u.includes("KXBTC15M") || u.includes("close_time=gt.")) return reply(200, []);
      return reply(200, [{ ticker: "${T}", close_time: "${iso(close)}", result: "yes" }]);
    }
    if (u.includes("/storage/v1/object/list/")) {
      const body = JSON.parse(init.body);
      if (body.offset > 0 || !body.prefix.endsWith("/${iso(close - 1).slice(11, 13)}/")) return reply(200, []);
      if (body.prefix.startsWith("m15/${iso(close - 1).slice(0, 10)}")) return reply(200, [{ id: "1", name: "a_box.ndjson.gz", metadata: { size: 1 } }]);
      if (body.prefix.startsWith("pmus15/${iso(close - 1).slice(0, 10)}")) return reply(200, [{ id: "2", name: "b_box.ndjson.gz", metadata: { size: 1 } }]);
      return reply(200, []);
    }
    if (u.includes("/storage/v1/object/authenticated/") && u.includes("/pmus15/")) return reply(200, null, Buffer.from(${JSON.stringify(gz(u))}, "base64"));
    if (u.includes("/storage/v1/object/authenticated/")) return reply(200, null, Buffer.from(${JSON.stringify(gz(k))}, "base64"));
    return reply(404, {});
  };
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_fake";
  process.argv.push("--days=2", "KXBTC15M");
  await import(${JSON.stringify(join(HERE, "m15-bigprint.mjs"))});
`);
let text, code = 0;
try { text = execFileSync(process.execPath, [h], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
catch (e) { code = e.status; text = String(e.stdout) + String(e.stderr); }

console.log("big prints end to end");
ok(code === 0, "runs cleanly", text);
ok(/trades read: 5 in 2 venue-windows/.test(text), "3 Kalshi + 2 .us trades on the one window; the untimed one and the other series are not counted", text);
ok(/1 dropped for no exchange time/.test(text), "and the untimed trade is counted as dropped", text);
ok(/1 duplicate Kalshi trade ids dropped/.test(text), "a Kalshi trade written twice counts once", text);
// Kalshi, the big print followed: own price 1 - 0.60 - 17c/10 = +38.30c;
// +1000ms the next YES taker paid 0.64: 1 - 0.64 - 17c/10 = +34.30c.
ok(/KXBTC15M on Kalshi[\s\S]*prints of 1,000\+\s+own price: \+38\.30c \(n1[^|]*\|\s+\+250ms: \+34\.30c[^|]*\|\s+\+1000ms: \+34\.30c/.test(text), "Kalshi: followed at its own price and at the next same-side taker's", text);
// The NO taker paid 1 - 0.70 = 0.30 and lost: in the 1-99 band with the 10-lot YES.
ok(/KXBTC15M on Kalshi[\s\S]*1-99\s+2\s+47\.0%\s+50\.0%/.test(text), "Kalshi: a NO taker paid 1 - yp (0.64 and 0.30 average 47.0%), one of the two won", text);
// .us: BUY_LONG at 0.55 is Up (YES) and won; fee 0.0695 x 10 x 0.2475 = 17.2c -> 17c half-even: 1 - 0.55 - 0.017.
ok(/KXBTC15M on Polymarket US[\s\S]*prints of 1,000\+\s+own price: \+43\.30c/.test(text), ".us: the intent decides the side and .us's own fee is charged", text);
ok(/KXBTC15M on Polymarket US[\s\S]*1-99\s+1\s+20\.0%\s+0\.0%/.test(text), ".us: SELL_LONG at 0.80 is a Down buyer who paid 0.20 and lost", text);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
