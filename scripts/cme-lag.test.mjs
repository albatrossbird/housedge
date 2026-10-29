// lib/cmeLag.js — the CME path as brtiLag's events need it — and
// scripts/cme-lag.mjs end to end against a fake archive and tick file.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTicks, ticksIn, cmeMoves, cmeOpen, BASELINE_MAX_MS } from "../lib/cmeLag.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };

console.log("parseTicks");
{
  const T = parseTicks("ms,mid\n3000,4001\n1000,4000\n\nbad,x\n2000,0\n");
  ok(Array.from(T.t).join() === "1000,3000" && Array.from(T.v).join() === "4000,4001", "sorted; the header, blanks, junk and a zero price skipped", JSON.stringify([...T.t]));
  const J = parseTicks("1000,0.00666\n", { invert: true });
  ok(Math.abs(J.v[0] - 1 / 0.00666) < 1e-9, "6J's USD per yen is inverted to yen per dollar");
}

console.log("ticksIn, cmeMoves, cmeOpen");
{
  const T = parseTicks("0,4000\n50000,4000\n70000,4000.8\n71000,4000.8\n");
  const tk = ticksIn(T, 60000, 80000);
  ok(tk.length === 3 && tk[0].t === 50000, "the last row before the span comes along as a baseline", JSON.stringify(tk));
  // A bbo-1s record prints only on change: at 70000 the book has stood at
  // 4000 since 50000, 19s before the look-back point. That is a baseline.
  const e = cmeMoves(tk, { thrBp: 1, from: 60000, to: 80000 });
  ok(e.length === 1 && e[0].t === 70000 && e[0].dir === 1 && Math.abs(e[0].bp - 2) < 1e-9, "an unchanged book is a baseline (BRTI's 500ms limit would refuse it)", JSON.stringify(e));
  // Across CME's daily break the "move" spans an hour: not a 1s move.
  const brk = parseTicks(`0,4000\n${BASELINE_MAX_MS + 5000},4010\n`);
  ok(cmeMoves(ticksIn(brk, 0, 1e9), { thrBp: 1, from: 0, to: 1e9 }).length === 0, "a move measured across a shut market is not counted");
  const down = parseTicks("0,4000\n1000,3999.2\n");
  ok(cmeMoves(ticksIn(down, 0, 2000), { thrBp: 1, from: 0, to: 2000 })[0].dir === -1, "a fall is direction -1");
  ok(cmeOpen(T, 180000) === true && cmeOpen(T, 300000) === false, "open only with a row in the final two minutes");
}

function runScript({ series, top, root, tickRows, windows, lines }) {
  const iso = ms => new Date(ms).toISOString();
  const gz = gzipSync(Buffer.from(lines.sort((a, b) => a.t - b.t).map(o => JSON.stringify(o)).join("\n") + "\n")).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "cmelag-"));
  mkdirSync(join(dir, "ticks"));
  writeFileSync(join(dir, "ticks", `${root}.bbo-1s.csv`), "ms,mid\n" + tickRows.map(([t, v]) => `${t},${v}`).join("\n") + "\n");
  const hour = iso(windows[windows.length - 1].close - 1);
  const h = join(dir, "h.mjs");
  writeFileSync(h, `
    const reply = (status, body, raw) => ({ ok: status < 400, status, headers: { get: () => null },
      json: async () => body, text: async () => JSON.stringify(body),
      body: raw ? new ReadableStream({ start(c) { c.enqueue(raw); c.close(); } }) : null });
    globalThis.seenPrefixes = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("/rest/v1/m15_settlements")) return reply(200, u.includes("close_time=gt.") ? [] : ${JSON.stringify(windows.map(w => ({ ticker: w.ticker, close_time: iso(w.close), result: "yes" })))});
      if (u.includes("/storage/v1/object/list/")) {
        const body = JSON.parse(init.body);
        if (body.offset > 0 || body.prefix !== "${top}/${hour.slice(0, 10)}/${hour.slice(11, 13)}/") return reply(200, []);
        return reply(200, [{ id: "1", name: "a_box.ndjson.gz", metadata: { size: 1234 } }]);
      }
      if (u.includes("/storage/v1/object/authenticated/")) return reply(200, null, Buffer.from(${JSON.stringify(gz)}, "base64"));
      return reply(404, {});
    };
    process.env.SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_fake";
    process.argv.push("--series=${series}", "--dir=${dir}");
    await import(${JSON.stringify(join(new URL(".", import.meta.url).pathname, "cme-lag.mjs"))});
  `);
  try { return { code: 0, text: execFileSync(process.execPath, [h], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status, text: String(e.stdout) + String(e.stderr) }; }
}

