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
    JSON.stringify({ k: "b", t: close - 10000, m: T, b: 0.99, a: null, d: [400, 0, 0, 0, 0, 0], L: [[], []], x: close - 10000 }),   // decided: one-sided
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
  ok(/1 dropped for having no exchange timestamp, 1 one-sided books/.test(r.text), "and drops, and counts apart, the one with no exchange timestamp and the one-sided one", r.text);
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
  ok(/final-window replay: 1 windows replayed of 1 with a decision/.test(r.text), "replays the decided window", r.text);
  ok(/fee_type quadratic\); trade sides agree with the book on 100\.0% of 1 trades/.test(r.text), "reads the maker fee from the series and checks the trade sides", r.text);
  ok(/fav-final\s+taker\s+1\s+1\s+100\.0%\s+\$0\.84/.test(r.text), "taker on the same decision: 10 at 0.91, fee 0.05733 -> 0.0574 = +$0.8426", r.text);
  ok(/\s+join\s+1\s+1\s+50\.0%\s+\$0\.50/.test(r.text), "join: 5 filled at 0.90, no fee = +$0.50", r.text);
  ok(/\s+front\s+1\s+1\s+100\.0%\s+\$1\.00/.test(r.text), "front: 10 at 0.90 = +$1.00", r.text);
  ok(/\s+improve\s+1\s+1\s+50\.0%\s+\$0\.50/.test(r.text), "improve on a 1c spread joins: +$0.50", r.text);
  ok(/\s+join\+take\s+1\s+1\s+100\.0%\s+\$0\.92/.test(r.text), "join+take: 5 at 0.90 + 5 at 0.91 with a 2.87c fee = +$0.9213", r.text);
  ok(/RESTING ORDERS, READING THEM/.test(r.text), "and says how to read it", r.text);
  const plain = run();
  ok(!/RESTING ORDERS/.test(plain.text), "without --maker nothing changes", plain.text);
}

console.log("across venues (--venues)");
{
  // Polymarket US quotes the same window 89/90 where Kalshi is 90/91: the
  // .us ask is a cent cheaper, and its 50 offered covers the 10 wanted.
  //   kalshi        10 at 0.91, Kalshi fee 5.74c       -> +$0.8426
  //   polyus        10 at 0.90, .us fee 0.06255 -> 6c  -> +$0.94
  //   best of both  all 10 on .us (0.906 all-in < 0.91574) -> +$0.94, 0.97c a contract saved
  // With --maker, the .us bid at 0.89 (300 ahead) is sold 310 into: join
  // fills 10 at 0.89 and is PAID 0.0125 x 10 x 0.89 x 0.11 = 1.2c -> 1c —
  // before 2026-10-19 17:00 UTC; from then a Tier 1 account is paid nothing.
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
  ok(/\.us cheaper all-in at 1 of 1 decisions; 10 of 10 contracts bought there; \+0\.97c a contract/.test(r.text), "and says how often and by how much .us was cheaper: (9.10 + 0.0574) - (9.00 + 0.06) over 10", r.text);
  const mk = run(["--strategies=fav-final", "--venues", "--maker"], [], usLines);
  ok(mk.code === 0, "with --maker: runs cleanly", mk.text);
  ok(/RESTING ORDERS ON POLYMARKET US/.test(mk.text) && /trade sides agree with the book on 100\.0% of 1 trades/.test(mk.text), "replays the .us tape and checks its trade sides", mk.text);
  const rebated = Math.floor((Date.now() - 3600000) / WINDOW_MS) * WINDOW_MS < Date.parse("2026-10-19T17:00:00Z"); // run()'s close
  const joinRow = rebated ? /\s+join\s+1\s+1\s+\$1\.11\s+\+11\.10c/ : /\s+join\s+1\s+1\s+\$1\.10\s+\+11\.00c/;
  ok(joinRow.test(mk.text), rebated ? "join: 10 at 0.89, paid a 1c rebate = +$1.11" : "join: 10 at 0.89, no rebate after the change = +$1.10", mk.text);
  // The delay test. Kalshi's final two minutes are on the tape (90/91,
  // unchanged); the .us offer at 0.90 is gone 60ms after the decision.
  //   Kalshi alone   fills at every delay: +$0.84
  //   best of both   +0 and +50ms: all 10 on .us = +$0.94; from +100ms the
  //                  .us leg finds nothing: 0%
  //   + rest on Kalshi  from +100ms buys the 10 on Kalshi at 0.91 = +$0.84
  const kTape = [
    (c, T) => ({ k: "final", t: c - 120000, x: c - 120000, m: T, close: new Date(c).toISOString() }),
    (c, T) => ({ k: "full", t: c - 120000, x: c - 120000, m: T, why: "final-window", L: [[[0.90, 100]], [[0.91, 50]]] }),
  ];
  const usMoved = [...usLines, (c, s) => ({ k: "pb", t: c - 29940, x: c - 29940, m: s, b: [[0.91, 100]], a: [[0.92, 50]] })];
  const dl = run(["--strategies=fav-final", "--venues"], kTape, usMoved);
  ok(dl.code === 0 && /DELAY — the same decisions/.test(dl.text), "prints the delay table", dl.text);
  ok(/fav-final \(1\)\s+\+0ms\s+100\.0%\s+\+8\.43c\s+\$0\.84\s+100\.0%\s+—\s+\+9\.40c\s+\$0\.94\s+\+9\.40c\s+\$0\.94/.test(dl.text), "+0ms: everything fills as priced", dl.text);
  ok(/\+50ms\s+100\.0%\s+\+8\.43c\s+\$0\.84\s+100\.0%\s+—\s+\+9\.40c\s+\$0\.94/.test(dl.text), "+50ms: the .us offer is still there", dl.text);
  ok(/\+100ms\s+100\.0%\s+\+8\.43c\s+\$0\.84\s+0\.0%\s+—\s+—\s+\$0\.00\s+\+8\.43c\s+\$0\.84/.test(dl.text), "+100ms: the .us leg misses; the fallback buys on Kalshi", dl.text);
  ok(/\+1000ms\s+100\.0%/.test(dl.text), "through +1000ms", dl.text);
  const none = run(["--strategies=fav-final", "--venues"], [], []);
  ok(none.code === 0 && !/ACROSS VENUES/.test(none.text), "no .us archive: nothing to compare, nothing printed", none.text);
}

