// lib/sharpMove.js — the sharp-move decider — worked by hand, checked
// against the batch logic it replaced (findMoves + the book band, as
// section D of scripts/m15-index.mjs ran it for the 2026-10-21 results),
// replayed against the recorded vector, and scripts/sharp-move-vector.mjs
// end to end against a fake archive.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSharpMove, replayVector, SHARP_MOVE } from "../lib/sharpMove.js";
import { findMoves } from "../lib/brtiLag.js";
import { kalshiM15Ticker, WINDOW_MS } from "../lib/pmus15.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const here = new URL(".", import.meta.url).pathname;

// 5Hz ticks over [a, b] (ms before the close, a > b), value by time.
const C = 1_000_000_000;
const series = (a, b, val) => { const out = []; for (let s = a; s >= b; s -= 200) out.push({ t: C - s, v: val(s) }); return out; };
const run = (ticks, book, params) => {
  const d = createSharpMove(C, params), out = [];
  for (const k of ticks) { const r = d.onTick(k.t, k.v, t => book(C - t)); if (r) out.push(r); }
  return out;
};

console.log("the rule, by hand");
{
  // +1.5bp at 90s out, book 49/51: YES at the ask, limit +1c.
  const up = series(125000, 6000, s => (s > 90000 ? 100000 : 100015));
  const r = run(up, () => ({ bid: 0.49, ask: 0.51 }));
  ok(r.length === 1 && r[0].t === C - 90000 && r[0].order?.side === "yes" && r[0].order.seen === 0.51 && r[0].order.limit === 0.52, "an up move buys YES at the ask, limit 1c above", JSON.stringify(r));
  const down = series(125000, 6000, s => (s > 90000 ? 100000 : 99985));
  const d = run(down, () => ({ bid: 0.49, ask: 0.51 }));
  ok(d[0]?.order?.side === "no" && d[0].order.seen === 0.51 && d[0].order.limit === 0.52, "a down move buys NO at 1 - bid", JSON.stringify(d));
  ok(run(series(125000, 6000, s => (s > 90000 ? 100000 : 100009)), () => ({ bid: 0.49, ask: 0.51 })).length === 0, "0.9bp is not a move");

  // Moves outside 118s..6s out are not events.
  ok(run(series(125000, 3000, s => (s > 119000 ? 100000 : 100020)), () => ({ bid: 0.49, ask: 0.51 })).length === 0, "a move at 119s out is not an event (and is only a level after it)");
  ok(run(series(125000, 3000, s => (s > 5000 ? 100000 : 100020)), () => ({ bid: 0.49, ask: 0.51 })).length === 0, "a move at 5s out is not an event");
  ok(run(series(125000, 3000, s => (s > 118000 ? 100000 : 100020)), () => ({ bid: 0.49, ask: 0.51 }))[0]?.t === C - 118000, "118s out is inside");

  // Out of band at 100s out; a second move 1s later is inside the 2s gap
  // and ignored; one 2s after the first trades.
  const book = s => (s > 98000 ? { bid: 0.90, ask: 0.92 } : { bid: 0.49, ask: 0.51 });
  const steps = series(125000, 6000, s => (s > 100000 ? 100000 : s > 99000 ? 100020 : s > 98000 ? 100040 : 100060));
  const g = run(steps, book);
  ok(g.length === 2 && g[0].skip === "book out of band" && g[0].t === C - 100000 && Math.abs(g[0].mid - 0.91) < 1e-12, "the first event is passed over on the band", JSON.stringify(g));
  ok(g[1]?.order && g[1].t === C - 98000, "the event 2s later trades; the one 1s later was inside the gap", JSON.stringify(g[1]));
  ok(run(steps, () => ({ bid: 0.84, ask: 0.86 }))[0]?.order, "mid 0.85 is inside the band");
  ok(run(steps, () => ({ bid: 0.85, ask: 0.87 }))[0]?.skip === "book out of band", "mid 0.86 is not");
  ok(run(steps, () => ({ bid: 0.14, ask: 0.16 }))[0]?.order && run(steps, () => ({ bid: 0.13, ask: 0.15 }))[0]?.skip === "book out of band", "0.15 inside, 0.14 not");
  ok(run(steps, () => ({ bid: null, ask: 0.51 }))[0]?.skip === "no two-sided book" && run(steps, () => null)[0]?.skip === "no two-sided book", "an empty side, or no book, is passed over");
  // The cap: ask 0.985 with mid in band.
  ok(run(steps, () => ({ bid: 0.70, ask: 0.985 }))[0]?.order.limit === 0.99, "the limit is capped at 0.99");

  // A silence: ticks stop 40s out, resume 36.4s out 3bp higher. The move is
  // measured across the silence: reported, not an event.
  const sil = series(125000, 6000, s => (s > 40000 ? 100000 : 100030)).filter(k => C - k.t > 40000 || C - k.t <= 36400);
  const st = run(sil, () => ({ bid: 0.49, ask: 0.51 }));
  ok(st.length > 0 && st.every(x => x.skip === "stale baseline") && st[0].t === C - 36400 && st[0].baseT === C - 40200, "a move across a silence is a stale baseline, never an order", JSON.stringify(st.slice(0, 2)));
  // A baseline 400ms older than its point is fresh; 600ms is not.
  const fresh = [{ t: C - 101400, v: 100000 }, { t: C - 100000, v: 100020 }];
  ok(run(fresh, () => ({ bid: 0.49, ask: 0.51 }))[0]?.order, "baseline 400ms past the look-back point: a move");
  ok(run([{ t: C - 101600, v: 100000 }, { t: C - 100000, v: 100020 }], () => ({ bid: 0.49, ask: 0.51 }))[0]?.skip === "stale baseline", "600ms past it: stale");

  // Order: one per window, and a stamp going backwards is refused.
  const dd = createSharpMove(C);
  const bk = () => ({ bid: 0.49, ask: 0.51 });
  dd.onTick(C - 101000, 100000, bk);
  ok(dd.onTick(C - 101200, 100000, bk)?.skip === "out of order", "a stamp behind the last is refused");
  ok(dd.onTick(C - 100000, 100020, bk)?.order && dd.done && dd.onTick(C - 90000, 100100, bk) === null, "after the order the window is done");
  ok(Object.isFrozen(SHARP_MOVE) && SHARP_MOVE.thrBp === 1 && SHARP_MOVE.limitCap === 0.99, "the parameters are fixed");
}