console.log("cme-lag.mjs end to end");
{
  // Gold at 4000, +2bp (4000.8) at 60s out, every second on CME's clock.
  // Kalshi's book is 49/51 until 500ms after the CME row (Kalshi's clock),
  // then 52/54, and reaches the box 150ms after Kalshi stamps it. A window
  // 15 minutes earlier has no CME rows at all: CME was shut.
  const close = Math.floor((Date.now() - 3600000) / 900000) * 900000;
  const tickRows = [];
  for (let t = close - 130000; t <= close + 10000; t += 1000) tickRows.push([t, t < close - 60000 ? 4000 : 4000.8]);
  const K = "KXGOLD15M-TEST", E = "KXGOLD15M-SHUT";
  const lines = [{ k: "final", t: close - 120000, x: close - 120000, m: K },
    { k: "full", t: close - 119850, x: close - 120000, m: K, L: [[[0.49, 100]], [[0.51, 100]]] },
    { k: "full", t: close - 59350, x: close - 59500, m: K, L: [[[0.52, 100]], [[0.54, 100]]] }];
  const { code, text } = runScript({ series: "KXGOLD15M", top: "m15", root: "GC", tickRows, lines,
    windows: [{ ticker: E, close: close - 900000 }, { ticker: K, close }] });
  ok(code === 0 && /1 settled windows with CME trading in the final two minutes, 1 with CME shut/.test(text), "a window CME was shut for is counted apart", text);
  ok(/1 windows replayed/.test(text), "the open window is replayed from m15/", text);
  const src = text.split("EXCHANGE CLOCKS")[1].split("BOX RECEIVE")[0];
  ok(/2bp in 1s, book 15-85c: 1 events \(1 of 1 windows had one\)/.test(src) && /4bp in 1s, book 15-85c: 0 events/.test(src), "the 2bp move is a 2bp event and not a 4bp one", src);
  const s2 = src.split("2bp in 1s, book 15-85c: 1 events")[1];
  ok(/mid\s+\+0\.00c\s+\+0\.00c\s+\+0\.00c\s+\+0\.00c\s+\+3\.00c\s+\+3\.00c\s+\+3\.00c\s+\+3\.00c/.test(s2), "Kalshi catches up at +500ms on the exchange clocks", s2);
  ok(/share\s+0%\s+0%\s+0%\s+0%\s+100%/.test(s2), "share: none of it done at +0", s2);
  const rcv = text.split("BOX RECEIVE")[1].split("2bp in 1s, book 15-85c: 1 events")[1];
  ok(/mid\s+\+0\.00c\s+\+0\.00c\s+\+0\.00c\s+\+0\.00c\s+\+0\.00c\s+\+3\.00c/.test(rcv), "on the box's clock the book arrives 650ms after CME's stamp", rcv);

  // Oil reads m15x/, and a fall is signed toward the move (NO).
  const W = "KXWTI15M-TEST";
  const oil = [];
  for (let t = close - 130000; t <= close + 10000; t += 1000) oil.push([t, t < close - 30000 ? 60 : 59.97]);
  const ol = [{ k: "final", t: close - 120000, x: close - 120000, m: W },
    { k: "full", t: close - 119900, x: close - 120000, m: W, L: [[[0.49, 100]], [[0.51, 100]]] },
    { k: "full", t: close - 29900, x: close - 30000, m: W, L: [[[0.45, 100]], [[0.47, 100]]] }];
  const r2 = runScript({ series: "KXWTI15M", top: "m15x", root: "CL", tickRows: oil, lines: ol, windows: [{ ticker: W, close }] });
  ok(r2.code === 0 && /archive: m15x\//.test(r2.text) && /1 windows replayed/.test(r2.text), "oil is read from m15x/", r2.text);
  const o5 = r2.text.split("EXCHANGE CLOCKS")[1].split("4bp in 1s, book 15-85c: 1 events")[1];
  ok(/mid\s+\+0\.00c\s+\+4\.00c/.test(o5) && /pay\s+\+0\.00c\s+\+4\.00c/.test(o5), "a 5bp fall: NO's price rose 4c with it, already at +0", o5);
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
