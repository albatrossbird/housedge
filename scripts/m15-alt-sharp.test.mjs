// lib/tapeBook.js by hand, and scripts/m15-alt-sharp.mjs end to end against
// a fake Kalshi and a fake archive with one window whose numbers are known.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tapeBook } from "../lib/tapeBook.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };

console.log("tapeBook");
{
  const tr = [{ t: 1000, side: "yes", price: 0.50, count: 3 }, { t: 2000, side: "no", price: 0.52, count: 2 }, { t: 9000, side: "yes", price: 0.55, count: 7 }, { t: 9400, side: "yes", price: 0.60, count: 1 }];
  const b = tapeBook(tr, { staleMs: 5000 });
  const q = b.at(3000);
  ok(q.ask === 0.5 && q.bid === 0.48, "a YES buy is the ask, a NO buy the mirrored bid", JSON.stringify(q));
  ok(b.at(7500).bid === null && b.at(7500).ask === null, "older than 5s: unknown", JSON.stringify(b.at(7500)));
  ok(b.at(500).ask === null, "nothing printed yet: unknown");
  const f = b.fill(8700, "yes", 0.56);
  ok(f.filled === true && f.price === 0.55 && f.count === 7, "the first print of our side after +250ms, at or under the limit, fills at its price", JSON.stringify(f));
  ok(b.fill(8800, "yes", 0.54).filled === false, "the first print over the limit is a miss — a later cheaper one does not rescue it");
  ok(b.fill(8800, "yes", 0.59).filled === false, "a print one cent over the limit is a miss");
  ok(b.fill(8700, "no", 0.60).filled === null, "no print of our side in the window: unknown, not a miss");
  ok(b.fill(8800, "yes", 0.70).price === 0.60, "a print inside the first 250ms does not count", JSON.stringify(b.fill(8800, "yes", 0.70)));
  ok(b.fill(6000, "yes", 0.70).filled === null, "prints past +2.25s are outside the window");
}

console.log("m15-alt-sharp.mjs end to end");
{
  // One KXETH15M window, strike 3000. ETHUSD_RTI flat at 3000, then 3001
  // (+3.3bp) from 90s out: the close averages 3001 -> YES, as settled.
  // Tape: YES bought every second at 0.50 until 90s out and at 0.51 after;
  // NO bought every second at 0.52 (a YES bid of 0.48).
  const close = Math.floor((Date.now() - 3600000) / 900000) * 900000;
  const iso = ms => new Date(ms).toISOString();
  const T = "KXETH15M-TEST";
  const lines = [];
  for (let t = close - 140000; t <= close; t += 200) lines.push({ k: "i5", t, id: "ETHUSD_RTI", v: String(t >= close - 90000 ? 3001 : 3000), x: t });
  // A different coin's index, which must not be picked.
  for (let t = close - 140000; t <= close; t += 200) lines.push({ k: "i5", t, id: "SOLUSD_RTI", v: "150", x: t });
  const trades = [];
  for (let s = 130; s >= 1; s--) {
    const t = close - s * 1000 + 500;
    trades.push({ created_time: iso(t), taker_side: "yes", yes_price_dollars: s > 90 ? "0.5000" : "0.5100", no_price_dollars: "0.4900", count_fp: "20.00" });
    trades.push({ created_time: iso(t + 100), taker_side: "no", yes_price_dollars: "0.4800", no_price_dollars: "0.5200", count_fp: "5.00" });
  }
  const gz = gzipSync(Buffer.from(lines.map(o => JSON.stringify(o)).join("\n") + "\n")).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "altsharp-")), h = join(dir, "h.mjs");
  writeFileSync(h, `
    const reply = (status, body, raw) => ({ ok: status < 400, status, headers: { get: () => null },
      json: async () => body, text: async () => JSON.stringify(body),
      body: raw ? new ReadableStream({ start(c) { c.enqueue(raw); c.close(); } }) : null });
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("/historical/cutoff")) return reply(200, { market_settled_ts: "2026-09-02T00:00:00Z", trades_created_ts: "2026-09-02T00:00:00Z" });
      if (u.includes("/series/")) return reply(404, {});
      if (u.includes("/markets/trades")) return reply(200, { trades: ${JSON.stringify(trades)}.reverse(), cursor: "" });
      if (u.includes("/markets?series_ticker=KXETH15M")) return reply(200, { markets: [{ ticker: "${T}", close_time: "${iso(close)}", result: "yes", floor_strike: 3000 }], cursor: "" });
      if (u.includes("/storage/v1/object/list/")) {
        const body = JSON.parse(init.body);
        if (body.offset > 0 || body.prefix !== "m15/${iso(close - 1).slice(0, 10)}/${iso(close - 1).slice(11, 13)}/") return reply(200, []);
        return reply(200, [{ id: "1", name: "a_box.ndjson.gz", metadata: { size: 1234 } }]);
      }
      if (u.includes("/storage/v1/object/authenticated/")) return reply(200, null, Buffer.from(${JSON.stringify(gz)}, "base64"));
      return reply(404, {});
    };
    process.env.SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_fake";
    process.argv.push("--series=KXETH15M", "--since=${iso(close - 86400000).slice(0, 10)}", "--pace=0", "--conc=1");
    await import(${JSON.stringify(join(new URL(".", import.meta.url).pathname, "m15-alt-sharp.mjs"))});
  `);
  let text, code = 0;
  try { text = execFileSync(process.execPath, [h], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { code = e.status; text = String(e.stdout) + String(e.stderr); }
  ok(code === 0, "runs", text.slice(-1500));
  ok(/KXETH15M\s+ETHUSD_RTI\s+1 windows rebuilt, 1 on Kalshi's side/.test(text), "the ETH index is found and rebuilds the settled side", text.match(/A\. CHECK[\s\S]*?\n\n/)?.[0]);
  ok(!/KXETH15M\s+SOLUSD_RTI/.test(text), "another coin's index is never a candidate");
  // The move at 90s out: ask 0.50 (last YES print), bid 0.48, mid 0.49 ->
  // buy YES, seen 0.50, limit 0.51. The next YES print (89.5s out, 0.51)
  // fills. 10 x (1 - 0.51) - fee ceil(0.07 x 10 x .51 x .49) = 4.90 - 0.1750.
  ok(/KXETH15M\s+1bp\s+1\s+1\s+0\s+0\s+100\.0%\s+—\s+0\.510\s+\+47\.25c/.test(text), "1bp: one order, filled at the next print, +47.25c a contract", text.match(/D\. BUY[\s\S]*?Passed/)?.[0]);
  ok(/KXETH15M\s+4bp\s+0/.test(text), "a 3.3bp move is not a 4bp event");
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
