// scripts/paper-m15.mjs end to end against a fake Kalshi and PostgREST:
// it decides on the live book with the backtest's findEntry, fills only
// what a second read still offers at the price it saw, settles from
// Kalshi's result — and never sends anything but a GET to Kalshi.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w}\n${extra}`); } };

function run({ moveAfterDecision = false, noTable = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "paper-"));
  const out = join(dir, "r.json"), h = join(dir, "h.mjs");
  writeFileSync(h, `
    import { writeFileSync } from "node:fs";
    const O = ${JSON.stringify({ moveAfterDecision, noTable })};
    const start = Date.now(), close = start + 8000, T = "KXBTC15M-TEST-00";
    const rows = [], kalshi = [];
    let bookReads = 0, decided = false;
    const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null },
      json: async () => body, text: async () => JSON.stringify(body) });
    // YES favourite: YES bid 0.90 (500), NO bid 0.09 -> YES offered at 0.91 (500).
    const steady = { orderbook_fp: { yes_dollars: [["0.8900", "300"], ["0.9000", "500"]], no_dollars: [["0.0800", "200"], ["0.0900", "500"]] } };
    // After the decision the offer has moved to 0.95: nothing at 0.91 is left.
    const moved = { orderbook_fp: { yes_dollars: [["0.9400", "500"]], no_dollars: [["0.0500", "500"]] } };
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("api.elections.kalshi.com")) {
        kalshi.push({ u, method: init.method || "GET" });
        if (u.includes("/series/")) return json({ series: { fee_multiplier: 1 } });
        if (u.includes("/orderbook")) {
          bookReads++;
          const secs = (close - Date.now()) / 1000;
          if (O.moveAfterDecision && decided) return json(moved);
          if (secs <= 6) decided = true;
          return json(steady);
        }
        if (u.includes("/markets?")) return json({ markets: [{ ticker: T, close_time: new Date(close).toISOString() }] });
        if (u.includes("/markets/" + T)) return json({ market: { ticker: T, result: Date.now() > close ? "yes" : "" } });
        return json({}, 404);
      }
      if (u.includes("/rest/v1/")) {
        const path = u.split("/rest/v1/")[1];
        if (path.startsWith("m15_quotes")) return json([]);
        if (path.startsWith("paper_trades?select=id&limit=0")) return O.noTable ? json({ code: "PGRST205", message: "Could not find the table 'public.paper_trades'" }, 404) : json([]);
        if (init.method === "POST") { for (const r of JSON.parse(init.body)) if (!rows.some(x => x.id === r.id)) rows.push(r); return json(null, 201); }
        if (init.method === "PATCH") { const id = decodeURIComponent(path.split("id=eq.")[1]); Object.assign(rows.find(r => r.id === id) || {}, JSON.parse(init.body)); return json(null, 204); }
        if (path.startsWith("paper_trades?select=")) return json(rows.filter(r => r.result == null && Date.parse(r.close_time) < Date.now()));
      }
      return json({}, 404);
    };
    Object.assign(process.env, {
      SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fake", INVOCATION_ID: "t",
      PAPER_SERIES: "KXBTC15M", PAPER_RUN_MINUTES: String(11 / 60), PAPER_POLL_MS: "200",
      PAPER_SETTLE_MS: "500", PAPER_SETTLE_AFTER_MS: "0", PAPER_DISCOVER_MS: "1000",
      PAPER_RULES_JSON: JSON.stringify({ "fav-test": { entry: { side: "favourite", secsMin: 1, secsMax: 6, priceMin: 0.8, priceMax: 0.97, maxSpread: 0.03 } } }),
    });
    process.on("exit", () => writeFileSync(${JSON.stringify(out)}, JSON.stringify({ rows, kalshi, bookReads })));
    await import(${JSON.stringify(join(HERE, "paper-m15.mjs"))});
  `);
  let code = 0, text = "";
  try { text = execFileSync(process.execPath, [h], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }); }
  catch (e) { code = e.status; text = String(e.stdout) + String(e.stderr); }
  return { code, text, ...JSON.parse(readFileSync(out, "utf8")) };
}

console.log("the book holds: the decision fills");
{
  const r = run();
  const t = r.rows[0];
  ok(r.code === 0 && r.rows.length === 1, "one decision for the window, and a clean exit", r.text);
  ok(t && t.side === "yes" && t.decided_price === 0.91 && t.decided_secs <= 6 && t.decided_secs > 0, "buys the favourite at the offer it saw, inside the rule's window", JSON.stringify(t));
  ok(t && t.qty_filled === 10 && t.fill_price === 0.91, "a second read still offering 0.91 fills all ten", JSON.stringify(t));
  ok(t && t.result === "yes" && Math.abs(t.pnl - (10 * 0.09 - 0.06)) < 1e-9, "settles from Kalshi's result, after the taker fee", JSON.stringify(t));
  ok(r.kalshi.every(k => k.method === "GET"), "every request to Kalshi is a GET — nothing is ever sent", JSON.stringify(r.kalshi.filter(k => k.method !== "GET")));
  ok(!r.kalshi.some(k => /portfolio|order(?!book)/.test(k.u)), "and none names an order or portfolio route");
}

console.log("\nthe book moves before the order lands: a miss, recorded");
{
  const r = run({ moveAfterDecision: true });
  const t = r.rows[0];
  ok(t && t.qty_filled === 0 && t.fill_price === null, "nothing fills when the offer has left the price", JSON.stringify(t));
  ok(t && t.result === "yes" && t.pnl === 0, "and a miss settles at zero, not at the win it would have been", JSON.stringify(t));
  ok(/MISSED/.test(r.text), "the log says so");
}

console.log("\nno paper_trades table");
{
  const r = run({ noTable: true });
  ok(r.code === 1 && /0031_paper_trades\.sql/.test(r.text), "fails at once, linking the migration", r.text);
  ok(r.bookReads === 0, "before reading a single book");
}

console.log("\nthe ledger summary");
{
  const { summarizePaper } = await import("../lib/paperM15.js");
  const base = { series: "KXBTC15M", rule: "r", qty_wanted: 10, close_time: "2026-10-02T12:00:00Z" };
  const s = summarizePaper([
    { ...base, side: "yes", qty_filled: 10, result: "yes", pnl: 0.84, fill_latency_ms: 120 },
    { ...base, side: "yes", qty_filled: 4, result: "no", pnl: -3.7, fill_latency_ms: 300 },
    { ...base, side: "no", qty_filled: 0, result: "yes", pnl: 0, fill_latency_ms: 200 },
  ])[0];
  ok(s.decisions === 3 && s.filled === 1 && s.partial === 1 && s.missed === 1, "fired, filled, partial and missed are counted apart", JSON.stringify(s));
  ok(Math.abs(s.fillRate - 2 / 3) < 1e-9, "a partial fill counts as filled for the fill rate");
  ok(s.contracts === 14 && Math.abs(s.pnlPerContract - (0.84 - 3.7) / 14) < 1e-9, "P&L per contract is over contracts actually filled");
  ok(s.winRate === 0.5, "a miss is not a win or a loss");
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
