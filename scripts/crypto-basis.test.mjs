import { parseCandle, indexCandles, refPrice, predict, marginBps, agreementByMargin } from "../lib/cryptoBasis.js";

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failures++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

console.log("Coinbase's column order is not OHLC");
{
  // [ time, LOW, HIGH, OPEN, CLOSE, volume ] — reading this as OHLC
  // swaps open and close and silently inverts every direction call.
  const c = parseCandle([1789057200, 100, 200, 120, 180, 3.5]);
  check("low is the second column", c.low === 100);
  check("high is the third", c.high === 200);
  check("open is the FOURTH", c.open === 120);
  check("close is the FIFTH", c.close === 180);
  check("a short row is rejected", parseCandle([1, 2, 3]) === null);
  check("a non-numeric row is rejected", parseCandle([1, "x", 3, 4, 5, 6]) === null);
}

console.log("\nthe candle covering the sixty seconds ENDING at t is stamped t-60");
{
  const ix = indexCandles([
    [1000, 10, 20, 12, 18, 1],
    [1060, 10, 20, 12, 19, 1],
  ]);
  check("t=1060 reads the candle at 1000", refPrice(ix, 1060) === 18);
  check("t=1120 reads the candle at 1060", refPrice(ix, 1120) === 19);
  check("a gap yields null, not a stale neighbour", refPrice(ix, 5000) === null);
  check("typical price is (h+l+c)/3", near(refPrice(ix, 1060, "typical"), (20 + 10 + 18) / 3));
  check("an unknown mode is null, not a silent default", refPrice(ix, 1060, "bogus") === null);
}

console.log("\nKalshi's rule is 'at least', so a dead heat is YES");
{
  check("up resolves yes", predict(100, 101) === "yes");
  check("down resolves no", predict(100, 99) === "no");
  check("EXACTLY equal resolves yes", predict(100, 100) === "yes");
  check("a missing reference is null, not a guess", predict(null, 100) === null);
  check("...either side", predict(100, null) === null);
}

console.log("\nmargin, and why aggregate agreement is the wrong number");
{
  check("10 bps up", near(marginBps(100, 100.1), 10));
  check("sign is kept", near(marginBps(100, 99.9), -10));
  check("a zero reference is null, not Infinity", marginBps(0, 5) === null);

  // A proxy for a multi-exchange index disagrees near ties. If every
  // miss is inside a basis point the proxy is usable with a known blind
  // spot; if they are spread across real moves it is not. One aggregate
  // percentage cannot tell those apart.
  const cases = [
    { predicted: "yes", actual: "no",  bps: 0.2 },   // near-tie miss
    { predicted: "no",  actual: "yes", bps: -0.3 },  // near-tie miss
    { predicted: "yes", actual: "yes", bps: 40 },
    { predicted: "no",  actual: "no",  bps: -35 },
    { predicted: "yes", actual: "yes", bps: 12 },
  ];
  const a = agreementByMargin(cases);
  check("counts every resolved case", a.n === 5);
  check("overall rate is 3 of 5", near(a.rate, 0.6));
  const tight = a.bands.find(b => b.hi === 0.5);
  check("both misses land in the tightest band", tight.n === 2 && tight.agree === 0);
  const wide = a.bands.find(b => b.hi === Infinity);
  check("and the wide band is clean", wide.n === 3 && wide.agree === 3);

  const unresolved = agreementByMargin([{ predicted: "yes", actual: null, bps: 5 }]);
  check("an unsettled market is not counted as agreement", unresolved.n === 0);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
