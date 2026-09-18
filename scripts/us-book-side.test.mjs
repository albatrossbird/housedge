// Which side of a Polymarket US book belongs to this leg.
//
// Pinned against the REAL book for aec-mlb-chc-cin-2026-09-18, pulled
// 2026-09-18: 21 bid levels and 23 offer levels, best 0.545 / 0.550.
// That market is also why this exists — the venue was recorded here as
// publishing no ladder at all, so every US leg was skipped, on the
// venue the site's default filter shows.
import { usPolyOffers } from "../lib/depthLadder.js";

let bad = 0;
const ok = (c, what) => { if (c) console.log(`  ok  ${what}`); else { bad++; console.error(`FAIL ${what}`); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;

// Verbatim shape from the live response, trimmed to four levels a side.
const BOOK = {
  bids: [{ price: 0.545, size: 122198.35 }, { price: 0.540, size: 221486.46 },
         { price: 0.535, size: 64214.36 },  { price: 0.530, size: 60586.36 }],
  asks: [{ price: 0.550, size: 30501.20 },  { price: 0.555, size: 89779.84 },
         { price: 0.560, size: 150692.52 }, { price: 0.565, size: 60557.14 }],
};
// The stored leg for that market, as /api/markets reported it.
const LEG = { bid: 0.545, ask: 0.550 };

console.log("the book quotes this leg's side (direct)");
{
  const r = usPolyOffers(BOOK, LEG, true);
  ok(r.reason === null && r.side === "direct", "recognised as direct");
  ok(near(r.offers[0].price, 0.550), `buying yes lifts the offers, best 0.550 (got ${r.offers[0].price})`);
  ok(near(r.offers[0].size, 30501.20), "with the offer's own size");
  ok(r.offers.every((l, i, a) => i === 0 || a[i - 1].price <= l.price), "cheapest first");

  // Buying NO is the complement of the BIDS: selling yes at 0.545 IS
  // buying no at 0.455. Getting this backwards prices the wrong half.
  const n = usPolyOffers(BOOK, LEG, false);
  ok(near(n.offers[0].price, 0.455), `buying no starts at 0.455 (got ${n.offers[0].price})`);
  ok(near(n.offers[0].size, 122198.35), "backed by the yes BID queue, not the ask");
}

console.log("\nthe book quotes the other side (mirrored)");
{
  // Same book, a leg whose stored touch is the complement.
  const leg = { bid: 0.450, ask: 0.455 };
  const r = usPolyOffers(BOOK, leg, true);
  ok(r.reason === null && r.side === "mirrored", "recognised as mirrored");
  ok(near(r.offers[0].price, 0.455), `buying that leg's yes starts at 0.455 (got ${r.offers[0].price})`);
  ok(near(r.offers[0].size, 122198.35), "sized by the book's bid queue");
}

console.log("\nneither side matches — skipped, never guessed");
{
  // A ladder for the wrong outcome is worse than no ladder: it is
  // confident. This is the case that renders a large fake arbitrage.
  const r = usPolyOffers(BOOK, { bid: 0.20, ask: 0.21 }, true);
  ok(r.reason === "misaligned", "a touch matching neither side is refused");
  ok(r.offers.length === 0, "and yields no offers");

  ok(usPolyOffers(BOOK, { bid: null, ask: null }, true).reason === "misaligned",
     "a leg with no touch is refused rather than defaulting to direct");
  ok(usPolyOffers({ bids: [], asks: [] }, LEG, true).reason === "noOffers",
     "an empty book is reported as empty, not misaligned");
}

console.log("\na book symmetric about 50c cannot identify its side");
{
  // direct and mirror both match, so the test proves nothing. Ambiguous
  // is not aligned — the whole point is that it was checked.
  const sym = { bids: [{ price: 0.495, size: 10 }], asks: [{ price: 0.505, size: 10 }] };
  const r = usPolyOffers(sym, { bid: 0.495, ask: 0.505 }, true);
  ok(r.reason === "ambiguous", "50/50 book is refused as ambiguous");
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