console.log("pre-placed resting orders (--preplace)");
{
  // The final two minutes: 100 resting on the 0.90 bid, 50 offered at
  // 0.91. A book change at 59s (a lower bid level appears) is the first
  // after 60s out, so a pre-placed YES bid goes up at 0.90 then. 105 are
  // sold into 0.90 at 50s out — BEFORE the rule fires at 30s.
  //   taker at the rule     10 at 0.91, fee 5.74c                -> +$0.8426
  //   resting at the rule   posted at 30s, after the selling: nothing
  //   from 60s, back        behind 100: 5 at 0.90, no fee        -> +$0.50
  //   from 60s, front       10 at 0.90                           -> +$1.00
  //   1c below (0.89)       the selling stops at 0.90: nothing
  const tape = [
    (c, T) => ({ k: "final", t: c - 120000, x: c - 120000, m: T, close: new Date(c).toISOString() }),
    (c, T) => ({ k: "full", t: c - 120000, x: c - 120000, m: T, why: "final-window", L: [[[0.90, 100]], [[0.91, 50]]] }),
    (c, T) => ({ k: "d", t: c - 59000, x: c - 59000, m: T, sd: "b", p: 0.89, q: 10 }),
    (c, T) => ({ k: "tr", t: c - 50000, x: c - 50000, m: T, yp: 0.90, n: 105, side: "no" }),
  ];
  const r = run(["--strategies=fav-final", "--preplace"], tape);
  const row = name => (r.text.split("\n").find(l => l.startsWith(name)) || "");
  ok(r.code === 0, "runs cleanly", r.text);
  ok(/1 windows replayed change by change/.test(r.text) && /KXBTC15M · fav-final — 1 windows over 1 days; the rule fired in 1/.test(r.text), "replays every settled window and says where the rule fired", r.text);
  ok(/^taker, at the rule\s+1\s+1\s+10\s+100\.0% \/ —\s+\+\$0\.84\s+\+8\.43c/.test(row("taker, at the rule")), "taker: 10 at 0.91 = +$0.84", row("taker, at the rule"));
  ok(/\s+1\s+0\s+0\s+— \/ 100\.0%\s+\+\$0\.00/.test(row("resting at the rule, back")), "resting at the rule: posted after the selling, never filled", row("resting at the rule, back"));
  ok(/\s+1\s+1\s+5\s+100\.0% \/ —\s+\+\$0\.50\s+\+10\.00c/.test(row("from 60s, back ")), "from 60s, back: 5 at 0.90 behind the 100 = +$0.50", row("from 60s, back "));
  ok(/\s+1\s+1\s+10\s+100\.0% \/ —\s+\+\$1\.00\s+\+10\.00c/.test(row("from 60s, front")), "from 60s, front: 10 at 0.90 = +$1.00", row("from 60s, front"));
  ok(/\s+1\s+0\s+0\s+— \/ 100\.0%\s+\+\$0\.00/.test(row("from 60s, 1c below, front")), "a cent below: the selling never reaches 0.89", row("from 60s, 1c below, front"));
  ok(/READING THE PRE-PLACED TABLE/.test(r.text), "and says how to read it", r.text);
  const plain = run(["--strategies=fav-final"]);
  ok(!/PRE-PLACED/.test(plain.text), "without --preplace nothing changes", plain.text);
  const dog = run(["--strategies=dog-late", "--preplace"], tape);
  ok(dog.code === 2 && /needs a hold-to-settlement favourite rule/.test(dog.text), "refuses a rule set with no favourite rule to pre-place", dog.text);
}

