// lib/m15Index.js worked by hand, and scripts/m15-index.mjs end to end
// against a fake archive with one window whose every number is known.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secondPrices, settleAvg, estimateAvg, bucketOf, bucketLabel, buyPrice, dayStats } from "../lib/m15Index.js";
import { kalshiM15Ticker, WINDOW_MS } from "../lib/pmus15.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const near = (a, b, e = 1e-9) => a != null && Math.abs(a - b) < e;

console.log("the settlement average");
{
  // Close at 100,000ms. Second k of the final minute (ending at 40,000 + 1000k)
  // is priced at 1000 + k: the last 5Hz tick of that second.
  const close = 100000, ticks = [];
  for (let t = 30000; t <= close; t += 200) { const k = Math.ceil((t - 40000) / 1000); ticks.push({ t, v: 1000 + Math.max(0, Math.min(60, k)) }); }
  const p = secondPrices(ticks, close);
  ok(p && p.length === 60 && p[0] === 1001 && p[59] === 1060, "60 prices, one per second, each the second's last tick", JSON.stringify(p?.slice(0, 3)));
  ok(near(settleAvg(ticks, close), 1030.5), "average of 1001..1060 is 1030.5", settleAvg(ticks, close));
  // 30s out: seconds 1..30 known (1001..1030, mean 1015.5), spot 1030 for the rest.
  const e = estimateAvg(ticks, close, 30);
  ok(e && e.known === 30 && near(e.est, (30 * 1015.5 + 30 * 1030) / 60), "30s out: known seconds plus the latest price for the rest", JSON.stringify(e));
  ok(estimateAvg(ticks, close, 61) === null && estimateAvg(ticks, close, 0) === null, "only inside the averaging minute");
  const holed = ticks.filter(k => k.t < 60000 || k.t > 63000);
  ok(settleAvg(holed, close) === null, "a 3s hole in the record: no average, not a guess");
  ok(estimateAvg(holed, close, 20) === null && estimateAvg(holed, close, 50) !== null, "the hole spoils estimates that need it, not earlier ones");
}

console.log("buckets, prices, days");
{
  const E = [0, 10, 25];
  ok(bucketOf(0, E) === 0 && bucketOf(9.99, E) === 0 && bucketOf(10, E) === 1 && bucketOf(400, E) === 2 && bucketOf(-1, E) === -1, "bucket edges: lower inclusive, last open-ended");
  ok(bucketLabel(E, 1) === "$10-25" && bucketLabel(E, 2) === "$25+", "bucket labels");
  ok(buyPrice({ bid: 0.3, ask: 0.33 }, "yes") === 0.33 && buyPrice({ bid: 0.3, ask: 0.33 }, "no") === 0.7, "YES at the ask, NO at 1 - bid");
  const S = dayStats([{ day: "2026-10-01", pnl: 1, ctrs: 10 }, { day: "2026-10-02", pnl: 3, ctrs: 10 }, { day: "2026-10-03", pnl: 2, ctrs: 20 }, { day: "2026-10-04", pnl: -2, ctrs: 10 }]);
  // daily 1,3,2,-2: mean 1, sd sqrt(14/3), t = 1/(sd/2)
  ok(S.n === 4 && S.ctrs === 50 && near(S.pnl, 4) && near(S.perCtr, 0.08) && near(S.t, 2 / Math.sqrt(14 / 3)) && near(S.earlyPerCtr, 0.2) && near(S.latePerCtr, 0), "totals, per contract, t across days, halves", JSON.stringify(S));
}