console.log("the same decisions as the batch logic it replaced");
{
  // The 2026-10-21 backtest: findMoves over the window's sorted ticks, then
  // the first event whose book is two-sided with mid 0.15-0.85.
  const reference = (ticks, thr, bookAt) => {
    for (const ev of findMoves(ticks, { thrBp: thr, from: C - 118000, to: C - 6000 })) {
      const b = bookAt(ev.t), bid = b?.bid, ask = b?.ask;
      if (bid == null || ask == null) continue;
      const mid = (bid + ask) / 2;
      if (mid < 0.15 || mid > 0.85) continue;
      const side = ev.dir > 0 ? "yes" : "no", seen = side === "yes" ? ask : Math.round((1 - bid) * 10000) / 10000;
      return { t: ev.t, side, seen, limit: Math.min(seen + 0.01, 0.99) };
    }
    return null;
  };
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let n = 0, orders = 0, mismatches = 0, first = "";
  for (let i = 0; i < 3000; i++) {
    const ticks = [];
    let t = C - 130000, v = 100000;
    while (t <= C) {
      ticks.push({ t, v: Math.round(v * 100) / 100 });
      const u = rnd();
      t += u < 0.02 ? 600 + Math.floor(rnd() * 3000) : u < 0.05 ? 0 : 150 + Math.floor(rnd() * 100);
      v += (rnd() - 0.5) * 8 + (rnd() < 0.01 ? (rnd() - 0.5) * 120 : 0);
    }
    const books = new Map();
    const bookAt = tt => {
      const s = Math.floor((C - tt) / 1000);
      if (!books.has(s)) {
        const u = rnd();
        const mid = 0.02 + rnd() * 0.96, half = 0.005 + Math.floor(rnd() * 4) / 100;
        books.set(s, u < 0.05 ? null : u < 0.1 ? { bid: null, ask: Math.round((mid + half) * 100) / 100 } : { bid: Math.round(Math.max(0.01, mid - half) * 100) / 100, ask: Math.round(Math.min(0.99, mid + half) * 100) / 100 });
      }
      return books.get(s);
    };
    for (const thr of [1, 2, 4]) {
      n++;
      const want = reference(ticks, thr, bookAt);
      const d = createSharpMove(C, { thrBp: thr });
      let got = null;
      for (const k of ticks) { const r = d.onTick(k.t, k.v, bookAt); if (r?.order) { got = { t: r.t, ...r.order }; break; } }
      const same = (!want && !got) || (want && got && want.t === got.t && want.side === got.side && want.seen === got.seen && Math.abs(want.limit - got.limit) < 1e-9);
      if (got) orders++;
      if (!same) { mismatches++; if (!first) first = JSON.stringify({ i, thr, want, got }); }
    }
  }
  ok(mismatches === 0 && orders > n / 3 && orders < n, `${n} random windows (silences, repeated stamps, jumps, empty books): ${orders} orders, every one the same`, first);
}

