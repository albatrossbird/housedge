import { centsToPrice, candleEndingAt, iso, CANDLE_BATCH, candleBatch } from "../lib/kairos.js";

let failures = 0;
const check = (n, ok) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${n}`); if (!ok) failures++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

console.log("Kalshi candle prices arrive in CENTS");
{
  // Reading 49 as a dollar fraction is a 100x error that still looks
  // like a plausible price — the dangerous kind.
  check("49 becomes 0.49", near(centsToPrice(49), 0.49));
  check("99.9 becomes 0.999", near(centsToPrice(99.9), 0.999));
  check("null stays null, not 0", centsToPrice(null) === null);
  check("a non-numeric value is null", centsToPrice("x") === null);
  check("a real zero survives", centsToPrice(0) === 0);
}

console.log("\nbucket_start is the START, so the minute ENDING at t is stamped t-60");
{
  const candles = [
    { bucket_start: "2026-09-12T14:42:00+00:00", close: 61 },
    { bucket_start: "2026-09-12T14:43:00+00:00", close: 77 },
  ];
  const t = Math.floor(Date.parse("2026-09-12T14:43:00Z") / 1000);
  check("the minute ending at 14:43 is the 14:42 bucket", candleEndingAt(candles, t).close === 61);
  check("the minute ending at 14:44 is the 14:43 bucket", candleEndingAt(candles, t + 60).close === 77);
  check("a gap yields null rather than a stale neighbour", candleEndingAt(candles, t + 600) === null);
  check("no candles at all is null", candleEndingAt(null, t) === null);
}

console.log("\ntimestamps go out as ISO 8601, which the API requires");
{
  // Epoch seconds are rejected with 400 invalid_request — verified
  // against the live endpoint.
  check("formats to a Z timestamp", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(iso(Date.parse("2026-09-12T14:30:00Z"))));
}

console.log("\na per-index failure is a HOLE, not a smaller sample");
{
  // The batch endpoint fails per item. Treating a failed item as an
  // empty series would silently shrink the denominator, which is the
  // defect this repo keeps finding.
  const fake = async () => ({
    ok: true, status: 200,
    headers: { get: k => (k === "x-ratelimit-remaining" ? "118" : null) },
    json: async () => ({ results: [
      { index: 0, candles: [{ bucket_start: "2026-09-12T14:42:00+00:00", close: 61 }] },
      { index: 1, error: "contract not found" },
    ] }),
  });
  const items = [{ ticker: "A", start: 0, end: 60000 }, { ticker: "B", start: 0, end: 60000 }];
  const r = await candleBatch(items, { fetchImpl: fake });
  check("the good series comes back", r.series.length === 1 && r.series[0].ticker === "A");
  check("the failed one is REPORTED, not silently dropped", r.failures.length === 1 && r.failures[0].ticker === "B");
  check("results are matched back by index", r.series[0].candles[0].close === 61);
  check("the rate-limit header is surfaced", r.remaining === 118);
  check("an empty request does no work", (await candleBatch([], { fetchImpl: fake })).series.length === 0);
  check("the batch cap matches the documented 200", CANDLE_BATCH === 200);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