// Run the script against a fake Supabase holding one archive hour.
function runIndex(T, close, lines, args = ["--days=1", "--size=10,30,200", "--list"]) {
  const iso = ms => new Date(ms).toISOString();
  const gz = gzipSync(Buffer.from(lines.map(o => JSON.stringify(o)).join("\n") + "\n")).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "m15index-")), h = join(dir, "h.mjs");
  writeFileSync(h, `
    const reply = (status, body, raw) => ({ ok: status < 400, status, headers: { get: () => null },
      json: async () => body, text: async () => JSON.stringify(body),
      body: raw ? new ReadableStream({ start(c) { c.enqueue(raw); c.close(); } }) : null });
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("/series/")) return reply(404, {});
      if (u.includes("/rest/v1/m15_markets")) return reply(200, u.includes("close_time=gt.") ? [] : [{ ticker: "${T}", close_time: "${iso(close)}", result: "yes", strike: 100000 }]);
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
    process.argv.push(...${JSON.stringify(args)});
    await import(${JSON.stringify(join(new URL(".", import.meta.url).pathname, "m15-index.mjs"))});
  `);
  let text, code = 0;
  try { text = execFileSync(process.execPath, [h], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { code = e.status; text = String(e.stdout) + String(e.stderr); }
  return { text, code };
}

console.log("m15-index.mjs end to end");
{
  // One window, strike 100,000. BRTI flat at 100,000, then +$30 (3bp) at 90s
  // out and flat after: the close averages 100,030 -> YES, as settled.
  // Book 49/51 until 89.8s out, then 60/62. Once-a-second rows add 80/82 at
  // 60s out and 85/87 at 30s and 10s out.
  const close = Math.floor((Date.now() - 3600000) / WINDOW_MS) * WINDOW_MS;
  const iso = ms => new Date(ms).toISOString();
  const T = kalshiM15Ticker("btc", close);
  const lines = [];
  for (let x = close - 976000; x <= close; x += 200) lines.push({ k: "i5", t: x + 40, id: "BRTI", v: x < close - 90000 ? "100000.00" : "100030.00", x });
  const b = (s, bid, ask) => ({ k: "b", t: close - s * 1000 + 30, m: T, b: bid, a: ask, d: [500, 0, 0, 500, 0, 0], L: [[], []], x: close - s * 1000 });
  lines.push(b(300, 0.49, 0.51), b(120, 0.49, 0.51), b(60, 0.80, 0.82), b(30, 0.85, 0.87), b(10, 0.85, 0.87));
  lines.push({ k: "final", t: close - 120000, x: close - 120000, m: T },
    { k: "full", t: close - 119950, x: close - 120000, m: T, L: [[[0.49, 100]], [[0.51, 100]]] },
    { k: "full", t: close - 89750, x: close - 89800, m: T, L: [[[0.60, 100]], [[0.62, 100]]] });
  lines.sort((a, z) => a.t - z.t);
  const { text, code } = runIndex(T, close, lines);
  ok(code === 0, "runs", text);
  ok(/1 of 1 windows rebuilt; the rebuilt close lands on Kalshi's settled side in 1 \(100\.0%\)/.test(text), "A: the rebuilt close is on the settled side", text);
  ok(/\|rebuilt - Kalshi strike\| median \$0\.00/.test(text), "A: the rebuilt opening average is the strike", text);
  const sec = (from, to) => text.split(from)[1].split(to)[0];
  // B, 5 min out: d = 0 -> YES at 0.51, won: +49c less the fee.
  const b5 = sec("5 min before the close", "2 min before");
  ok(/\$0-10\s+1\s+100\.0%\s+51\.0%/.test(b5), "B 5 min: $0 ahead, YES priced 51%, won", b5);
  // 1 min out: $30 ahead -> the $25-50 bucket, YES at 0.82.
  const b1 = sec("1 min before the close", "C. THE SETTLEMENT");
  ok(/\$25-50\s+1\s+100\.0%\s+82\.0%/.test(b1), "B 1 min: $30 ahead, YES priced 82%", b1);
  // C 30s out: every known second is after the jump: estimate 100,030, err 0.
  const c30 = sec("30s before the close", "20s before the close");
  ok(/1 windows, \|err\| median \$0\.00/.test(c30) && /\$25-50\s+1\s+100\.0%\s+87\.0%/.test(c30), "C 30s: estimate exact, $30 from the strike, YES priced 87%", c30);
  // B2: 120s out BRTI is at the strike and the close averages +$30; from
  // 60s out on it is already at 100,030, so the average does not move.
  const b2 = sec("B2. HOW FAR", "C. THE SETTLEMENT");
  ok(/120s out: 1 windows\. \|move\| median \$30\.00/.test(b2) && /60s out: 1 windows\. \|move\| median \$0\.00/.test(b2), "B2: the move from 120s and 60s out", b2);
  ok(/60s out[\s\S]*largest lead that still lost: none[\s\S]*\$30-40\s+1\s+0\s+0\.0%\s+82\.0%/.test(b2), "B2 60s: a $30 lead, kept, YES asked at 82%", b2);
  // B3: 5 min out BRTI is at the strike after a flat 5 minutes (range $0):
  // YES leads by $0, asked at 0.51, and won. No book 10 min out, so none there.
  const b3 = sec("B3. THE LEADER", "B2. HOW FAR");
  ok(/10 min before the close: 0 windows/.test(b3), "B3 10 min: no book recorded, no windows", b3);
  const b35 = b3.split("5 min before the close")[1] || "";
  ok(/1 windows; prior-5-min range terciles cut at \$0 and \$0/.test(b35) && /\$0-25\s+1\s+100\.0%\s+51\.0%/.test(b35), "B3 5 min: a $0 lead on a flat window, YES at 51%", b35);
  ok(/-- quiet third[\s\S]*\$0-50\s+1\s+100\.0%/.test(b35) && /Kalshi's favourite at 75-95c \(bought at its ask\): 0 windows/.test(b35), "B3: the quiet third holds it; a 51c favourite is not 75-95c", b35);
  ok(/600s out: 1 windows\. \|move\| median \$30\.00/.test(b2), "B2 now measures 10 min out too", b2);
  // D: the 3bp move fires 1bp and 2bp, not 4bp. +100ms: the 49/51 book is
  // still there: 10 at 0.51 at either limit. +250ms: 60/62, so neither fills.
  const d = text.split("D. BUY THE SIDE")[1].split("30 contracts")[0];
  // 30 and 200: the same decision. 100 offered at 0.51, so 30 fills in full and 200 takes the 100 there.
  const d30 = text.split("   30 contracts")[1].split("200 contracts")[0], d200 = text.split("   200 contracts")[1];
  ok(/1bp\s+\+100ms\s+seen\s+1\s+100\.0%\s+30\s+100\.0%/.test(d30), "D at 30: all 30 at 0.51", d30);
  ok(/1bp\s+\+100ms\s+seen\s+1\s+100\.0%\s+100\s+50\.0%/.test(d200), "D at 200: only the 100 offered within the limit, half the size asked", d200);
  ok(/1bp\s+\+100ms\s+seen\s+1\s+100\.0%\s+10\s+100\.0%\s+100\.0%\s+0\.510\s+\+\$\s*4\.73\s+\+47\.25c/.test(d), "D 1bp +100ms: 10 at 0.51, won, +$4.73 after a $0.1750 fee", d);
  ok(/1bp\s+\+250ms\s+seen\s+1\s+0\.0%\s+0/.test(d) && /1bp\s+\+250ms\s+\+1c\s+1\s+0\.0%\s+0/.test(d), "D +250ms: the book moved to 60/62, so no fill at 0.51 or 0.52", d);
  ok(/2bp\s+\+100ms\s+seen\s+1\s+100\.0%/.test(d) && /4bp\s+\+100ms\s+seen\s+0\s/.test(d), "D: a 3bp move is a 2bp event and not a 4bp one", d);
  // D2: that decision, seen 0.51 at mid 0.50, unfilled at +250ms, lands in
  // the 0.30-0.60 and 0.5-0.6 rows only, and every narrower band's own
  // decider takes the same event.
  const d2 = sec("D2. 1bp DECISIONS BY PRICE", "EVERY 1bp DECISION");
  ok(/0\.30-0\.60\s+1\s+[\d.]+\s+0\s/.test(d2) && /<= 0\.30\s+0\s/.test(d2) && /> 0\.60\s+0\s/.test(d2) && /0\.5-0\.6\s+1\s/.test(d2) && /0\.4-0\.5\s+0\s/.test(d2),
    "D2: bucketed by the price seen for the side bought (0.51 -> 0.30-0.60, 0.5-0.6)", d2);
  ok(["0.15-0.85", "0.20-0.80", "0.25-0.75", "0.30-0.70", "0.35-0.65"].every(b => new RegExp(String.raw`mid ${b.replace(/\./g, "\\.")}\s+1\s`).test(d2)), "D2: each mid band's own decider takes the mid-0.50 event", d2);
  // --list: the one 1bp decision, 90s out, YES seen 0.51; at +250ms the book is 60/62, so nothing filled.
  const list = text.split("EVERY 1bp DECISION")[1] || "";
  ok(new RegExp(`${T}\\s+${new Date(close - 90000).toISOString().replace(/\./g, "\\.")}\\s+90\\.0\\s+3\\.00\\s+0\\.49/0\\.51\\s+yes\\s+0\\.510\\s+0\\s+—\\s+yes\\s+\\+0\\.00`).test(list), "--list: the decision, its tick time, book, side and fill", list);
}

console.log("m15-index.mjs D3: the position managed at 15s out");
{
  // As above, but the 49/51 book stands until 20s out, so the 1bp decision
  // fills 10 YES at 0.51 (+250ms, limit 0.52; fee 0.1750). At 20s out the
  // book drops to 20/22: YES is the underdog at 15s, so D3 sells all 10 by
  // buying NO at 0.80 (limit 0.81; fee 0.07 x 10 x .8 x .2 = 0.112). YES
  // still settles: held +4.725, sold 4.725 - 8.112 = -3.387.
  const close = Math.floor((Date.now() - 3600000) / WINDOW_MS) * WINDOW_MS;
  const T = kalshiM15Ticker("btc", close);
  const lines = [];
  for (let x = close - 976000; x <= close; x += 200) lines.push({ k: "i5", t: x + 40, id: "BRTI", v: x < close - 90000 ? "100000.00" : "100030.00", x });
  lines.push({ k: "final", t: close - 120000, x: close - 120000, m: T },
    { k: "full", t: close - 119950, x: close - 120000, m: T, L: [[[0.49, 100]], [[0.51, 100]]] },
    { k: "full", t: close - 19950, x: close - 20000, m: T, L: [[[0.20, 100]], [[0.22, 100]]] });
  lines.sort((a, z) => a.t - z.t);
  const { text, code } = runIndex(T, close, lines, ["--days=1", "--size=10"]);
  ok(code === 0, "runs", text);
  const d3 = (text.split("D3. MANAGE THE POSITION")[1] || "").split("READING THIS")[0];
  ok(/1 filled positions; at 15s out: sell 1/.test(d3), "the position is sold at 15s out", d3);
  ok(/hold \(as live\)\s+1\s+\+\$\s*4\.73\s+\+47\.25c/.test(d3), "held: +$4.73", d3);
  ok(/sell the underdog only\s+1\s+-\$\s*3\.39\s+-33\.87c/.test(d3), "sold: 10 pairs for $1 each, -$3.39", d3);
  ok(/add to the favourite only\s+1\s+\+\$\s*4\.73/.test(d3), "never added", d3);
  ok(/sell: 1 triggered, 1 filled \(10 contracts\); our side's bid averaged 0\.200 and it went on to win 100\.0%/.test(d3), "the sale's own line", d3);
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
