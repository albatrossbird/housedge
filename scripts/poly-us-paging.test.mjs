// fetchPolymarketUs pages by OFFSET against a gateway whose catalogue is
// larger than any ceiling written down so far. The ceiling has been wrong
// twice — 4,000 against ~20,500, then 30,000 against 71,378 — so what is
// pinned here is not the number but the ADMISSION: a fetch that stops for
// any reason other than reading a short page must say it is truncated.
//
// Run: node scripts/poly-us-paging.test.mjs

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

// A fake gateway holding `total` markets, optionally failing at a page,
// and optionally repeating a row across a page boundary.
function fakeGateway({ total, failAtOffset = null, duplicateAcross = false }) {
  return async (url) => {
    const u = new URL(url);
    const limit = Number(u.searchParams.get("limit"));
    const offset = Number(u.searchParams.get("offset"));
    if (failAtOffset != null && offset === failAtOffset) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    const markets = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) {
      markets.push({ id: String(i), slug: `m-${i}` });
    }
    // The gateway is documented as capable of repeating rows across
    // pages; the dedupe must absorb that and COUNT it.
    if (duplicateAcross && offset > 0 && markets.length) {
      markets[0] = { id: String(offset - 1), slug: `m-${offset - 1}` };
    }
    return { ok: true, status: 200, json: async () => ({ markets }) };
  };
}

const realFetch = globalThis.fetch;
async function withGateway(gw, fn) {
  globalThis.fetch = gw;
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

const { fetchPolymarketUs } = await import("../lib/polymarketUs.js");

console.log("\ncomplete read (catalogue ends on a short page)");
{
  const r = await withGateway(fakeGateway({ total: 2350 }), () =>
    fetchPolymarketUs({ pageSize: 500, maxPages: 400, concurrency: 6 }));
  check("every market is returned", r.markets.length === 2350, `got ${r.markets.length}`);
  check("truncated is null", r.truncated === null, String(r.truncated));
  check("no errors", r.errors.length === 0, JSON.stringify(r.errors));
}

console.log("\nthe old bug: a catalogue larger than the page cap");
{
  // 30,000-market ceiling against a 71,378-market venue, in miniature.
  const r = await withGateway(fakeGateway({ total: 71378 }), () =>
    fetchPolymarketUs({ pageSize: 500, maxPages: 12, concurrency: 6 }));
  check("returns only what it read", r.markets.length === 6000, `got ${r.markets.length}`);
  check("SAYS it is truncated", !!r.truncated, "a silent cap reads as a complete catalogue");
  check("names the shortfall", /TRUNCATED at 6000 markets/.test(r.truncated || ""), r.truncated || "");
  check("the alarm reaches errors[]", r.errors.some(e => /TRUNCATED/.test(e)));
}

console.log("\nthe lifted cap reaches the end of that same catalogue");
{
  const r = await withGateway(fakeGateway({ total: 71378 }), () =>
    fetchPolymarketUs({ pageSize: 500, maxPages: 400, concurrency: 6 }));
  check("reads the whole venue", r.markets.length === 71378, `got ${r.markets.length}`);
  check("not truncated", r.truncated === null, String(r.truncated));
  // 143 pages of data + the short 144th. Headroom must not cost requests.
  check("early-stops instead of issuing 400 pages", r.pagesRead <= 150, `pagesRead=${r.pagesRead}`);
}

console.log("\nan error stop is a truncation, not an end");
{
  const r = await withGateway(fakeGateway({ total: 71378, failAtOffset: 3000 }), () =>
    fetchPolymarketUs({ pageSize: 500, maxPages: 400, concurrency: 6 }));
  check("SAYS it is truncated", !!r.truncated, "an error that ends the loop must not read as a complete catalogue");
  check("carries the gateway error", r.errors.some(e => /503/.test(e)), JSON.stringify(r.errors.slice(0, 3)));
}

console.log("\nduplicates across page boundaries are dropped and counted");
{
  const r = await withGateway(fakeGateway({ total: 2350, duplicateAcross: true }), () =>
    fetchPolymarketUs({ pageSize: 500, maxPages: 400, concurrency: 6 }));
  const ids = new Set(r.markets.map(m => m.id));
  check("no duplicate ids survive", ids.size === r.markets.length);
  check("duplicatesDropped is reported", r.duplicatesDropped > 0, `got ${r.duplicatesDropped}`);
}

console.log("\nan exactly-full final page still terminates");
{
  const r = await withGateway(fakeGateway({ total: 3000 }), () =>
    fetchPolymarketUs({ pageSize: 500, maxPages: 400, concurrency: 6 }));
  check("all rows", r.markets.length === 3000, `got ${r.markets.length}`);
  check("not truncated (the empty page proves the end)", r.truncated === null, String(r.truncated));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
