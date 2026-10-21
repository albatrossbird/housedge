// lib/brtiLag.js — event detection and the book's response, worked by hand
// — and scripts/brti-lag.mjs end to end against a fake archive.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atOrBefore, findMoves, response, summarise } from "../lib/brtiLag.js";
import { kalshiM15Ticker, WINDOW_MS } from "../lib/pmus15.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };

console.log("atOrBefore");
{
  const rows = [{ t: 10 }, { t: 20 }, { t: 30 }];
  ok(atOrBefore(rows, 5) === null && atOrBefore(rows, 20).t === 20 && atOrBefore(rows, 29).t === 20 && atOrBefore(rows, 99).t === 30, "last row at or before t");
}

console.log("findMoves");
{
  // 5Hz at 100,000. +2bp is $20. A $25 rise lands at t=2000.
  const ticks = [];
  for (let t = 0; t <= 4000; t += 200) ticks.push({ t, v: t < 2000 ? 100000 : 100025 });
  const e = findMoves(ticks, { thrBp: 2 });
  ok(e.length === 1 && e[0].t === 2000 && e[0].dir === 1 && Math.abs(e[0].bp - 2.5) < 1e-9, "the first tick past the threshold is the event", JSON.stringify(e));
  ok(findMoves(ticks, { thrBp: 3 }).length === 0, "a 2.5bp move is not a 3bp event");
  // The same jump seen on every tick for the next second is ONE event.
  ok(findMoves(ticks, { thrBp: 2, gapMs: 2000 }).length === 1, "one jump, one event");
  // The baseline for t=2000 is the last tick at or before t=1000. At t=600
  // it is 400ms older than that: fresh enough (the limit is 500ms).
  const quiet = [{ t: 0, v: 100000 }, { t: 600, v: 100000 }, { t: 2000, v: 100030 }];
  ok(findMoves(quiet, { thrBp: 2 }).length === 1, "a baseline 400ms past the look-back point is used");
  const silent = [{ t: 0, v: 100000 }, { t: 2000, v: 100030 }];
  ok(findMoves(silent, { thrBp: 2 }).length === 0, "a move measured across a silence is not counted");
  const down = [{ t: 0, v: 100000 }, { t: 1000, v: 99970 }];
  ok(findMoves(down, { thrBp: 2 })[0].dir === -1, "a fall is direction -1");
}

console.log("response");
{
  // Up move at t=2000. Book 49/51 until 2150, then 52/54, then 55/57 at 3000.
  const rows = [{ t: 0, bid: 0.49, ask: 0.51 }, { t: 2150, bid: 0.52, ask: 0.54 }, { t: 3000, bid: 0.55, ask: 0.57 }];
  const r = response(rows, { t: 2000, dir: 1 }, [0, 100, 250, 1000, 5000]);
  ok(r.at[0].mid === 0 && r.at[100].mid === 0 && r.at[250].mid === 3 && r.at[1000].mid === 6 && r.at[5000].mid === 6, "mid, in cents, toward the move", JSON.stringify(r));
  ok(r.at[250].pay === 3 && r.at[5000].pay === 6, "pay: YES ask for an up move");
  // Down move: NO at 1 - bid. Bid falls 0.49 -> 0.45: NO goes 0.51 -> 0.55, +4c.
  const d = response([{ t: 0, bid: 0.49, ask: 0.51 }, { t: 2100, bid: 0.45, ask: 0.47 }], { t: 2000, dir: -1 }, [0, 500]);
  ok(d.at[0].mid === 0 && d.at[500].mid === 4 && d.at[500].pay === 4, "a fall is signed toward the move, and NO's price is what you pay", JSON.stringify(d));
  ok(response([{ t: 1500, bid: 0.5, ask: 0.52 }], { t: 2000, dir: 1 }, [0]) === null, "no book at the baseline: no response");
  const s = summarise([r, r], [0, 250, 5000]);
  ok(s.n === 2 && s.rows[1].share === 0.5 && s.rows[2].share === 1 && s.rows[1].moved1c === 1 && s.rows[0].moved1c === 0, "share of the final move, and how often 1c had moved", JSON.stringify(s));
}

