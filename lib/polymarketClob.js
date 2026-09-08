// Depth for polymarket.com, from the CLOB order book.
//
// This closes the longest-standing gap in the arb maths. Gamma — the
// endpoint everything else here reads — publishes `liquidity` (a pooled
// aggregate) and `bestBid`/`bestAsk` (prices), but NO SIZE AT THE
// TOUCH. So every polymarket.com leg reported `depthKnown: false` and
// `maxContracts` was an upper bound taken from the Kalshi side alone.
//
// That is not a cosmetic gap. 45 of the 54 profitable legs the site
// currently shows are polymarket.com only, and "an edge without a size
// is not a finding" — on Kalshi the same family of Bitcoin strikes
// offered 7 contracts at one price and 710 at another, six cents of
// profit against fifteen dollars. Until now there was no way to tell
// which of those 45 were which.
//
// CLAUDE.md records this as needing "a per-market call on a different
// host". Measured 2026-09-08, that is out of date: POST /books takes a
// list and answered 200 books in 0.48s, unauthenticated.

const CLOB = "https://clob.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";
const UA = "marketslap/1.0";

// POST /books CAPS AT 200 AND DOES NOT SAY SO.
//
// Measured: 250 token ids came back as 200 books, 500 came back as 200
// books, both HTTP 200 with no error and no flag. That is the same trap
// as gamma's /markets applying a default limit of 20 to a 50-id batch —
// which is how 34 of 35 sports legs sat five hours stale while the
// counter reported a full fetch. Chunk at the cap, and compare
// asked-for against came-back rather than trusting the response length.
export const CLOB_BOOKS_BATCH = 200;

const chunk = (xs, n) => {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

// THE BEST PRICE IS THE LAST ELEMENT, NOT THE FIRST.
//
// Verified 12/12 against gamma's own bestAsk on live markets: the CLOB
// returns each side worst-first, so `asks[0]` is the WORST offer in the
// book. Reading index 0 would quote a 0.9 ask as the touch on a market
// trading at 0.05 and manufacture an enormous fake arbitrage — a
// failure that looks like a finding, which is the worst kind here.
export function touchOf(book) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  const bestBid = bids.length ? bids[bids.length - 1] : null;
  const bestAsk = asks.length ? asks[asks.length - 1] : null;
  return {
    bid: num(bestBid?.price),
    ask: num(bestAsk?.price),
    bidSize: num(bestBid?.size),
    askSize: num(bestAsk?.size),
  };
}

// Sizes for the outcome this leg actually refers to.
//
// A binary CLOB's two tokens are exact complements, in SIZE as well as
// price — measured on a live Fed market:
//
//   token[0] Yes   bid 0.47 x 35444   ask 0.48 x 18216
//   token[1] No    bid 0.52 x 18216   ask 0.53 x 35444
//
// so the No side's ask queue IS the Yes side's bid queue. That is the
// same identity Kalshi's book already relies on — taking NO at no_ask
// is selling YES at yes_bid — and it means ONE book covers both sides.
// Reading the second token would be a second copy of the same numbers
// and a second place for them to disagree.
//
// `outcomeIndex` is the index this pair's leg was matched to, from the
// same identifier-based lookup the sports join uses. Index 1 means the
// leg is the complement, so bid and ask swap.
export function sizesForOutcome(touch, outcomeIndex) {
  const flip = Number(outcomeIndex) === 1;
  return {
    yesBidSize: flip ? touch.askSize : touch.bidSize,
    yesAskSize: flip ? touch.bidSize : touch.askSize,
  };
}

function num(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : null;
}

// slug -> clobTokenIds[]. Gamma accepts a repeated `slug=` key, the same
// shape as its `id=` filter; a comma-joined list is silently ignored.
// `limit` is sent explicitly because gamma applies a default of 20 to a
// batch of any size and returns the truncated list with a 200.
export async function fetchTokenIdsBySlug(slugs, { fetchImpl = fetch } = {}) {
  const out = new Map();
  const errors = [];
  const wanted = [...new Set(slugs.filter(Boolean).map(String))];

  for (const part of chunk(wanted, 50)) {
    const qs = part.map(s => `slug=${encodeURIComponent(s)}`).join("&");
    try {
      const r = await fetchImpl(`${GAMMA}/markets?limit=${part.length}&${qs}`, { headers: { "User-Agent": UA } });
      if (!r.ok) { errors.push(`gamma ${r.status}`); continue; }
      const rows = await r.json();
      for (const m of Array.isArray(rows) ? rows : []) {
        let ids = m?.clobTokenIds;
        if (typeof ids === "string") { try { ids = JSON.parse(ids); } catch { ids = null; } }
        if (Array.isArray(ids) && ids.length) out.set(String(m.slug), ids.map(String));
      }
    } catch (err) {
      errors.push(`gamma fetch: ${err.message}`);
    }
  }
  return { tokensBySlug: out, errors, asked: wanted.length };
}

// token id -> touch. Chunked at the cap, and SHORT batches are reported
// rather than absorbed.
export async function fetchClobBooks(tokenIds, { fetchImpl = fetch } = {}) {
  const books = new Map();
  const errors = [];
  const wanted = [...new Set(tokenIds.filter(Boolean).map(String))];

  for (const part of chunk(wanted, CLOB_BOOKS_BATCH)) {
    try {
      const r = await fetchImpl(`${CLOB}/books`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": UA },
        body: JSON.stringify(part.map(token_id => ({ token_id }))),
      });
      if (!r.ok) { errors.push(`clob ${r.status}`); continue; }
      const rows = await r.json();
      const got = Array.isArray(rows) ? rows : [];
      for (const b of got) if (b?.asset_id) books.set(String(b.asset_id), touchOf(b));
      // A batch that comes back short is a WRONG answer, not a small
      // one: the missing legs read as "no depth published", which is
      // exactly the state this module exists to leave behind.
      if (got.length < part.length) {
        errors.push(`clob /books returned ${got.length} of ${part.length} asked — batch TRUNCATED`);
      }
    } catch (err) {
      errors.push(`clob fetch: ${err.message}`);
    }
  }
  return { books, errors, asked: wanted.length };
}