console.log("every book change (--per-change)");
{
  // The final two minutes: 0.80/0.85 (spread too wide for fav-final) until
  // a 20-lot offer at 0.82 flickers in 40s out and is gone 50ms later; then
  // 0.90/0.91 from 30s, which is what the once-a-second line shows.
  //   once a second  YES 10 at 0.91 from 30s; fills at every delay: 10 - 9.10 - 5.74c = +$0.8426
  //   every change   YES 10 at 0.82 from 40s; +0ms fills: 10 - 8.20 - 10.34c (10.332c up) = +$1.6966
  //                  +50ms the offer is gone: nothing at 0.82 or better, a miss
  const tape = [
    (c, T) => ({ k: "final", t: c - 120000, x: c - 120000, m: T, close: new Date(c).toISOString() }),
    (c, T) => ({ k: "full", t: c - 120000, x: c - 120000, m: T, why: "final-window", L: [[[0.80, 100]], [[0.85, 100]]] }),
    (c, T) => ({ k: "d", t: c - 40000, x: c - 40000, m: T, sd: "a", p: 0.82, q: 20 }),
    (c, T) => ({ k: "d", t: c - 39950, x: c - 39950, m: T, sd: "a", p: 0.82, q: -20 }),
    (c, T) => ({ k: "full", t: c - 30000, x: c - 30000, m: T, L: [[[0.90, 100]], [[0.91, 50]]] }),
  ];
  const r = run(["--strategies=fav-final", "--per-change"], tape);
  ok(r.code === 0, "runs cleanly", r.text);
  ok(/1 windows replayed change by change/.test(r.text), "replays the window", r.text);
  ok(/decided once a second: 1 \| on every change: 1 \| both: 1 \(same side 1\) \| only on a change: 0/.test(r.text), "both ways decide", r.text);
  ok(/came earlier by \(s\) median 10\.00/.test(r.text), "the change-by-change decision is the flicker, 10s earlier", r.text);
  ok(/ONCE A SECOND[^\n]*\n[^\n]*\n\s+\+0ms\s+1\s+10\/10 100\.0%\s+100\.0% \/ —\s+\+\$0\.84\s+\+8\.43c/.test(r.text), "once a second: 10 at 0.91 = +$0.8426", r.text);
  ok(/EVERY BOOK CHANGE\n[^\n]*\n\s+\+0ms\s+1\s+10\/10 100\.0%\s+100\.0% \/ —\s+\+\$1\.70/.test(r.text), "every change, on the book it decided on: 10 at 0.82 = +$1.6966", r.text);
  ok(/EVERY BOOK CHANGE\n[^\n]*\n[^\n]*\n\s+\+50ms\s+1\s+0\/10 0\.0%\s+— \/ 100\.0%\s+\+\$0\.00/.test(r.text), "50ms later the flicker is gone: a miss, on a window that won", r.text);
  ok(/READING THE PER-CHANGE TABLE/.test(r.text), "and says how to read it", r.text);
}

