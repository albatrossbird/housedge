// scripts/m15-archive-backtest.mjs end to end, against a fake Storage
// archive, a fake PostgREST and a fake Kalshi /series. Pins that the
// script reads the archive's book lines on the EXCHANGE's clock, trades
// them through the shared engine, and reports what it covered.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w}\n${extra}`); } };

function run() {
  const dir = mkdtempSync(join(tmpdir(), "m15arch-"));
  const close = Date.now() - 3600000;          // settled an hour ago
  const iso = ms => new Date(ms).toISOString();
  const T = "KXBTC15M-TEST-00";
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
  ];
  const gz = gzipSync(Buffer.from(lines.join("\n") + "\n")).toString("base64");
  const h = join(dir, "h.mjs");
  writeFileSync(h, `
    const close = ${close};
    const reply = (status, body, raw) => ({ ok: status < 400, status, headers: { get: () => null },
      json: async () => body, text: async () => JSON.stringify(body),
      body: raw ? new ReadableStream({ start(c) { c.enqueue(raw); c.close(); } }) : null });
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("/series/KXBTC15M")) return reply(200, { series: { fee_multiplier: 1 } });
      if (u.includes("/series/")) return reply(404, {});
      if (u.includes("/rest/v1/m15_markets")) {
        if (!u.includes("KXBTC15M")) return reply(200, []);
        if (u.includes("close_time=gt.")) return reply(200, []);
        return reply(200, [{ ticker: "${T}", close_time: "${iso(close)}", result: "yes" }]);
      }
      if (u.includes("/storage/v1/object/list/")) {
        const body = JSON.parse(init.body);
        if (body.offset > 0 || !body.prefix.endsWith("/${iso(close).slice(11, 13)}/") || !body.prefix.startsWith("m15/${iso(close).slice(0, 10)}")) return reply(200, []);
        return reply(200, [{ id: "1", name: "a_box.ndjson.gz", metadata: { size: 1234 } }]);
      }
      if (u.includes("/storage/v1/object/authenticated/")) return reply(200, null, Buffer.from(${JSON.stringify(gz)}, "base64"));
      return reply(404, {});
    };
    process.env.SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_fake";
    process.argv.push("--days=2", "--strategies=fav-final", "KXBTC15M");
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

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
