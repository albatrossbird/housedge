import { parseSpec, entryFor, audit, verdict, SpecError, MIN_ENTRIES, MIN_DAYS } from "../lib/strategyAudit.js";

let failures = 0;
const check = (n, ok) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${n}`); if (!ok) failures++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const threw = (fn, T = SpecError) => { try { fn(); return false; } catch (e) { return e instanceof T; } };

const base = { name: "t", series: ["KXBTC15M"], entry: { price: { min: 0.65, max: 0.95 } } };

console.log("a spec is validated LOUDLY");
{
  check("a minimal spec parses", parseSpec(base).entry.side === "either");
  check("side defaults to either", parseSpec(base).exit === "settlement");
  // Silently dropping a filter would audit a DIFFERENT strategy and
  // report it under the claimed name.
  check("an unknown top-level field is rejected",
        threw(() => parseSpec({ ...base, leverage: 3 })));
  check("an unknown entry filter is rejected",
        threw(() => parseSpec({ ...base, entry: { ...base.entry, rsi: 70 } })));
  check("a bad side is rejected", threw(() => parseSpec({ ...base, entry: { side: "maybe" } })));
  check("no name is rejected", threw(() => parseSpec({ series: ["x"], entry: {} })));
  check("no series is rejected", threw(() => parseSpec({ name: "t", series: [], entry: {} })));
  // A stop-loss needs the path AFTER entry. Ignoring it would report
  // the result as if the stop did not exist.
  check("an unsupported exit is rejected, not ignored",
        threw(() => parseSpec({ ...base, exit: "stop_loss" })));
}

console.log("\nentry filters, including the NO side");
{
  const s = parseSpec({ ...base, entry: { price: { min: 0.65, max: 0.95 }, spread: { max: 0.03 }, secsToClose: { max: 90 } } });
  check("a yes ask in band enters",
        entryFor({ yes_bid: 0.79, yes_ask: 0.80, secs_to_close: 60 }, s).side === "yes");
  check("a low yes_bid is a NO entry priced at 1 - bid", (() => {
    const e = entryFor({ yes_bid: 0.20, yes_ask: 0.22, secs_to_close: 60 }, s);
    return e.side === "no" && near(e.price, 0.80);
  })());
  check("a wide spread is filtered",
        entryFor({ yes_bid: 0.60, yes_ask: 0.80, secs_to_close: 60 }, s) === null);
  check("too early is filtered",
        entryFor({ yes_bid: 0.79, yes_ask: 0.80, secs_to_close: 400 }, s) === null);
  check("a coin flip is outside the band both ways",
        entryFor({ yes_bid: 0.49, yes_ask: 0.50, secs_to_close: 60 }, s) === null);
  // Number(null) is 0 — a fabricated zero would read as a free option.
  check("an absent book is skipped, not read as 0",
        entryFor({ yes_bid: null, yes_ask: null, secs_to_close: 60 }, s) === null);
  check("a missing secs_to_close is skipped when the filter needs it",
        entryFor({ yes_bid: 0.79, yes_ask: 0.80, secs_to_close: null }, s) === null);

  const yesOnly = parseSpec({ ...base, entry: { price: { min: 0.65, max: 0.95 }, side: "yes" } });
  check("side:yes ignores a NO opportunity",
        entryFor({ yes_bid: 0.20, yes_ask: 0.22 }, yesOnly) === null);
}

console.log("\nthe verdict refuses to overclaim");
{
  // An auditor that reports a number on 30 correlated trades is doing
  // the thing it exists to criticise.
  check("too few entries is INSUFFICIENT",
        verdict({ n: 40, days: 30, edgeOverPrice: 0.1, se: 0.001, netPer: 0.05 }).call === "INSUFFICIENT");
  check("too few DAYS is INSUFFICIENT even with many entries",
        verdict({ n: 5000, days: 4, edgeOverPrice: 0.1, se: 0.001, netPer: 0.05 }).call === "INSUFFICIENT");
  check("an edge inside the correlation-adjusted SE is NOT PROVEN",
        verdict({ n: 1000, days: 30, edgeOverPrice: 0.01, se: 0.01, netPer: 0.01 }).call === "NOT PROVEN");
  check("a big, well-sampled, fee-surviving edge is PROFITABLE",
        verdict({ n: 1000, days: 30, edgeOverPrice: 0.10, se: 0.005, netPer: 0.08 }).call === "PROFITABLE");
  check("a big edge that fees eat is UNPROFITABLE",
        verdict({ n: 1000, days: 30, edgeOverPrice: -0.10, se: 0.005, netPer: -0.08 }).call === "UNPROFITABLE");
}

console.log("\nthe headline case: a 93% win rate that is not an edge");
{
  const spec = parseSpec({ ...base, entry: { price: { min: 0.65, max: 0.95 }, spread: { max: 0.03 } } });
  const obs = [], res = new Map(), day = new Map();
  for (let i = 0; i < 400; i++) {
    const t = `t${i}`;
    obs.push({ ticker: t, yes_bid: 0.91, yes_ask: 0.92, secs_to_close: 60 });
    res.set(t, i % 100 < 93 ? "yes" : "no");        // 93% win rate
    day.set(t, `2026-08-${String((i % 28) + 1).padStart(2, "0")}`);
  }
  const r = audit(obs, res, spec, 1, t => day.get(t));
  check("all entered", r.n === 400);
  check("win rate is 93%", near(r.winRate, 0.93, 1e-6));
  // THE WHOLE POINT. 93% sounds superb; breakeven at a 92c entry is
  // 92.5%, so the entire "edge" is half a cent a contract — smaller
  // than one tick of slippage on a book Kalshi publishes no size for.
  check("breakeven is 92.5%, barely under the win rate", near(r.breakeven, 0.9251, 1e-3));
  check("net EV is positive but under 1c", r.netPer > 0 && r.netPer < 0.01);
  // And it is still not a finding: the edge is inside its own
  // correlation-adjusted standard error.
  check("the verdict is NOT PROVEN, not PROFITABLE", r.verdict.call === "NOT PROVEN");
  check("bands are reported", r.bands.length >= 1 && r.bands[0].n === 400);

  // One cent higher and the same win rate is an outright loss.
  const obs2 = [], res2 = new Map(), day2 = new Map();
  for (let i = 0; i < 400; i++) {
    const t = `u${i}`;
    obs2.push({ ticker: t, yes_bid: 0.92, yes_ask: 0.93, secs_to_close: 60 });
    res2.set(t, i % 100 < 93 ? "yes" : "no");
    day2.set(t, `2026-08-${String((i % 28) + 1).padStart(2, "0")}`);
  }
  const r2 = audit(obs2, res2, spec, 1, t => day2.get(t));
  check("at a 93c entry the same 93% win rate LOSES money", r2.netPer < 0);
  const none = audit([], res, spec, 1);
  check("no entries is its own verdict, not a zero", none.verdict.call === "NO ENTRIES");
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
