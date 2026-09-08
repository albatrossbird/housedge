// Depth for polymarket.com, from the CLOB book.
//
// Two of these cases are the difference between a real edge and a
// fabricated one, and both were found by probing the live API rather
// than by reading its docs:
//
//   * POST /books caps at 200 and returns HTTP 200 with no flag.
//   * The best price is the LAST element of each side, not the first.
//
// Run: node scripts/poly-clob.test.mjs

import { touchOf, sizesForOutcome, fetchClobBooks, fetchTokenIdsById, CLOB_BOOKS_BATCH } from "../lib/polymarketClob.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

// A real book, copied from a live Fed market on 2026-09-08. Worst-first
// on both sides, which is the convention the whole module turns on.
const liveBook = {
  asset_id: "tok0",
  bids: [{ price: "0.30", size: "100" }, { price: "0.41", size: "9" }, { price: "0.47", size: "35444.05" }],
  asks: [{ price: "0.90", size: "5" }, { price: "0.60", size: "12" }, { price: "0.48", size: "18216.27" }],
};

console.log("\nthe touch is the LAST level, not the first");
{
  const t = touchOf(liveBook);
  check("best bid is 0.47", t.bid === 0.47, `got ${t.bid}`);
  check("best ask is 0.48", t.ask === 0.48, `got ${t.ask}`);
  check("bid size comes from the same level", t.bidSize === 35444.05, `got ${t.bidSize}`);
  check("ask size comes from the same level", t.askSize === 18216.27, `got ${t.askSize}`);
  // Reading index 0 would quote a 0.90 ask against a market trading at
  // 0.48 — a 42-point phantom edge that reads as a finding.
  check("index 0 is NOT the ask (the fake-arb trap)", t.ask !== 0.90);
}

console.log("\nan empty or one-sided book yields null, never zero");
{
  const empty = touchOf({ bids: [], asks: [] });
  check("no bid", empty.bid === null && empty.bidSize === null);
  check("no ask", empty.ask === null && empty.askSize === null);
  // Number(null) is 0, and a fabricated 0 reads as "nothing offered",
  // which is a claim about the book rather than about our data.
  const oneSided = touchOf({ bids: [{ price: "0.20", size: "40" }], asks: [] });
  check("a real bid survives", oneSided.bid === 0.20 && oneSided.bidSize === 40);
  check("the absent ask stays null", oneSided.ask === null && oneSided.askSize === null);
  check("a zero size is null, not 0", touchOf({ bids: [{ price: "0.2", size: "0" }], asks: [] }).bidSize === null);
  check("malformed input does not throw", touchOf(null).bid === null && touchOf(undefined).ask === null);
}

console.log("\noutcome 1 is the complement, so bid and ask sizes swap");
{
  const t = touchOf(liveBook);
  const yes = sizesForOutcome(t, 0);
  const no = sizesForOutcome(t, 1);
  check("outcome 0 reads straight through", yes.yesBidSize === 35444.05 && yes.yesAskSize === 18216.27);
  // Measured on the live venue: token[1] bid 0.52 x 18216 / ask 0.53 x
  // 35444 — the exact mirror of token[0]. Taking NO at its ask is the
  // same queue as selling YES at its bid.
  check("outcome 1 swaps them", no.yesBidSize === 18216.27 && no.yesAskSize === 35444.05);
  check("a null index behaves like outcome 0", sizesForOutcome(t, null).yesAskSize === 18216.27);
}

console.log("\nthe 200-book batch cap is chunked, and a short batch is reported");
{
  const seen = [];
  const fakeClob = async (_url, opts) => {
    const asked = JSON.parse(opts.body);
    seen.push(asked.length);
    return { ok: true, status: 200, json: async () => asked.map(a => ({ asset_id: a.token_id, bids: [], asks: [] })) };
  };
  const ids = Array.from({ length: 470 }, (_, i) => `t${i}`);
  const r = await fetchClobBooks(ids, { fetchImpl: fakeClob });
  check("chunked at the cap", seen.every(n => n <= CLOB_BOOKS_BATCH), JSON.stringify(seen));
  check("every token is asked for", seen.reduce((a, b) => a + b, 0) === 470, JSON.stringify(seen));
  check("every book comes back", r.books.size === 470, `got ${r.books.size}`);
  check("no false truncation alarm", r.errors.length === 0, JSON.stringify(r.errors));
}
{
  // The real trap: the venue silently returns 200 for a 250-id ask.
  const truncating = async (_url, opts) => {
    const asked = JSON.parse(opts.body);
    const given = asked.slice(0, 150);
    return { ok: true, status: 200, json: async () => given.map(a => ({ asset_id: a.token_id, bids: [], asks: [] })) };
  };
  const r = await fetchClobBooks(Array.from({ length: 200 }, (_, i) => `t${i}`), { fetchImpl: truncating });
  check("a short batch is SAID, not absorbed", r.errors.some(e => /TRUNCATED/.test(e)), JSON.stringify(r.errors));
  check("and it names both numbers", /150 of 200/.test(r.errors[0] || ""), r.errors[0] || "");
}