console.log("both venues at once (--per-change --venues, several sizes)");
{
  // Kalshi as in the per-change test above. Polymarket US quotes 0.89/0.90
  // with 50 offered from 40s out, so both of its paths buy YES at 0.90.
  //   10:  .us 10 at 0.90, fee 6.255c -> 6c half-even: +$0.94
  //        Kalshi every change +$1.6966 at +0ms, a miss at +50ms -> both +$2.64, then +$0.94
  //   200: .us min(200, 50 within 1c) = 50 at 0.90, fee 31.275c -> 31c: +$4.69
  //        Kalshi once a second: 200 wanted, 50 offered at 0.91 -> 50 - 45.50 - 28.67c = +$4.2133
  //        -> both +$8.90 at +100ms
  const tape = [
    (c, T) => ({ k: "final", t: c - 120000, x: c - 120000, m: T, close: new Date(c).toISOString() }),
    (c, T) => ({ k: "full", t: c - 120000, x: c - 120000, m: T, why: "final-window", L: [[[0.80, 100]], [[0.85, 100]]] }),
    (c, T) => ({ k: "d", t: c - 40000, x: c - 40000, m: T, sd: "a", p: 0.82, q: 20 }),
    (c, T) => ({ k: "d", t: c - 39950, x: c - 39950, m: T, sd: "a", p: 0.82, q: -20 }),
    (c, T) => ({ k: "full", t: c - 30000, x: c - 30000, m: T, L: [[[0.90, 100]], [[0.91, 50]]] }),
  ];
  const usLines = [
    (c, s) => ({ k: "pb", t: c - 100000, x: c - 100000, m: s, b: [[0.69, 100]], a: [[0.70, 100]] }),
    (c, s) => ({ k: "pb", t: c - 40000, x: c - 40000, m: s, b: [[0.89, 300]], a: [[0.90, 50]] }),
  ];
  const r = run(["--strategies=fav-final", "--per-change", "--venues", "--size=10,200"], tape, usLines);
  ok(r.code === 0, "runs cleanly", r.text);
  ok(/\.us windows 1/.test(r.text), "replays the .us window too", r.text);
  const block = n => (r.text.split(`fav-final · ${n} contracts an entry on each venue`)[1] || "").split("\n\n")[0];
  ok(/every change\s+polyus\s+1\s+\+\$0\.94 \(100%\)/.test(block(10)), ".us at 10: 10 at 0.90 with its own fee = +$0.94", block(10));
  ok(/every change\s+both\s+2\s+\+\$2\.64 \(100%\)\s+\+\$0\.94 \(50%\)/.test(block(10)), "both at 10: the two accounts added, +$2.64 then +$0.94 when the Kalshi flicker is gone", block(10));
  ok(/once a second\s+kalshi\s+1\s+\+\$4\.21 \(25%\)/.test(block(200)), "Kalshi at 200 fills the 50 offered: +$4.21", block(200));
  ok(/once a second\s+polyus\s+1\s+\+\$4\.69 \(100%\)/.test(block(200)), ".us at 200 buys the 50 within 1c: +$4.69", block(200));
  ok(/once a second\s+both\s+2(\s+\+\$8\.90 \(\d+%\)){4}/.test(block(200)), "both at 200: +$8.90", block(200));
  ok(/READING THE BOTH-VENUES TABLE/.test(r.text), "and says how to read it", r.text);

  // One target routed across both venues, on Kalshi's every-change decision
  // (YES at 0.82, the 20-lot flicker that is gone 50ms later; .us 0.90 x 50).
  //   10:  Kalshi's 0.82 is cheaper all-in (.831 vs .906): best of both = Kalshi alone.
  //        + rest on Kalshi: at +50ms the 0.82 is gone, so 10 at Kalshi's 0.85 touch,
  //        fee 8.925c -> 8.93c: 10 - 8.50 - 0.0893 = +$1.4107
  //   200: Kalshi 20 at 0.82 (fee 20.664c -> 20.67c) then .us 50 at 0.90 (fee 31.275c -> 31c):
  //        +0ms 70 - 16.40 - 0.2067 - 45.00 - 0.31 = +$8.0833, 50 of 70 on .us
  //        +50ms only the .us 50: +$4.69; with the rest on Kalshi, 20 more at 0.85
  //        (fee 17.85c): +$4.69 + 20 - 17.1785 = +$7.5115, still 50 of 70 on .us
  const route = n => (r.text.split(`fav-final · target ${n} contracts`)[1] || "").split("\n\n")[0];
  const line = (n, v) => (route(n).split("\n").find(l => l.trimStart().startsWith(v)) || "");
  ok(/\+\$1\.70 \(100%, 0%\)\s+\+\$1\.41 \(100%, 0%\)/.test(line(10, "+ rest on Kalshi")), "10: the rest bought at Kalshi's touch when the flicker is gone: +$1.41", route(10));
  ok(/\+\$1\.70 \(100%, 0%\)\s+\+\$0\.00 \(0%, 0%\)/.test(line(10, "best of both")), "10: Kalshi is cheaper, so best of both is Kalshi alone", route(10));
  ok(/\+\$8\.08 \(100%, 71%\)\s+\+\$4\.69 \(71%, 100%\)/.test(line(200, "best of both")), "200: Kalshi's 20 then .us's 50: +$8.08, then only .us fills", route(200));
  ok(/\+\$8\.08 \(100%, 71%\)\s+\+\$7\.51 \(100%, 71%\)/.test(line(200, "+ rest on Kalshi")), "200: with the rest on Kalshi's touch: +$7.51", route(200));
  ok(/\+\$8\.08 \(100%, 71%\)\s+\+\$4\.69 \(71%, 100%\)/.test(line(200, "Kalshi + overflow")), "200: overflow sends .us only what Kalshi's book did not show", route(200));
  ok(/\+\$3\.39 \(100%, 0%\)\s+\+\$0\.00 \(0%, 0%\)/.test(line(200, "kalshi alone")), "200: Kalshi alone has only the 20", route(200));
}