console.log("the recorded vector");
{
  const f = join(here, "fixtures", "sharp-move-vector.json");
  if (!existsSync(f)) ok(false, "scripts/fixtures/sharp-move-vector.json is in the repo");
  else {
    const vec = JSON.parse(readFileSync(f, "utf8"));
    ok(JSON.stringify(vec.params) === JSON.stringify(SHARP_MOVE), "recorded under today's parameters");
    ok(vec.windows.length >= 3 && vec.windows.some(w => w.decisions.some(d => d.order)) && vec.windows.some(w => !w.decisions.some(d => d.order)), "orders and a window without one", vec.windows.map(w => w.why).join(","));
    for (const w of vec.windows) {
      const got = replayVector(w.close_ms, w.ticks);
      ok(JSON.stringify(got) === JSON.stringify(w.decisions), `${w.why} ${w.ticker}: ${w.decisions.length} decisions reproduced exactly`);
    }
  }
}

console.log("sharp-move-vector.mjs end to end");
{
  // Three windows 15 minutes apart, BRTI flat at 100,000 unless stated.
  //   C1 no-order: book 95/97 throughout; +2bp at 80s out passed over on the
  //      band; ticks stop 40s out and resume 36.4s out 3bp higher (stale).
  //   C2 skip-order: book 90/92, then 49/51 from 60s out; -2bp at 100s out
  //      passed over; another -2bp at 50s out trades NO at 0.51.
  //   C3 order: +3bp at 90s out on 49/51: YES at 0.51.
  const C3 = Math.floor((Date.now() - 3600000) / WINDOW_MS) * WINDOW_MS, C2 = C3 - WINDOW_MS, C1 = C2 - WINDOW_MS;
  const iso = ms => new Date(ms).toISOString();
  const T = c => kalshiM15Ticker("btc", c);
  const lines = [];
  const brti = (c, val, skip = () => false) => { for (let x = c - 130000; x <= c; x += 200) if (!skip(c - x)) lines.push({ k: "i5", t: x + 40, id: "BRTI", v: val(c - x).toFixed(2), x }); };
  const full = (c, s, bid, ask) => lines.push({ k: "full", t: c - s + 50, x: c - s, m: T(c), L: [[[bid, 100]], [[ask, 100]]] });
  for (const c of [C1, C2, C3]) lines.push({ k: "final", t: c - 120000, x: c - 120000, m: T(c) });
  brti(C1, s => (s > 80000 ? 100000 : s > 36400 ? 100020 : 100050), s => s < 40000 && s > 36400);
  full(C1, 120000, 0.95, 0.97);
  brti(C2, s => (s > 100000 ? 100000 : s > 50000 ? 99980 : 99960));
  full(C2, 120000, 0.90, 0.92); full(C2, 60000, 0.49, 0.51);
  brti(C3, s => (s > 90000 ? 100000 : 100030));
  full(C3, 120000, 0.49, 0.51);
  lines.sort((a, z) => a.t - z.t);
  const gz = gzipSync(Buffer.from(lines.map(o => JSON.stringify(o)).join("\n") + "\n")).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "smvec-")), h = join(dir, "h.mjs"), out = join(dir, "v.json");
  const rows = [C1, C2, C3].map(c => ({ ticker: T(c), close_time: iso(c), result: "yes" }));
  writeFileSync(h, `
    const reply = (status, body, raw) => ({ ok: status < 400, status, headers: { get: () => null },
      json: async () => body, text: async () => JSON.stringify(body),
      body: raw ? new ReadableStream({ start(c) { c.enqueue(raw); c.close(); } }) : null });
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("/rest/v1/m15_markets")) return reply(200, u.includes("close_time=gt.") ? [] : ${JSON.stringify(rows)});
      if (u.includes("/storage/v1/object/list/")) {
        const body = JSON.parse(init.body);
        if (body.offset > 0 || body.prefix !== "m15/${iso(C3 - 1).slice(0, 10)}/${iso(C3 - 1).slice(11, 13)}/") return reply(200, []);
        return reply(200, [{ id: "1", name: "a_box.ndjson.gz", metadata: { size: 1234 } }]);
      }
      if (u.includes("/storage/v1/object/authenticated/")) return reply(200, null, Buffer.from(${JSON.stringify(gz)}, "base64"));
      return reply(404, {});
    };
    process.env.SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_fake";
    process.argv.push("--days=1", ${JSON.stringify(`--out=${out}`)});
    await import(${JSON.stringify(join(here, "sharp-move-vector.mjs"))});
  `);
  let text, code = 0;
  try { text = execFileSync(process.execPath, [h], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { code = e.status; text = String(e.stdout) + String(e.stderr); }
  ok(code === 0 && /3 complete windows read; 3 chosen/.test(text), "runs, three windows chosen", text);
  const vec = code === 0 ? JSON.parse(readFileSync(out, "utf8")) : { windows: [] };
  const by = Object.fromEntries(vec.windows.map(w => [w.why, w]));
  ok(by.order?.ticker === T(C3) && by.order.decisions.length === 1 && by.order.decisions[0].order.side === "yes" && by.order.decisions[0].t === C3 - 90000, "order: C3, YES at 90s out", JSON.stringify(by.order?.decisions));
  const so = by["skip-order"]?.decisions || [];
  ok(by["skip-order"]?.ticker === T(C2) && so.length === 2 && so[0].skip === "book out of band" && so[0].t === C2 - 100000 && so[1].order?.side === "no" && so[1].order.seen === 0.51 && so[1].order.limit === 0.52 && so[1].t === C2 - 50000, "skip-order: C2, passed over at 100s, NO at 50s", JSON.stringify(so));
  const no = by["no-order"]?.decisions || [];
  ok(by["no-order"]?.ticker === T(C1) && no[0]?.skip === "book out of band" && no.slice(1).length > 0 && no.slice(1).every(d => d.skip === "stale baseline") && !no.some(d => d.order), "no-order: C1, out of band then stale moves only", JSON.stringify(no));
  ok(by.order?.ticks.every(r => typeof r[1] === "string") && by.order.ticks.filter(r => r[2] != null).every(r => r[0] >= C3 - 118000), "values kept as strings; books only from 118s out");
  ok(vec.windows.every(w => JSON.stringify(replayVector(w.close_ms, w.ticks)) === JSON.stringify(w.decisions)), "the file replays to its own decisions");
  const b64 = text.split("\n").filter(l => l.startsWith("VGZ ")).map(l => l.slice(4)).join("");
  ok(b64.length > 0 && /VECTOR-END/.test(text), "the file is in the log too");
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