console.log("\ntoken lookup is keyed on the MARKET ID, not the slug");
{
  let seenUrl = "";
  const fakeGamma = async (url) => {
    seenUrl = url;
    return { ok: true, status: 200, json: async () => ([
      { id: 703258, clobTokenIds: JSON.stringify(["ta0", "ta1"]) },
      { id: "665374", clobTokenIds: ["tb0", "tb1"] },
    ]) };
  };
  const r = await fetchTokenIdsById(["703258", "665374", "703258"], { fetchImpl: fakeGamma });
  check("duplicates are collapsed", r.asked === 2, `asked=${r.asked}`);
  check("id is repeated, not comma-joined", /id=703258&id=665374/.test(seenUrl), seenUrl);
  // Gamma applies a default limit of 20 to a batch of any size and
  // returns the truncated list with a 200 — the same trap as /books.
  check("limit is sent explicitly", /[?&]limit=\d+/.test(seenUrl), seenUrl);
  // `closed=true` is a FILTER, not an include-flag: it returned 0 of 6
  // live ids. Sending it would silently check nothing.
  check("closed= is never sent", !/closed=/.test(seenUrl), seenUrl);
  check("a JSON-string token list is parsed", r.tokensById.get("703258")?.[0] === "ta0");
  check("a numeric id keys as a string", r.tokensById.get("665374")?.[0] === "tb0");
}

console.log("\nthe bug the first version shipped: an EVENT slug answers nothing");
{
  // markets.slug holds "gdp-growth-in-2026" — one event carrying every
  // GDP bucket. Gamma's ?slug= wants a market slug, so a batch of these
  // returned 0 rows, and the check silently verified 2 of 45 legs.
  // Non-numeric keys are now filtered BEFORE the request, because one
  // of them 422s the entire batch.
  let called = 0;
  const fakeGamma = async () => { called++; return { ok: true, status: 200, json: async () => [] }; };
  const r = await fetchTokenIdsById(["gdp-growth-in-2026", "what-price-will-bitcoin-hit-before-2027"], { fetchImpl: fakeGamma });
  check("no request is made for non-numeric keys", called === 0, `called=${called}`);
  check("and it SAYS they were skipped", r.errors.some(e => /non-numeric/.test(e)), JSON.stringify(r.errors));
}

{
  // One bad id must not cost the whole chunk — gamma 422s the batch.
  let askedIds = "";
  const fakeGamma = async (url) => { askedIds = url; return { ok: true, status: 200, json: async () => ([{ id: "703258", clobTokenIds: ["t0"] }]) }; };
  const r = await fetchTokenIdsById(["703258", "KXMLBGAME-26SEP08"], { fetchImpl: fakeGamma });
  check("the Kalshi ticker is dropped, the good id survives", r.asked === 1 && !/KXMLBGAME/.test(askedIds), askedIds);
  check("the good id still resolves", r.tokensById.get("703258")?.[0] === "t0");
}

console.log("\na failing venue leaves depth UNKNOWN rather than guessing");
{
  const dead = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const r = await fetchClobBooks(["t1", "t2"], { fetchImpl: dead });
  check("no books invented", r.books.size === 0);
  check("the failure is reported", r.errors.some(e => /503/.test(e)), JSON.stringify(r.errors));
  const thrown = async () => { throw new Error("socket hang up"); };
  const r2 = await fetchTokenIdsById(["703258"], { fetchImpl: thrown });
  check("a thrown fetch does not take the request down", r2.tokensById.size === 0 && r2.errors.length === 1);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
