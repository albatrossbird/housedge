// lib/databento.js — CME prices at 15-minute boundaries, read for
// compareSeries. scripts/databento-fetch.py's own selection (the last bar
// ending in the 60s before a boundary) is pinned by
// scripts/databento-fetch.test.py.
//
// Pinned here:
//   1. An unbought boundary is MISSING; a bought one with no trade is STALE.
//   2. 6J is inverted before the move is read, so the side test agrees
//      with KXUSDJPY15M instead of reading every window backwards.
//   3. A unit gap is found from the data, and a basis is not mistaken
//      for one.
import { chunkSpan, parseChunk, boundaryReader, unitFactor } from "../lib/databento.js";
import { compareSeries } from "../lib/dukascopy.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };

const B = Date.parse("2026-10-26T14:00:00Z"), Q = 900000;

console.log("files:");
ok(JSON.stringify(chunkSpan(`GC.ohlcv-1s.${B}-${B + 3600000}.csv`, "GC", "ohlcv-1s")) === JSON.stringify([B, B + 3600000]), "a chunk's span comes from its name");
ok(chunkSpan(`GC.ohlcv-1m.${B}-${B + 1}.csv`, "GC", "ohlcv-1s") === null && chunkSpan(`GCX.ohlcv-1s.1-2.csv`, "GC", "ohlcv-1s") === null && chunkSpan(`GC.ohlcv-1s.1-2.csv.part`, "GC", "ohlcv-1s") === null,
  "another schema, another root and a half-written file are not read");
ok(parseChunk("boundary_ms,px,end_ms\n1,2.5,0\n\nbad,x,y\n3,0,2\n").length === 1, "the header, blanks, junk and a zero price are skipped");

console.log("\nreading a price at a boundary:");
{
  const R = boundaryReader([{ span: [B, B + 3600000], rows: [{ b: B + Q, px: 2000, end: B + Q - 1000 }] }]);
  ok(R.mid(B + Q).mid === 2000 && R.mid(B + Q).age === 1000, "a bought boundary reads its price and how old the trade was");
  ok(R.mid(B + 2 * Q).stale === true, "a bought boundary with no trade in the last 60s is stale");
  ok(R.mid(B).missing === true, "the chunk's first boundary is missing: its last minute was not bought");
  ok(R.mid(B + 5 * 3600000).missing === true, "an hour never bought is missing, not a quiet market");
}

{
  const a = { span: [B, B + 3600000], rows: [{ b: B + Q, px: 1, end: B + Q - 5000 }] };
  const b = { span: [B + 3600000, B + 7200000], rows: [{ b: B + Q, px: 2, end: B + Q - 1000 }] };
  ok(boundaryReader([a, b]).mid(B + Q).mid === 2 && boundaryReader([b, a]).mid(B + Q).mid === 2, "a boundary in two pieces reads the later record, in either order");
}

console.log("\n6J is yen per dollar once inverted:");
{
  // USD/JPY up from 150 to 151 settles YES; 6J (USD per yen) FALLS.
  const W = [{ close: B + 2 * Q, strike: 150, value: 151, result: "yes" }];
  const rows = [{ b: B + Q, px: 1 / 150, end: B + Q }, { b: B + 2 * Q, px: 1 / 151, end: B + 2 * Q }];
  const as = invert => compareSeries(W, boundaryReader([{ span: [B, B + 3600000], rows }], { invert }));
  ok(as(false).side.agree === 0 && as(true).side.agree === 1, "the raw quote reads backwards; inverted it agrees", JSON.stringify([as(false).side, as(true).side]));
  ok(Math.abs(as(true).level.medianBp) < 1e-6, "and its level matches Pyth's");
}

console.log("\nunits:");
{
  const basis = [[2010, 2000], [2020, 2010], [1990, 1981]];
  ok(unitFactor(basis).factor === 1, "a 0.5% basis is a basis, not a unit");
  ok(unitFactor([[5.0, 11023], [5.1, 11244]]).factor === 2204.62262, "copper per pound against per tonne is found");
  ok(unitFactor([[315, 3.15], [320, 3.2]]).factor === 0.01, "a cents quote is found");
  const R = boundaryReader([{ span: [B, B + 3600000], rows: [{ b: B + Q, px: 5, end: B + Q }] }], { factor: 2204.62262 });
  ok(Math.abs(R.mid(B + Q).mid - 11023.1131) < 1e-3, "the factor is applied to what the reader returns");
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
