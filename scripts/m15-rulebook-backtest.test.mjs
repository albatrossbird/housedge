// scripts/m15-rulebook-backtest.mjs end to end, against a fake Storage
// archive, a fake PostgREST, a fake Kalshi /series and fake Coinbase
// candles. One window, worked out by hand:
//
//   BRTI sits at 100,000 and steps to 100,200 at open+100s, so change_5m
//   is +0.2% from then until open+400s. The rule file buys 100 YES when
//   change_5m > 0.1% and nothing is held, and sells everything once the
//   position is worth $3 more than it cost.
//   The book is 0.49/0.50 (500 each side) until open+400s, then 0.54/0.55.
//
//   as written     buy 100 at 0.50 = $50.00, fee $1.75 (0.07 x 100 x .25)
//                  at open+100s; at open+400s the bid marks it +$4.00, so
//                  sell 100 at 0.54 = $54.00, fee $1.74. Net +$0.51.
//   mid, no fees   buy at 0.495, mark at the mid; +$5.00 > $3 at
//                  open+400s, sell at 0.545. Net +$5.00.
//   +1s delay      the book a second later is the same row: +$0.51.
//   resting        a bid for 100 at 0.49 posted at open+100s, live 500ms
//                  later; 500 rest ahead. A taker sells 600 into 0.49 at
//                  open+105s: the queue takes 500, we get 100, no fee
//                  (quadratic). Out at the 0.54 bid, fee $1.74: +$3.26,
//                  for both queue assumptions.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kalshiM15Ticker, WINDOW_MS } from "../lib/pmus15.js";

const HERE = new URL(".", import.meta.url).pathname;
let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w}\n${extra}`); } };

const dir = mkdtempSync(join(tmpdir(), "rulebook-"));
const close = Math.floor((Date.now() - 3600000) / WINDOW_MS) * WINDOW_MS, open = close - WINDOW_MS;
const T = kalshiM15Ticker("btc", close);
const iso = ms => new Date(ms).toISOString();

const file = join(dir, "rules.json");
writeFileSync(file, JSON.stringify({
  strategy_name: "test-file", market: { series_ticker: "KXBTC15M" },
  risk: { max_position: 1000, price_floor: 0.01, price_ceiling: 0.99 }, loop: { interval: 10 },
  edge: { btc: { fields: ["price", "change_5m", "vwap_1h"] } },
  rules: [
    { name: "target", when: { all: [{ field: "unrealized_pnl", op: ">", value: 3 }] }, action: "sell_all" },
    { name: "go", when: { all: [{ field: "position_size", op: "==", value: 0 }, { field: "edge.btc.change_5m", op: ">", value: 0.001 }] }, action: "buy_yes", size: 100 },
  ],
}));

const lines = [];
for (let t = open - 600000; t < close + 120000; t += 1000)
  lines.push({ k: "i5", t: t + 50, id: "BRTI", v: t >= open + 100000 ? 100200 : 100000, x: t });
for (let t = open - 5000; t < close; t += 10000) {
  const late = t >= open + 400000, b = late ? 0.54 : 0.49, a = late ? 0.55 : 0.50;
  lines.push({ k: "b", t: t + 30, m: T, b, a, bs: 500, as: 500, d: [500, 500, 500, 500, 500, 500], L: [[[b, 500]], [[a, 500]]], x: t });
}
lines.push({ k: "b", t: close - 2000, m: T, b: 0.10, a: 0.11, L: [[[0.10, 500]], [[0.11, 500]]] });   // no x: dropped
lines.push({ k: "tr", t: open + 105100, m: T, yp: 0.49, n: 600, side: "no", x: open + 105000 });
lines.push({ k: "tr", t: open + 106100, m: T, yp: 0.49, n: 600, side: "no" });                            // no x: not on the tape
lines.push({ k: "i5", t: close + 130000, id: "ETHUSD_RTI", v: 4000, x: close + 130000 });               // another index: ignored
lines.sort((p, q) => (p.x ?? p.t) - (q.x ?? q.t));
const gz = gzipSync(Buffer.from(lines.map(o => JSON.stringify(o)).join("\n") + "\n")).toString("base64");

const h = join(dir, "h.mjs"), out = join(dir, "actions.tsv");
writeFileSync(h, `
  const reply = (status, body, raw) => ({ ok: status < 400, status, headers: { get: () => null },
    json: async () => body, text: async () => JSON.stringify(body),
    body: raw ? new ReadableStream({ start(c) { c.enqueue(raw); c.close(); } }) : null });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/series/KXBTC15M")) return reply(200, { series: { fee_multiplier: 1, fee_type: "quadratic", category: "Crypto" } });
    if (u.includes("api.exchange.coinbase.com")) {
      const q = new URL(u).searchParams, s = Date.parse(q.get("start")) / 1000, e = Date.parse(q.get("end")) / 1000, rows = [];
      for (let t = Math.ceil(s / 60) * 60; t < e; t += 60) rows.push([t, 99990, 100010, 100000, 100000, 5]);
      return reply(200, rows.reverse());
    }
    if (u.includes("/rest/v1/m15_markets")) {
      if (u.includes("close_time=gt.")) return reply(200, []);
      return reply(200, [{ ticker: "${T}", close_time: "${iso(close)}", result: "yes" }]);
    }
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
  process.argv.push("--days=2", "--file=${file}", "--out=${out}");
  await import(${JSON.stringify(join(HERE, "m15-rulebook-backtest.mjs"))});
`);
let r;
try { r = { code: 0, text: execFileSync(process.execPath, [h], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
catch (e) { r = { code: e.status, text: String(e.stdout) + String(e.stderr) }; }

console.log("rule-file backtest end to end");
const row = name => (r.text.split("\n").find(l => l.startsWith(name)) || "");
ok(r.code === 0, "runs cleanly", r.text);
ok(/1 book lines dropped without an exchange timestamp/.test(r.text) && /, 91 book rows,/.test(r.text), "drops, and counts, a book line with no exchange timestamp (91 timed rows kept, not 92)", r.text);
ok(/as written\s+1\s+1\s+100\.0%\s+100\s+\$3\.49\s+\+\$0\.51/.test(row("as written")), "as written: in at the ask, out at the bid, both fees: +$0.51", row("as written"));
ok(/\+\$0\.51/.test(row("+1s delay")), "+1s delay: the same book a second later", row("+1s delay"));
ok(/\$0\.00\s+\+\$5\.00/.test(row("mid, no fees")), "mid, no fees: +$5.00, the gap being spread and fee", row("mid, no fees"));
ok(/resting, back\s+1\s+1\s+100\.0%\s+100\s+\$1\.74\s+\+\$3\.26/.test(row("resting, back")), "resting, back of queue: 100 of the 600 sold reach us past the 500 ahead: +$3.26", row("resting, back"));
ok(/\+\$3\.26/.test(row("resting, front")), "resting, front of queue: the same here", row("resting, front"));
ok(/, 1 trades,/.test(r.text) && /resting, back: 100 of \d+ posted contracts filled/.test(r.text), "keeps the timed trade and reports the fill rate", r.text);
ok(/go\s+1 windows\s+won\s+100\.0%\s+\+\$0\.51/.test(r.text), "credits the window to the rule that opened it", r.text);
ok(/target 1/.test(r.text) && !/held to settlement/.test(r.text.split("── as written: how positions ended")[1]?.split("\n")[0] || ""), "the position ended on the target, not at settlement", r.text);
ok(existsSync(out) && readFileSync(out, "utf8").trim().split("\n").length === 3, "writes every action of the as-written run", existsSync(out) ? readFileSync(out, "utf8") : "no file");

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