console.log("the underdog in the last seconds (--longshot)");
{
  // The base archive has YES at .92/.93 20s out (NO at 8c: over the 5c cap)
  // and a one-sided book 10s out: a .99 YES bid and nothing offered, so NO
  // costs 1c. The final record agrees. YES settles: the 1c NO loses, paying
  // 1c + 0.07 x .01 x .99 = 0.0693c -> 0.07c fee = 1.07c. fav-final bought
  // YES 30s out, so this is the hedge reading.
  const tape = [
    (c, T) => ({ k: "final", t: c - 120000, x: c - 120000, m: T, close: new Date(c).toISOString() }),
    (c, T) => ({ k: "full", t: c - 120000, x: c - 120000, m: T, why: "final-window", L: [[[0.90, 100]], [[0.91, 50]]] }),
    (c, T) => ({ k: "full", t: c - 10000, x: c - 10000, m: T, L: [[[0.99, 200]], []] }),
  ];
  const r = run(["--strategies=fav-final", "--longshot"], tape);
  ok(r.code === 0, "runs cleanly", r.text);
  ok(/1 windows replayed/.test(r.text) && /THE UNDERDOG IN THE LAST SECONDS/.test(r.text), "replays the window", r.text);
  ok(/10s before the close · the pilot DID trade \(a hedge\)\n[^\n]*\n\s+1c\s+1\s+1\s+1\.00c\s+1\.07%\s+0\.00%[^\n]*-\$0\.01\s+-1\.07c/.test(r.text), "10s out: NO at 1c off the one-sided book, filled, lost: -1.07c", r.text);
  ok(/5s before the close · the pilot DID trade/.test(r.text), "5s out: the same 10s-old book is within 5s, so it counts", r.text);
  ok(!/15s before the close/.test(r.text), "15s out the underdog cost 8c, over the cap: nothing offered", r.text);
  ok(!/the pilot did NOT trade/.test(r.text), "the pilot traded this window, so no 'did not trade' row", r.text);
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