console.log("brti-lag.mjs end to end");
{
  // One window. BRTI flat at 100,000 at 5Hz, then +3bp at 60s out. The
  // book is 49/51 until 500ms after the jump (source clock), then 52/54.
  // Receive clock: BRTI arrives 300ms late, the book 150ms late.
  const close = Math.floor((Date.now() - 3600000) / WINDOW_MS) * WINDOW_MS;
  const iso = ms => new Date(ms).toISOString();
  const T = kalshiM15Ticker("btc", close);
  const lines = [{ k: "final", t: close - 120000, x: close - 120000, m: T },
    { k: "full", t: close - 119850, x: close - 120000, m: T, L: [[[0.49, 100]], [[0.51, 100]]] },
    { k: "full", t: close - 59350, x: close - 59500, m: T, L: [[[0.52, 100]], [[0.54, 100]]] }];
  for (let x = close - 126000; x <= close; x += 200) lines.push({ k: "i5", t: x + 300, id: "BRTI", v: x < close - 60000 ? 100000 : 100030, x });
  lines.sort((a, b) => a.t - b.t);
  const gz = gzipSync(Buffer.from(lines.map(o => JSON.stringify(o)).join("\n") + "\n")).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "brtilag-")), h = join(dir, "h.mjs");
  writeFileSync(h, `
    const reply = (status, body, raw) => ({ ok: status < 400, status, headers: { get: () => null },
      json: async () => body, text: async () => JSON.stringify(body),
      body: raw ? new ReadableStream({ start(c) { c.enqueue(raw); c.close(); } }) : null });
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("/rest/v1/m15_markets")) return reply(200, u.includes("close_time=gt.") ? [] : [{ ticker: "${T}", close_time: "${iso(close)}", result: "yes" }]);
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
    process.argv.push("--days=1");
    await import(${JSON.stringify(join(new URL(".", import.meta.url).pathname, "brti-lag.mjs"))});
  `);
  let text, code = 0;
  try { text = execFileSync(process.execPath, [h], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { code = e.status; text = String(e.stdout) + String(e.stderr); }
  ok(code === 0 && /1 windows replayed/.test(text), "runs and replays the window", text);
  ok(/BRTI 5Hz \(CF Benchmarks\)\s+\d+\s+300ms\s+300ms/.test(text), "BRTI delay is receive minus source: 300ms", text);
  ok(/Kalshi book changes\s+0\s/.test(text), "no book CHANGE lines in this record (full books only), so no book delay samples", text);
  const src = text.split("SOURCES' OWN CLOCKS")[1];
  ok(/2bp in 1s, book 15-85c: 1 events/.test(src), "the 3bp jump is one 2bp event", src);
  // Source clock: event at close-60000, book moves at +500ms: +3c from then on.
  const src2 = src.split("2bp in 1s, book 15-85c: 1 events")[1];
  ok(/mid\s+\+0\.00c\s+\+0\.00c\s+\+0\.00c\s+\+0\.00c\s+\+3\.00c\s+\+3\.00c\s+\+3\.00c\s+\+3\.00c/.test(src2), "the book catches up at +500ms on the sources' clocks", src2);
  // Receive clock: event seen at close-59700, book at close-59350: +350ms.
  const rcv = text.split("BOX RECEIVE CLOCK")[1].split("SOURCES' OWN CLOCKS")[0].split("2bp in 1s, book 15-85c: 1 events")[1];
  ok(/mid\s+\+0\.00c\s+\+0\.00c\s+\+0\.00c\s+\+0\.00c\s+\+3\.00c/.test(rcv), "on the box's clock the book arrives 350ms after the index", rcv);
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
