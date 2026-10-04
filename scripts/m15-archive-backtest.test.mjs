// scripts/m15-archive-backtest.mjs end to end, against a fake Storage
// archive, a fake PostgREST and a fake Kalshi /series. Pins that the
// script reads the archive's book lines on the EXCHANGE's clock, trades
// them through the shared engine, and reports what it covered — and, with
// --maker, that the same decision is replayed as a resting order against
// the final-window tape, with the numbers worked out by hand below.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pmusSlug, kalshiM15Ticker, WINDOW_MS } from "../lib/pmus15.js";

const HERE = new URL(".", import.meta.url).pathname;
let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w}\n${extra}`); } };

function run(args = ["--strategies=fav-final"], tape = [], usLines = []) {
  const dir = mkdtempSync(join(tmpdir(), "m15arch-"));
  // Settled about an hour ago, on a real 15-minute boundary, so the .us
  // slug and the Kalshi ticker for the window can be built from it.
  const close = Math.floor((Date.now() - 3600000) / WINDOW_MS) * WINDOW_MS;
  const iso = ms => new Date(ms).toISOString();
  const T = kalshiM15Ticker("btc", close), SLUG = pmusSlug("btc", close - WINDOW_MS);
  const book = (secs, b, a, extra = {}) => JSON.stringify({ k: "b", t: close - secs * 1000, m: T, b, a, bs: 50, as: 50, d: [400, 900, 1500, 400, 900, 1500], L: [[], []], x: close - secs * 1000, ...extra });
  const lines = [
    JSON.stringify({ k: "meta", t: close - 1e6 }),
    book(100, 0.70, 0.71),
    book(30, 0.90, 0.91),                                       // fav-final's window: buy YES at 0.91
    // Received after the close, but the exchange stamped it 20s before:
    // a late-recorded book is still a book from before the close.
    JSON.stringify({ k: "b", t: close + 300000, m: T, b: 0.92, a: 0.93, d: [400, 0, 0, 400, 0, 0], L: [[], []], x: close - 20000 }),
    JSON.stringify({ k: "b", t: close - 15000, m: T, b: 0.5, a: 0.51, d: [400, 0, 0, 400, 0, 0], L: [[], []] }),   // no x: dropped
    JSON.stringify({ k: "tr", t: close - 30000, m: T, yp: 0.91, n: 5 }),
    book(30, 0.10, 0.11, { m: "KXETH15M-OTHER-00" }),          // another series: ignored
    ...tape.map(o => JSON.stringify(typeof o === "function" ? o(close, T) : o)),
  ];
  const gz = gzipSync(Buffer.from(lines.join("\n") + "\n")).toString("base64");
  const usGz = gzipSync(Buffer.from(usLines.map(o => JSON.stringify(typeof o === "function" ? o(close, SLUG) : o)).join("\n") + "\n")).toString("base64");
  const h = join(dir, "h.mjs");
  writeFileSync(h, `
    const close = ${close};
    const reply = (status, body, raw) => ({ ok: status < 400, status, headers: { get: () => null },
      json: async () => body, text: async () => JSON.stringify(body),
      body: raw ? new ReadableStream({ start(c) { c.enqueue(raw); c.close(); } }) : null });
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("/series/KXBTC15M")) return reply(200, { series: { fee_multiplier: 1, fee_type: "quadratic" } });
      if (u.includes("/series/")) return reply(404, {});
      if (u.includes("/rest/v1/m15_markets")) {
        if (!u.includes("KXBTC15M")) return reply(200, []);
        if (u.includes("close_time=gt.")) return reply(200, []);
        return reply(200, [{ ticker: "${T}", close_time: "${iso(close)}", result: "yes" }]);
      }
      if (u.includes("/storage/v1/object/list/")) {
        const body = JSON.parse(init.body);
        if (body.offset > 0 || !body.prefix.endsWith("/${iso(close - 1).slice(11, 13)}/")) return reply(200, []);
        if (body.prefix.startsWith("m15/${iso(close - 1).slice(0, 10)}")) return reply(200, [{ id: "1", name: "a_box.ndjson.gz", metadata: { size: 1234 } }]);
        if (body.prefix.startsWith("pmus15/${iso(close - 1).slice(0, 10)}") && ${usLines.length > 0}) return reply(200, [{ id: "2", name: "b_box.ndjson.gz", metadata: { size: 999 } }]);
        return reply(200, []);
      }
      if (u.includes("/storage/v1/object/authenticated/") && u.includes("/pmus15/")) return reply(200, null, Buffer.from(${JSON.stringify(usGz)}, "base64"));
      if (u.includes("/storage/v1/object/authenticated/")) return reply(200, null, Buffer.from(${JSON.stringify(gz)}, "base64"));
      return reply(404, {});
    };
    process.env.SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_fake";
    process.argv.push("--days=2", ...${JSON.stringify(args)}, "KXBTC15M");
    await import(${JSON.stringify(join(HERE, "m15-archive-backtest.mjs"))});
  `);
  try { return { code: 0, text: execFileSync(process.execPath, [h], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status, text: String(e.stdout) + String(e.stderr) }; }
}

console.log("archive backtest end to end");
{
  const r = run();
  ok(r.code === 0, "runs cleanly", r.text);
  // fav-final reaches back 45s, so the line 100s out is not kept: 30s and
  // the late-received 20s one are.
  ok(/2 book lines within 45s/.test(r.text), "keeps this series' timed lines within reach, including one received late", r.text);
  ok(/1 dropped for having no exchange timestamp/.test(r.text), "and drops, and counts, the one with no exchange timestamp", r.text);
  ok(/settled markets 1, with an archived book path 1 over 1 days/.test(r.text), "reports what it covered", r.text);
  ok(/fav-final\s+1\s+1\s+100\.0%\s+0\.91/.test(r.text), "the favourite at 0.91 with 30s left is bought, through the shared engine", r.text);
}

console.log("resting orders (--maker)");
{
  // The final two minutes: 100 resting on the 0.90 bid, 50 offered at
  // 0.91. fav-final decides at 30s (YES at 0.91 as a taker); 105 contracts
  // are then sold into the bid. join waits behind 100 and gets 5; front
  // gets all 10; improve cannot (1c spread) and joins; join+take buys the
  // other 5 at 0.91 before the cutoff. YES settles.
  const tape = [
    (c, T) => ({ k: "final", t: c - 120000, x: c - 120000, m: T, close: new Date(c).toISOString() }),
    (c, T) => ({ k: "full", t: c - 120000, x: c - 120000, m: T, why: "final-window", L: [[[0.90, 100]], [[0.91, 50]]] }),
    (c, T) => ({ k: "tr", t: c - 25000, x: c - 25000, m: T, yp: 0.90, n: 105, side: "no" }),
  ];
  const r = run(["--strategies=fav-final", "--maker"], tape);
  ok(r.code === 0, "runs cleanly", r.text);
  ok(/resting-order replay: 1 windows replayed of 1 with a decision/.test(r.text), "replays the decided window", r.text);
  ok(/fee_type quadratic\); trade sides agree with the book on 100\.0% of 1 trades/.test(r.text), "reads the maker fee from the series and checks the trade sides", r.text);
  ok(/fav-final\s+taker\s+1\s+1\s+100\.0%\s+\$0\.84/.test(r.text), "taker on the same decision: 10 at 0.91, fee 0.0573 -> 6c = +$0.84", r.text);
  ok(/\s+join\s+1\s+1\s+50\.0%\s+\$0\.50/.test(r.text), "join: 5 filled at 0.90, no fee = +$0.50", r.text);
  ok(/\s+front\s+1\s+1\s+100\.0%\s+\$1\.00/.test(r.text), "front: 10 at 0.90 = +$1.00", r.text);
  ok(/\s+improve\s+1\s+1\s+50\.0%\s+\$0\.50/.test(r.text), "improve on a 1c spread joins: +$0.50", r.text);
  ok(/\s+join\+take\s+1\s+1\s+100\.0%\s+\$0\.92/.test(r.text), "join+take: 5 at 0.90 + 5 at 0.91 with a 3c fee = +$0.92", r.text);
  ok(/RESTING ORDERS, READING THEM/.test(r.text), "and says how to read it", r.text);
  const plain = run();
  ok(!/RESTING ORDERS/.test(plain.text), "without --maker nothing changes", plain.text);
}

console.log("across venues (--venues)");
{
  // Polymarket US quotes the same window 89/90 where Kalshi is 90/91: the
  // .us ask is a cent cheaper, and its 50 offered covers the 10 wanted.
  //   kalshi        10 at 0.91, Kalshi fee 6c          -> +$0.84
  //   polyus        10 at 0.90, .us fee 0.06255 -> 6c  -> +$0.94
  //   best of both  all 10 on .us (0.906 all-in < 0.916) -> +$0.94, a cent a contract saved
  // With --maker, the .us bid at 0.89 (300 ahead) is sold 310 into: join
  // fills 10 at 0.89 and is PAID 0.0125 x 10 x 0.89 x 0.11 = 1.2c -> 1c.
  const usLines = [
    (c, s) => ({ k: "mkt", t: c - 900000, m: s, kalshi: "x" }),
    (c, s) => ({ k: "pb", t: c - 100000, x: c - 100000, m: s, b: [[0.69, 100]], a: [[0.70, 100]] }),
    (c, s) => ({ k: "pb", t: c - 30000, x: c - 30000, m: s, b: [[0.89, 300]], a: [[0.90, 50]] }),
    (c, s) => ({ k: "tr", t: c - 25000, x: c - 25000, m: s, p: 0.89, q: 310, side: "ORDER_SIDE_SELL", intent: "ORDER_INTENT_SELL_LONG" }),
  ];
  const r = run(["--strategies=fav-final", "--venues"], [], usLines);
  ok(r.code === 0, "runs cleanly", r.text);
  ok(/polymarket us: 1 hourly files .* 1 settled windows with a \.us book path/.test(r.text), "reads the .us archive into book paths", r.text);
  ok(/ACROSS VENUES .* on the 1 windows of 1/.test(r.text), "compares on windows both venues covered", r.text);
  ok(/fav-final\s+kalshi\s+1\s+100\.0%\s+0\.91\s+\$0\.84/.test(r.text), "Kalshi: 10 at 0.91 = +$0.84", r.text);
  ok(/\s+polyus\s+1\s+100\.0%\s+0\.90\s+\$0\.94/.test(r.text), "Polymarket US: the same rule on its own book, 10 at 0.90 with its fee = +$0.94", r.text);
  ok(/\s+best of both\s+1\s+100\.0%\s+0\.90\s+\$0\.94/.test(r.text), "best of both buys all 10 on .us", r.text);
  ok(/\.us cheaper all-in at 1 of 1 decisions; 10 of 10 contracts bought there; \+1\.00c a contract/.test(r.text), "and says how often and by how much .us was cheaper", r.text);
  const mk = run(["--strategies=fav-final", "--venues", "--maker"], [], usLines);
  ok(mk.code === 0, "with --maker: runs cleanly", mk.text);
  ok(/RESTING ORDERS ON POLYMARKET US/.test(mk.text) && /trade sides agree with the book on 100\.0% of 1 trades/.test(mk.text), "replays the .us tape and checks its trade sides", mk.text);
  ok(/\s+join\s+1\s+1\s+\$1\.11\s+\+11\.10c/.test(mk.text), "join: 10 at 0.89, paid a 1c rebate = +$1.11", mk.text);
  const none = run(["--strategies=fav-final", "--venues"], [], []);
  ok(none.code === 0 && !/ACROSS VENUES/.test(none.text), "no .us archive: nothing to compare, nothing printed", none.text);
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
