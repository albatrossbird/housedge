import { createClient } from "@supabase/supabase-js";
import { polyOutcomeIndex, outcomeIndexByName } from "../../lib/sportsKeys.js";
import { tradeableArb, complementBook, realBook, midpointIsMeaningful, annualizedReturn, daysUntil } from "../../lib/fees.js";
import { cleanTitle, polymarketUsUrl, polymarketComUrl } from "../../lib/titles.js";
import { fetchTokenIdsById, fetchClobBooks, sizesForOutcome } from "../../lib/polymarketClob.js";

// Beyond this gap the two venues are not pricing the same thing, and
// the difference is a matching or data fault rather than an edge.
const IMPLAUSIBLE_SPREAD_PTS = 15;

// createClient THROWS AT IMPORT TIME on a missing url, before any
// handler runs — which is why a dev server without credentials could
// not even reach the fixture branch below, and why embed.js cannot be
// imported by a test.
//
// In production a missing variable must still fail loudly: passing a
// placeholder there would turn a misconfigured deploy into one that
// starts and then fails per-request, which is harder to diagnose. In
// development the placeholder lets the module load; a request that
// actually reaches Supabase then fails with a connection error naming
// the fake host, which says what is wrong.
const DEV_PLACEHOLDER = process.env.NODE_ENV === "production"
  ? null
  : { url: "http://supabase-credentials-not-set.invalid", key: "not-set" };

const supabase = createClient(
  process.env.SUPABASE_URL || DEV_PLACEHOLDER?.url,
  process.env.SUPABASE_ANON_KEY || DEV_PLACEHOLDER?.key
);

const SPORT_TAGS = {
  sports:    ["soccer", "nba", "nhl", "mlb", "nfl", "ncaaf"],
  economics: ["econ"],
  crypto:    ["crypto"],
  politics:  ["politics"],
};

// `all` is derived, never hand-listed. A literal fifth entry would go
// stale the first time a category is added and would do it silently —
// the home page would simply stop counting the new one.
SPORT_TAGS.all = [...new Set(Object.values(SPORT_TAGS).flat())];

// Which tab a card belongs to, for the home page's counts.
const CATEGORY_OF_TAG = Object.fromEntries(
  Object.entries(SPORT_TAGS)
    .filter(([cat]) => cat !== "all")
    .flatMap(([cat, tags]) => tags.map(t => [t, cat]))
);

const MONTH_MAP = {
  JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",
  JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12"
};

function extractTickerDate(id) {
  if (!id) return null;
  const match = String(id).toUpperCase().match(
    /(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/
  );
  if (!match) return null;
  return new Date(`20${match[1]}-${MONTH_MAP[match[2]]}-${match[3]}`);
}

// Kalshi's market page is three segments:
//
//   /markets/<series>/<event-slug>/<event-ticker>
//   /markets/kxmlbgame/professional-baseball-game/kxmlbgame-26aug271910milnym
//   /markets/kxrecogsomali/somaliland-recognition/kxrecogsomali-29
//
// This used to emit the first segment alone, on the belief that the
// series page resolved on its own. It does not — it is not a route, and
// every Kalshi link on the site landed on an error.
//
// The middle segment is the series TITLE slugified. It appears on
// /series/<ticker> and nowhere on the market or event, so embed.js
// fetches it once per series and stores it as markets.series_slug.
// The other two segments come from the ticker itself.
//
// Without the slug there is no constructible market URL, so the
// fallback is Kalshi's search — a real route that lands the reader on
// the right market rather than on an error page.
function buildKalshiUrl(row) {
  const series = String(row.kalshi_id || "").split("-")[0].toLowerCase();
  const slug = row.k_series_slug || null;

  if (series && slug) {
    const eventTicker = String(row.k_event_ticker || "").toLowerCase();
    // event_ticker can equal the market ticker for single-market events;
    // both resolve, and the two-segment form is valid on its own.
    return eventTicker
      ? `https://kalshi.com/markets/${series}/${slug}/${eventTicker}`
      : `https://kalshi.com/markets/${series}/${slug}`;
  }

  // Stored titles carry things that hurt a search query: Kalshi's own
  // markdown emphasis ("Will **real GDP** increase..."), the side label
  // after the em dash, and the game date we append to sports titles,
  // which no market title contains.
  const q = String(row.k_title || "")
    .split("—")[0]
    .replace(/\*+/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return q ? `https://kalshi.com/search?q=${encodeURIComponent(q)}` : "https://kalshi.com/";
}

// Re-check the touch size for pairs that look profitable, live.
//
// Depth is the fastest-moving thing on the card and the slowest to
// refresh. The scheduled refresh claims every 15 minutes but GitHub
// throttles high-frequency crons hard on public repos — measured gaps
// today were 45 minutes to 3.5 HOURS — so a stored size can be hours
// old. That produced a headline of "+1.26c on 917 contracts, ~$11.55"
// when the queue actually held 44 contracts and the trade was worth
// $0.56. A 20x overstatement on the one number a reader would act on.
//
// Prices survive staleness far better than sizes do, so rather than
// re-fetching everything this re-checks only the pairs the maths says
// are takeable — typically a handful — and only their Kalshi leg, which
// is the side that publishes size. Batched by series, so it is a couple
// of requests, not one per pair.
async function verifyKalshiDepth(pairs) {
  const profitable = pairs.filter(p => p.arb && p.arb.profitable && p.id);
  if (!profitable.length) return { checked: 0 };

  const series = [...new Set(profitable.map(p => String(p.id).split("-")[0]))];
  const sizes = new Map();

  await Promise.all(series.map(async ticker => {
    try {
      const r = await fetch(
        `https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=200&series_ticker=${encodeURIComponent(ticker)}`
      );
      if (!r.ok) return;
      for (const m of (await r.json()).markets || []) {
        sizes.set(m.ticker, {
          bid: Number(m.yes_bid_size_fp) || null,
          ask: Number(m.yes_ask_size_fp) || null,
        });
      }
    } catch { /* leave unverified rather than guessing */ }
  }));

  let checked = 0, corrected = 0;
  for (const p of profitable) {
    const live = sizes.get(p.id);
    if (!live) { p.arb.depthVerified = false; continue; }
    checked++;

    // Which Kalshi queue backs this trade: taking YES uses the ask
    // queue, taking NO is the same as selling YES and uses the bid.
    const takesKalshiYes = String(p.arb.side || "").startsWith("kalshi-yes");
    const liveSize = takesKalshiYes ? live.ask : live.bid;
    if (liveSize == null) { p.arb.depthVerified = false; continue; }

    const before = p.arb.maxContracts;
    const next = p.arb.maxContracts == null ? liveSize : Math.min(p.arb.maxContracts, liveSize);
    if (before != null && Math.abs(next - before) > 0.01) corrected++;

    p.arb.maxContracts = next;
    p.arb.edgeDollars = Math.round(p.arb.edge * next * 100) / 100;
    p.arb.depthVerified = true;
  }

  return { checked, corrected };
}

// Re-check the touch size for the POLYMARKET leg of pairs that look
// profitable, live, from the CLOB order book.
//
// This is the other half of verifyKalshiDepth, and it closes the gap
// that made most of the site's arb signal unverifiable. Gamma — which
// every other read here uses — publishes `liquidity` (a pooled
// aggregate) and best prices, but no size at the touch, so a
// polymarket.com leg has always passed null into the maths and left
// `maxContracts` an upper bound set by the Kalshi side alone.
//
// That mattered more than it sounds: 45 of the 54 profitable legs the
// site shows are polymarket.com only, so the majority of the arb
// signal had no size behind it at all — and an edge without a size is
// not a finding.
//
// Scoped exactly like the Kalshi check: only pairs the maths already
// calls profitable, which is a handful, and only their Polymarket leg.
// It is two round trips (slug -> token id, token id -> book) rather
// than one because the token id is not stored; both are batched, and
// the whole thing runs concurrently with the Kalshi check.
//
// polymarket.us is NOT handled here — it publishes bidDepth/askDepth on
// its own /bbo endpoint and already arrives with real sizes.
async function verifyPolyDepth(pairs) {
  const profitable = pairs.filter(
    p => p.arb && p.arb.profitable && p._polyId && p.poly && !p.poly.usTradable
  );
  if (!profitable.length) return { checked: 0, corrected: 0 };

  const errors = [];
  const { tokensById, errors: tokErrors } = await fetchTokenIdsById(
    profitable.map(p => p._polyId)
  );
  errors.push(...tokErrors);

  // One book per market: a binary CLOB's two tokens are exact
  // complements in size as well as price, so token[0] backs both sides
  // and reading the second would be a second copy of the same numbers.
  const wanted = [];
  for (const p of profitable) {
    const ids = tokensById.get(p._polyId);
    if (ids && ids[0]) wanted.push(ids[0]);
  }
  const { books, errors: bookErrors } = await fetchClobBooks(wanted);
  errors.push(...bookErrors);

  let checked = 0, corrected = 0;
  for (const p of profitable) {
    const ids = tokensById.get(p._polyId);
    const touch = ids && ids[0] ? books.get(String(ids[0])) : null;
    if (!touch) { p.arb.polyDepthVerified = false; continue; }

    const { yesBidSize, yesAskSize } = sizesForOutcome(touch, p._polyIdx);

    // Which Polymarket queue backs this trade. Taking the poly YES side
    // lifts its ask; taking poly NO is the same trade as selling YES,
    // so the YES bid queue is what backs it — the identity Kalshi's
    // book already relies on, and one this venue's own numbers confirm
    // (token[1].ask size equals token[0].bid size, exactly).
    const takesPolyYes = String(p.arb.side || "").startsWith("poly-yes");
    const liveSize = takesPolyYes ? yesAskSize : yesBidSize;
    if (liveSize == null) { p.arb.polyDepthVerified = false; continue; }
    checked++;

    const before = p.arb.maxContracts;
    const next = before == null ? liveSize : Math.min(before, liveSize);
    if (before != null && Math.abs(next - before) > 0.01) corrected++;

    p.arb.maxContracts = next;
    p.arb.edgeDollars = Math.round(p.arb.edge * next * 100) / 100;
    p.arb.polyDepthVerified = true;
    // Both legs now have a real size behind them, so this is no longer
    // an upper bound taken from one side.
    if (p.arb.depthVerified) p.arb.depthKnown = true;
  }

  return { checked, corrected, errors: errors.slice(0, 3) };
}

// Age of the stalest timestamp given, in seconds.
//
// The header used to read "Updated 3:42 PM" off the browser's fetch
// clock, which answers a question nobody asked: when the page requested
// the data, not when the venue was last observed. Those are hours apart
// in normal operation - refresh-prices.yml asks GitHub for every 15
// minutes and gets 45 minutes to 3.5 hours on a public repo - so a price
// seen at noon rendered as if it were current.
//
// Returns null if no usable timestamp came back, so a site running ahead
// of migration 0010 shows no age rather than a fabricated one.
function ageSeconds(...stamps) {
  const nowSec = Date.now() / 1000;
  const ages = stamps
    .map(t => {
      if (t == null || t === "") return NaN;
      // markets.updated_at is a bigint of epoch SECONDS, written as
      // Math.floor(Date.now() / 1000) by every write path. Date.parse
      // on that returns NaN, so the whole feature reported null while
      // looking like it worked. Milliseconds and ISO strings are
      // handled too: this value is read from a hand-run migration and
      // one wrong guess about its units is a silently wrong age on the
      // number a reader acts on.
      const n = Number(t);
      if (Number.isFinite(n)) return n > 1e11 ? n / 1000 : n;
      const parsed = Date.parse(t);
      return Number.isFinite(parsed) ? parsed / 1000 : NaN;
    })
    .filter(sec => Number.isFinite(sec) && sec > 0)
    .map(sec => Math.max(0, Math.round(nowSec - sec)));
  return ages.length ? Math.max(...ages) : null;
}

// One card per Kalshi market, with a leg per Polymarket venue.
//
// A Kalshi market listed on both polymarket.com and polymarket.us
// produces two rows in `pairs`, and the site rendered them as two
// separate cards: the same fixture twice, a few cents apart, with
// nothing saying they were the same claim. The reader is here to
// compare venues, so the comparison belongs inside one card rather
// than between two.
//
// Merged here rather than in the client for the same reason the
// implausible-spread guard lives here: the arb figures are per-leg and
// computed in this file, and a client that recombined them would be a
// second place for that maths to live and a first place for it to drift.
//
// Each leg keeps its OWN arb. Picking a single best number across
// venues would quietly quote an edge on .com to a reader who can only
// trade .us — the venues are separate exchanges, not mirrors.
function mergeByKalshiMarket(pairs) {
  const byKalshi = new Map();

  for (const p of pairs) {
    let card = byKalshi.get(p.id);
    if (!card) {
      card = {
        id: p.id,
        title: p.title,
        category: p.category,
        kalshi: p.kalshi,
        // What the Kalshi side actually settles on. Null until
        // migration 0011 has run and discovery has re-fetched, so the
        // card must render without it.
        resolution: p.resolution || null,
        legs: [],
      };
      byKalshi.set(p.id, card);
    }
    card.legs.push({
      pairId: p.pairId,
      polyTitle: p.polyTitle,
      similarity: p.similarity,
      // The staler of this leg's two sides. Per leg, not per card: one
      // venue can be hours behind the other, and averaging that away
      // is how a stale book passes for a fresh one.
      priceAgeSeconds: p.priceAgeSeconds,
      poly: p.poly,
      arb: p.arb,
      resolution: p.polyResolution || null,
    });
  }

  for (const card of byKalshi.values()) {
    // US first, then by cost.
    //
    // Sorting on cost alone put whichever venue happened to be cheaper
    // on top, so the row order changed from card to card and the reader
    // had to re-read the labels on every one. The venue they can
    // actually trade is the one that should lead, every time — price
    // decides only between legs they can equally act on. Legs with no
    // executable price sink rather than sorting as a zero-cost trade.
    card.legs.sort((a, b) => {
      if (a.poly.usTradable !== b.poly.usTradable) return a.poly.usTradable ? -1 : 1;
      return (a.arb ? a.arb.cost : Infinity) - (b.arb ? b.arb.cost : Infinity);
    });
    card.trending = (card.kalshi.volume || 0) +
      Math.max(0, ...card.legs.map(l => l.poly.volume || 0)) > 5000;
  }

  return [...byKalshi.values()];
}

// Kalshi titles carry raw markdown: "Will **real GDP** increase by more
// than 2.0% in Q3 2026?". Nothing renders it, so the asterisks reach the
// card verbatim and the flagship econ market reads as broken.
//
// The trailing side label is the other half. Kalshi's title already
// states the threshold and we append the label again, so every econ card
// said the number twice: "...more than 2.0% in Q3 2026? — Above 2.0%".
//
// The rule is deliberately narrow, because the two failure modes are not
// symmetric: a label left on is noise, a label wrongly removed loses
// which side the price belongs to. A first attempt matched on any shared
// substring or digit and turned "Miami vs Washington (Aug 29) — Miami"
// into a card that no longer said which team was at 51%, and dropped
// "— Before October 2026" because the question happened to contain 2026.
//
// So: only a bare comparator-and-value label, and only when that exact
// value (with its unit) is already in the question.
// The price a card SHOWS, derived from the book it also shows.
//
// Two independent numbers were being rendered as one. Polymarket's
// `outcome_prices` is a LAST-TRADE figure; `bid`/`ask` is the live
// book. A last trade legitimately sits outside a book that moved after
// it, and 13 of 108 Polymarket legs did — one by 6.5 points, showing
// 0.555 against a book of 0.485/0.490. The card then implied a spread
// that was not there, which is exactly what "5 point spread but over a
// dollar to own both sides" looks like from the outside.
//
// Kalshi had the mirror problem: it displayed its ASK while Polymarket
// displayed a last trade, so the cross-venue comparison the whole card
// exists to make was not like-for-like.
//
// Both venues now show the MID of their own book. The arb figure still
// comes from the ASKS, because that is what a trade costs — and the
// difference between the two is now a real quantity (book width) the
// card can explain, rather than an inconsistency it has to hide.
function bookMid(bid, ask, fallback) {
  const b = Number(bid), a = Number(ask);
  if (Number.isFinite(b) && Number.isFinite(a) && a >= b && a > 0) {
    // A BOOK WIDER THAN WIDE_BOOK_PTS HAS NO MIDPOINT WORTH SHOWING,
    // and the fallback is NOT reached for it — that is the whole point.
    //
    // The stored outcome price for these markets is the venue's own
    // placeholder: the untraded college-football games read
    // ["0.495","0.505"]. Falling through to it would replace one
    // fabricated 50% with another and look like a fix. Returning null
    // means "no price", which is what the market actually has, and the
    // pair then drops out under `missingPrice` rather than rendering a
    // confident comparison against a number nobody quoted.
    if (!midpointIsMeaningful(b, a)) return null;
    return Math.round(((b + a) / 2) * 10000) / 10000;
  }
  // No usable book at all is a different case: the stored price may be
  // a real traded quote we simply have no book for, so the fallback
  // stands here.
  return fallback;
}

export default async function handler(req, res) {
  const category = req.query.category || "sports";
  const tags = SPORT_TAGS[category];
  if (!tags) return res.status(400).json({ error: `Unknown category: ${category}` });

  // ── Dev-only fixture ────────────────────────────────────────────
  //
  // A local dev server has no Supabase credentials, so every card path
  // renders an error and any UI change had to be checked by reading the
  // diff. Meanwhile the sandbox's browser cannot reach production. The
  // result was shipping visual work nobody had looked at.
  //
  // With MARKETS_FIXTURE_DIR set, this serves a saved production payload
  // from <dir>/<category>.json, so the real component tree renders
  // against real data.
  //
  // TWO INDEPENDENT GUARDS, because a fixture that could ever answer a
  // real request is worse than no fixture: it would serve stale prices
  // as though they were live. NODE_ENV is production on Vercel, and the
  // env var is not set anywhere but a developer's own shell.
  if (process.env.NODE_ENV !== "production" && process.env.MARKETS_FIXTURE_DIR) {
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      // basename() so a category cannot walk out of the directory.
      const file = path.join(process.env.MARKETS_FIXTURE_DIR, `${path.basename(category)}.json`);
      const body = JSON.parse(await fs.readFile(file, "utf8"));
      res.setHeader("X-Markets-Fixture", file);
      return res.status(200).json({ ...body, fixture: file });
    } catch (err) {
      // Loud, not silent. A missing fixture that fell through to the
      // real path would look like the fixture working.
      return res.status(500).json({
        error: `fixture for "${category}" not readable: ${err.message}`,
        hint: "MARKETS_FIXTURE_DIR is set; unset it to use Supabase",
      });
    }
  }

  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayMs = today.getTime();

    // Use RPC function which runs a direct SQL join — bypasses all
    // the JS client query issues we've been hitting
    // POSTGREST CAPS AN RPC AT 1000 ROWS, AND THIS ONE WAS NEVER TOLD
    // OTHERWISE.
    //
    // Measured 2026-09-07 on ?category=all: `pairCount: 501` and
    // `hidden.total: 499` — exactly 1000 rows of the 1,418 in `pairs`.
    // get_pairs orders by similarity DESC, so sports (an exact join, so
    // similarity 1.0) filled the front and politics came back 228 cards
    // of 376, economics 8 of 29.
    //
    // The visible symptom was on the FRONT DOOR, and it did not look
    // like truncation. A Kalshi market listed on both Polymarket venues
    // is TWO rows, and the cut landed BETWEEN them — so the same card
    // returned two legs under ?category=politics and a lone global-only
    // leg under ?category=all, and the home page featured markets a US
    // account cannot trade while 38 US-tradable politics cards sat
    // outside the window.
    //
    // A CLIENT `.limit()` DOES NOT LIFT THIS. `db-max-rows` is a
    // server-side maximum in PostgREST: a client may ask for fewer rows
    // than it, never more. Raising the limit to 20000 changed nothing —
    // the response stayed at exactly 1000 — and worse, a truncation
    // check written against that number could never fire, which is the
    // same defect as a counter that can only be non-zero.
    //
    // So `all` FANS OUT: one call per tab, each comfortably under the
    // cap (the largest, politics, is ~940 pairs), concatenated. That is
    // why the per-category tabs were always correct and only the
    // combined view was short. It needs no migration and makes `all`
    // the sum of the tabs by construction.
    //
    // The cliff was still there one category further out, and it
    // ARRIVED: the first run of that alarm reported
    // `pairsTruncated: ["politics: 1000"]`. So each group is PAGED.
    //
    // Paging needs a TOTAL order, and the caller has to state it on the
    // OUTER query — an ORDER BY inside a set-returning function is not
    // guaranteed to survive into an outer LIMIT/OFFSET. Ordering by
    // `similarity` alone is the untied sort the tiebreaker exists to
    // fix, since every sports pair carries 1.0, so this reads
    // `pair_id` — which only exists once
    // supabase/migrations/0017_get_pairs_pageable.sql has run.
    //
    // Before that migration lands the ordered read 400s on the unknown
    // column, so the whole request falls back to ONE capped call per
    // group — exactly what shipped before — and says so through the
    // same `pairsTruncated` field. A deploy landing ahead of a
    // hand-run migration is the normal case here (see 0004).
    const PAGE_CAP = 1000;
    const MAX_PAGES = 40;
    const groups = category === "all"
      ? Object.entries(SPORT_TAGS).filter(([c]) => c !== "all")
      : [[category, tags]];

    async function readGroupPaged(groupTags) {
      const out = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const from = page * PAGE_CAP;
        const { data, error } = await supabase
          .rpc("get_pairs", { sport_tags: groupTags })
          .order("similarity", { ascending: false })
          .order("pair_id", { ascending: true })
          .range(from, from + PAGE_CAP - 1);
        // Only a FIRST-page failure means "this deployment cannot page"
        // — that is the missing-column case. A later page failing is a
        // short answer, not a reason to throw away the pages that
        // worked and re-read the group capped, so it keeps what it has
        // and reports the group as short.
        if (error) return page === 0 ? { error } : { rows: out, partial: error };
        const got = data || [];
        out.push(...got);
        if (got.length < PAGE_CAP) return { rows: out };
      }
      return { rows: out, hitPageLimit: true };
    }

    const rows = [];
    const cappedGroups = [];
    let canPage = true;
    for (const [name, groupTags] of groups) {
      if (canPage) {
        const paged = await readGroupPaged(groupTags);
        if (!paged.error) {
          if (paged.hitPageLimit) cappedGroups.push(`${name}: ${paged.rows.length} (page limit)`);
          if (paged.partial) cappedGroups.push(`${name}: ${paged.rows.length} (read failed mid-page: ${paged.partial.message || paged.partial})`);
          rows.push(...paged.rows);
          continue;
        }
        // One failure disables paging for the whole request, so a
        // pre-migration deploy pays one wasted call, not one per tab.
        canPage = false;
        console.error(`get_pairs paged read failed (${paged.error.message || paged.error}) — falling back to a single capped call. Run supabase/migrations/0017_get_pairs_pageable.sql`);
      }
      const { data: part, error: partErr } = await supabase
        .rpc("get_pairs", { sport_tags: groupTags });
      if (partErr) throw partErr;
      const got = part || [];
      if (got.length >= PAGE_CAP) cappedGroups.push(`${name}: ${got.length} (unpaged — needs migration 0017)`);
      rows.push(...got);
    }
    if (cappedGroups.length) {
      console.error(`get_pairs returned a SHORT result for: ${cappedGroups.join(", ")}`);
    }
    // Defensive: the groups are disjoint today, but a tag added to two
    // of them would silently double a card's legs. Paging makes this
    // load-bearing rather than defensive — an OFFSET page boundary that
    // shifts under a concurrent write can repeat a row.
    const seenPair = new Set();
    const data = rows.filter(r => {
      const k = `${r.kalshi_id}\u0000${r.polymarket_id}`;
      if (seenPair.has(k)) return false;
      seenPair.add(k);
      return true;
    });
    const pairsTruncated = cappedGroups.length ? cappedGroups : null;

    if (!data || data.length === 0) {
      return res.status(200).json({ pairs: [], needsEmbed: true });
    }

    const dropped = { missingPrice: 0, kalshiOutOfBand: 0, polyOutOfBand: 0, expired: 0, implausibleSpread: 0 };
    // How often the shown price came from the book rather than the
    // stored last-trade figure. A large poly number is the bug this
    // replaced still being present in the data.
    const priceFromBook = { kalshi: 0, poly: 0 };
    // Legs whose two-sided book was too wide for its midpoint to mean
    // anything — see WIDE_BOOK_PTS in lib/fees.js.
    const wideBook = { kalshi: 0, poly: 0 };
    let noExecutablePrice = 0;
    let implausibleArbs = 0;
    // Per-reason, so one noisy reason cannot crowd out the one being
    // investigated. See the note() comment below.
    const sampleByReason = {};
    const wantDebug = req.query.debug === "1";
    const DEBUG_SAMPLE_PER_REASON = 120;

    const shaped = data
      .map(row => {
        let pYes = row.p_yes_price;
        let idx = null;
        if (row.p_outcomes && row.p_outcome_prices) {
          try {
            const outcomes = JSON.parse(row.p_outcomes);
            const prices   = JSON.parse(row.p_outcome_prices);

            // Identifiers first. Keyword-matching the side label against
            // the outcome text fails in both directions: "A's" has no
            // token longer than two characters so it matches nothing and
            // falls through to outcome 0 — the *opponent's* price — and
            // "New York M" matches "New York Yankees" as readily as
            // "New York Mets". Either way the card pairs one team's
            // Kalshi price with the other team's Polymarket price, which
            // renders as a large fake arbitrage.
            idx = polyOutcomeIndex(row.kalshi_id, row.p_slug);

            // On a name-keyed league the two venues publish the SAME
            // school name — Kalshi's side_label against Polymarket's
            // outcomes — so this is a lookup where the keyword fallback
            // below would be a guess. Tried before that fallback and
            // after the identifier path, which is exact where it works.
            if (idx == null) {
              idx = outcomeIndexByName(row.k_side_label, outcomes);
            }

            if (idx == null) {
              const titleSide = (row.k_title || "").split("—").pop().trim();
              const sideKw = (row.k_side_label || titleSide).toLowerCase()
                .split(/\W+/).filter(w => w.length > 2);
              const kwIdx = outcomes.findIndex(o => sideKw.some(w => o.toLowerCase().includes(w)));
              idx = kwIdx >= 0 ? kwIdx : null;
            }

            if (idx != null && prices[idx] != null) pYes = parseFloat(prices[idx]);
          } catch {}
        }

        const kalshiUrl = buildKalshiUrl(row);
        // Two different exchanges. Sending a US trader to a .com market
        // they cannot trade is the same class of error as a dead link,
        // and worse because it looks like it worked.
        const isPolyUs = row.p_platform === "polymarket_us";
        // .us routes GAMES under /sports/<league>/..., not /event/ —
        // see lib/titles.js. Every sports pair's .us link was a 404.
        const polyUrl = isPolyUs
          ? polymarketUsUrl(row.p_slug, row.p_event_ticker)
          : polymarketComUrl(row.p_slug);
        const polyVenue = isPolyUs ? "Polymarket US" : "Polymarket (global)";

        // ── Executable pricing ─────────────────────────────────
        // Polymarket quotes one book per market, on outcome 0. When the
        // Kalshi side maps to outcome 1 the book is that book's exact
        // complement, so the ask for the side we care about is
        // 1 - bid(outcome 0). Using the raw book either way would
        // quote the opponent's price.
        const polyOnOutcome1 = idx === 1;
        const rawPolyBook = realBook(row.p_bid, row.p_ask);
        // The complement of an empty book is an empty book, so it is
        // taken from rawPolyBook — already emptied — rather than from
        // the row, or 0/1 would come back as 0/1 through the mirror.
        const polyBook = polyOnOutcome1
          ? complementBook(rawPolyBook.bid, rawPolyBook.ask)
          : rawPolyBook;
        const polyOtherBook = polyOnOutcome1
          ? rawPolyBook
          : complementBook(rawPolyBook.bid, rawPolyBook.ask);

        // Display the mid of the book this leg actually trades on.
        // polyBook is already index-aware, so this cannot quote the
        // opponent's side the way the raw book would.
        // Kalshi quotes an untraded market 0/1 too, and its YES and NO
        // books are genuinely separate, so each is tested on its own.
        const kBook = realBook(row.k_bid, row.k_ask);
        const kNoBook = realBook(row.k_no_bid, row.k_no_ask);
        const pYesShown = bookMid(polyBook.bid, polyBook.ask, pYes);
        const kYesShown = bookMid(kBook.bid, kBook.ask, row.k_yes_price);
        // Named, not inferred from a smaller card count. These legs used
        // to render a fabricated ~50%; they now have no price, and the
        // difference between "we lost a price" and "the venue never
        // quoted one" is exactly what a counter is for.
        if (pYesShown == null && polyBook.bid != null && polyBook.ask != null) wideBook.poly++;
        if (kYesShown == null && kBook.bid != null && kBook.ask != null) wideBook.kalshi++;
        if (pYesShown !== pYes) priceFromBook.poly++;
        if (kYesShown !== row.k_yes_price) priceFromBook.kalshi++;

        // How long the capital is committed for. Read here so both the
        // arb figures and the card can use it; null when Kalshi states
        // no close_time, which must NOT render as "settles today" or
        // every long-dated arb would look urgent.
        const closeDays = daysUntil(row.k_close_time);

        const arb = tradeableArb(
          {
            yesAsk: kBook.ask,
            noAsk:  kNoBook.ask,
            // Kalshi publishes size on the YES book only; taking NO at
            // no_ask is backed by the YES bid queue.
            yesAskSize: row.k_ask_size,
            yesBidSize: row.k_bid_size,
            feeMultiplier: row.k_fee_multiplier,
          },
          {
            yesAsk: polyBook.ask,
            // The other side of a binary CLOB: buying the complement.
            noAsk:  polyOtherBook.ask,
            yesAskSize: isPolyUs ? row.p_ask_size : null,
            yesBidSize: isPolyUs ? row.p_bid_size : null,
            feeSchedule: row.p_fee_schedule || null,
          }
        );

        if (arb == null) noExecutablePrice++;

        // The two venues pricing the same claim 80 points apart is not
        // an arbitrage. Live example: Kalshi had Delcy Rodriguez at
        // 0.89/0.92 to be Venezuela's de facto head of state - a price
        // consistent with the rest of its own outcome set, which sums to
        // 1.15 - while Polymarket priced the identical-reading claim at
        // 0.095. Executable pricing called that a 78c edge.
        //
        // This guard already existed in pages/index.js, so the site did
        // not render it. But it only existed there: the API published
        // profitable: true, and every other consumer - v2, any future
        // client, and the checks in this session - believed it. A
        // safety rule that lives in one client is not a safety rule.
        // Measured on the numbers the CARD SHOWS — the book mids — not on
        // the stored last-trade figures. Judging a displayed pair by
        // prices the reader cannot see is how a card ends up flagged, or
        // not flagged, for reasons nothing on screen explains.
        const spreadPts = Math.abs((kYesShown ?? 0) - (pYesShown ?? 0)) * 100;
        const implausible = spreadPts > IMPLAUSIBLE_SPREAD_PTS;
        if (implausible && arb?.r?.profitable) implausibleArbs++;

        return {
          // `id` is the KALSHI id and is no longer unique per row: with
          // both Polymarket exchanges paired, one Kalshi market yields
          // two pairs. Anything keying on it (React lists included) will
          // collide and reuse the wrong row, so pairs carry their own
          // identity as well.
          _implausible: implausible,
          _spreadPts: spreadPts,
          // Carried only so the live depth re-check can ask the CLOB
          // for this leg's book. The ID, not the slug: `markets.slug`
          // holds the EVENT slug on polymarket.com and gamma's ?slug=
          // filter wants a market slug, so slugs return nothing.
          // Stripped with the other underscore fields before the
          // response is built.
          _polyId: row.polymarket_id || null,
          _polyIdx: idx,
          pairId: `${row.kalshi_id}|${row.polymarket_id}`,
          id: row.kalshi_id,
          title: cleanTitle(row.k_title),
          polyTitle: cleanTitle(row.p_title),
          similarity: row.similarity,
          // Never cleaned or truncated. This is the contract text, and
          // the whole reason to show it is so the reader can check the
          // two venues against each other rather than trust the match.
          resolution: row.k_resolution || null,
          polyResolution: row.p_resolution || null,
          category: row.k_sport_tag,
          _gameDate: extractTickerDate(row.kalshi_id),
          // How old the WORSE leg is. A pair is only as current as its
          // stalest side, and the reader is comparing the two, so one
          // fresh leg does not make the comparison fresh. Null when the
          // migration adding these columns has not run - the client then
          // says nothing rather than claiming an age it does not have.
          priceAgeSeconds: ageSeconds(row.k_updated_at, row.p_updated_at),
          kalshi: {
            yes: kYesShown, no: kYesShown == null ? row.k_no_price : 1 - kYesShown, volume: row.k_volume ?? null, url: kalshiUrl,
            bid: kBook.bid ?? null, ask: kBook.ask ?? null,
            noBid: kNoBook.bid ?? null, noAsk: kNoBook.ask ?? null,
            ageSeconds: ageSeconds(row.k_updated_at),
          },
          poly: {
            // `?? null`, NOT `|| 0`. polymarket.us publishes no volume field
            // at all, and `|| 0` turned that into a reported zero — which
            // reads as "nobody has traded this", a claim about the market
            // rather than about our data. null is the honest answer and is
            // what polyDollars() already filters on.
            yes: pYesShown, no: pYesShown == null ? null : 1 - pYesShown, volume: row.p_volume ?? null, url: polyUrl,
            bid: polyBook.bid ?? null, ask: polyBook.ask ?? null,
            venue: polyVenue,
            ageSeconds: ageSeconds(row.p_updated_at),
            // A US account can trade polymarket.us and not
            // polymarket.com. The site should say which, rather than
            // leaving the reader to infer it from a hostname.
            usTradable: isPolyUs,
          },
          // null means "no executable price on at least one leg", which
          // is a different answer from "no edge" and must not render as
          // a zero.
          arb: arb ? {
            side: arb.side,
            cost: Math.round(arb.r.total * 10000) / 10000,
            edge: Math.round(arb.r.edge * 10000) / 10000,
            // Both conditions. A wide cross-venue disagreement is a data
            // or semantics problem, not free money — see IMPLAUSIBLE_SPREAD.
            profitable: arb.r.profitable && !implausible,
            // An edge with no size is not a finding. maxContracts is an
            // UPPER bound: Polymarket publishes no depth, so the smaller
            // of the two legs may be smaller still — depthKnown says so.
            maxContracts: arb.maxContracts,
            depthKnown: arb.depthKnown,
            // What each leg costs, fees included. twoLegArb already
            // computes these; surfacing them is what lets the card
            // explain a total instead of asserting it. Derived HERE
            // rather than in the client for the same reason the leg
            // merging is: a second place to do this maths is a first
            // place for it to disagree with the number beside it.
            breakdown: [
              arb.side === "kalshi-yes/poly-no"
                ? { venue: "Kalshi", side: "YES", cost: Math.round(arb.r.costA * 10000) / 10000 }
                : { venue: polyVenue, side: "YES", cost: Math.round(arb.r.costA * 10000) / 10000 },
              arb.side === "kalshi-yes/poly-no"
                ? { venue: polyVenue, side: "NO", cost: Math.round(arb.r.costB * 10000) / 10000 }
                : { venue: "Kalshi", side: "NO", cost: Math.round(arb.r.costB * 10000) / 10000 },
            ],
            // THE CALCULATOR'S INPUTS, not its answers.
            //
            // A reader who sees an edge asks what they would make, and
            // that cannot be `edge x contracts`: Kalshi rounds its fee
            // up to the cent PER ORDER, so cost per pair genuinely
            // moves with size, and the cheaper of the two directions
            // can differ between a small order and a large one. The
            // client therefore re-runs positionAtSize() from
            // lib/fees.js — the same function this route uses — over
            // these inputs, rather than scaling a number.
            //
            // Sending inputs instead of a precomputed table is what
            // keeps one copy of the maths. A second implementation in
            // the client is a second place for it to drift, which is
            // exactly how the implausible-spread guard ended up
            // suppressing a bad pair on the page while this route went
            // on publishing `profitable: true` for it.
            //
            // Only sent when the pair is takeable at all; a leg with no
            // executable price has nothing to size.
            inputs: {
              kalshi: {
                yesAsk: kBook.ask, noAsk: kNoBook.ask,
                yesAskSize: row.k_ask_size, yesBidSize: row.k_bid_size,
                feeMultiplier: row.k_fee_multiplier,
              },
              poly: {
                yesAsk: polyBook.ask, noAsk: polyOtherBook.ask,
                yesAskSize: isPolyUs ? row.p_ask_size : null,
                yesBidSize: isPolyUs ? row.p_bid_size : null,
                feeSchedule: row.p_fee_schedule || null,
              },
            },
            // The edge is now priced AT `pricedAt`, so this multiplies a
            // per-contract figure that is true at the size on offer
            // rather than at a 100-contract order the book cannot fill.
            edgeDollars: arb.maxContracts != null
              ? Math.round(arb.r.edge * arb.maxContracts * 100) / 100
              : null,
            // What size the headline figures were priced at, so the
            // card and the calculator can be seen to agree instead of
            // differing by a rounding artefact the reader cannot place.
            pricedAt: arb.pricedAt,
            // AN EDGE IS NOT A RETURN UNTIL YOU DIVIDE BY TIME, and
            // `edgeDollars` alone is the number that misleads: it is
            // the profit with no mention of the capital it consumes
            // or how long that capital is gone for.
            //
            // A matched pair pays $1 at settlement and costs `cost`
            // now, so the capital IS the cost. Measured live: the
            // largest edge on the site is "$461.77", which is $36,480
            // locked for 144 days — 3.2% a year, worse than a
            // Treasury bill. One is $14,346 locked for 789 DAYS at
            // 0.7%. Both read as free money without this.
            daysToResolve: closeDays,
            annualizedPct: annualizedReturn(arb.r.edge, arb.r.total, closeDays),
            ...(implausible ? { implausible: true, spreadPts: Math.round(spreadPts * 10) / 10 } : {}),
          } : null,
          trending: ((row.k_volume || 0) + (row.p_volume || 0)) > 5000,
        };
      })
      .filter(m => {
        // Why a pair vanished between `pairs` and the page is otherwise
        // invisible: an empty tab looks identical whether nothing
        // matched, everything is priced outside the band, or every
        // fixture has already been played. ?debug=1 reports the split.
        //
        // The sample is capped PER REASON, not in total. One cap
        // across all five let the first reason encountered fill it —
        // and the reason worth reading is `implausibleSpread`, which
        // is the matcher failing rather than the product working, so
        // it was the one you could never see. Auditing those pairs is
        // the only way to tell a negation from a wrong threshold from
        // a genuinely ambiguous claim, and it needs the whole list,
        // not five rows of whatever sorted first.
        //
        // Only collected under ?debug=1, so a normal request pays
        // nothing for it.
        const note = r => {
          dropped[r]++;
          if (wantDebug && (sampleByReason[r] = sampleByReason[r] || []).length < DEBUG_SAMPLE_PER_REASON) {
            sampleByReason[r].push({
              reason: r, id: m.id, title: (m.title || "").slice(0, 110),
              polyTitle: (m.polyTitle || "").slice(0, 110),
              similarity: m.similarity,
              k: m.kalshi.yes, p: m.poly.yes,
              spreadPts: Math.round(m._spreadPts * 10) / 10,
              venue: m.poly.venue,
              gameDate: m._gameDate ? m._gameDate.toISOString().slice(0, 10) : null,
            });
          }
          return false;
        };
        if (!m.kalshi.yes || !m.poly.yes)                   return note("missingPrice");
        if (m.kalshi.yes <= 0.05 || m.kalshi.yes >= 0.95)   return note("kalshiOutOfBand");
        if (m.poly.yes   <= 0.05 || m.poly.yes   >= 0.95)   return note("polyOutOfBand");
        if (m._gameDate && m._gameDate.getTime() < todayMs) return note("expired");
        // TWO VENUES DO NOT DISAGREE BY 15 POINTS ON THE SAME CLAIM.
        //
        // Suppressing the arb badge was not enough. The card still
        // rendered "Kalshi 92% / Polymarket 10%" side by side, and a
        // reader who sees that concludes the site is broken — which
        // costs more trust than showing nothing would, and is the
        // correct conclusion, because the pair IS wrong.
        //
        // Every one read by hand was a matching fault rather than an
        // edge: "meet before 2027" against "NOT meet before 2027",
        // "Red wave" against "Blue wave", a national House count
        // against an Arizona one. The gap is the evidence, not the
        // finding.
        if (m._implausible) return note("implausibleSpread");
        return true;
      });

    // The depth re-checks read `_polyId` / `_polyIdx`, so the
    // underscore fields are stripped AFTER them, not before.
    const [depthCheck, polyDepthCheck] = await Promise.all([
      verifyKalshiDepth(shaped),
      verifyPolyDepth(shaped),
    ]);
    for (const m of shaped) {
      delete m._gameDate; delete m._implausible; delete m._spreadPts;
      delete m._polyId; delete m._polyIdx;
    }

    const priced = shaped.filter(m => m.arb).length;
    // After the depth re-check, so every leg carries its final numbers.
    const allCards = mergeByKalshiMarket(shaped);

    // Per-tab counts, computed on the FULL set before any trim, so the
    // home page's "Politics 373" is the number that tab will show —
    // not the number that survived a top-N cut.
    const byCategory = {};
    for (const c of allCards) {
      const tab = CATEGORY_OF_TAG[c.category] || c.category;
      byCategory[tab] = (byCategory[tab] || 0) + 1;
    }

    // ?top=N — the home page's "most traded", and the reason it can ask
    // for every category at once without moving a megabyte of politics.
    //
    // Ranked by KALSHI CONTRACTS, which is the one figure every card
    // has: Polymarket reports dollars and polymarket.us reports nothing,
    // so a cross-venue "volume" would be three units added together.
    // The home page says "most traded on Kalshi" for exactly this
    // reason rather than claiming a total.
    const byVolume = (a, b) => (b.kalshi?.volume || 0) - (a.kalshi?.volume || 0);
    const top = Math.max(0, parseInt(req.query.top, 10) || 0);
    // ?perCategory=N caps EACH tab before the overall ranking.
    //
    // A straight global top-12 was 11 politics and 1 economics — not a
    // fault, because a presidential-nomination market trades millions of
    // contracts where a ball game trades thousands, but a front door
    // that shows one category is a poor map of a four-category site.
    // Capping per tab first, then ranking what survives, keeps the
    // ordering honest while making the page representative.
    const perCategory = Math.max(0, parseInt(req.query.perCategory, 10) || 0);

    // US-TRADABLE FIRST, AND THAT DECISION BELONGS HERE.
    //
    // The home page shows one card per category and wants the
    // most-traded market its reader can ACT on, so it looked for the
    // first US-tradable card in what this route returned. With
    // perCategory=3 that search ran over a three-card window — and
    // measured 2026-09-07, the first US-tradable politics card sits at
    // index 4 and crypto's at index 8. Neither window could contain
    // one, so the page fell back to an untradable card on categories
    // that have 38 and 3 US-tradable markets respectively.
    //
    // That is a selection made over a pre-truncated set and reported as
    // if it were made over the whole set — the same shape as the
    // embedding read that decided a spend from a capped query. The cure
    // is to rank BEFORE the cap, not to widen the window and hope.
    //
    // Volume still orders within each group, so the caption ("most
    // traded on Kalshi") stays true of what leads each category; US
    // legs simply sort ahead of global-only ones.
    const hasUsLeg = c => (c.legs || []).some(l => l?.poly?.usTradable);
    const usFirstThenVolume = (a, b) => {
      const ua = hasUsLeg(a), ub = hasUsLeg(b);
      if (ua !== ub) return ua ? -1 : 1;
      return byVolume(a, b);
    };

    let cards = allCards;
    if (perCategory) {
      const kept = {};
      cards = [...allCards]
        .sort(usFirstThenVolume)
        .filter(c => {
          const tab = CATEGORY_OF_TAG[c.category] || c.category;
          kept[tab] = (kept[tab] || 0) + 1;
          return kept[tab] <= perCategory;
        });
    }
    if (top) cards = [...cards].sort(byVolume).slice(0, top);

    // 30 SECONDS WAS 60x SHORTER THAN THE DATA IT CACHES.
    //
    // A TTL is a claim about how often the answer changes. Prices here
    // come from a scheduled job GitHub throttles to between 45 minutes
    // and 3.5 hours, with an on-demand read that fires at most once per
    // ON_DEMAND_AFTER_SECONDS (180) when someone is actually looking.
    // So the fastest this response can change is ~3 minutes, and the
    // usual case is hours — while the page polls every 60s.
    //
    // At 30s that is two origin reads a minute per viewing category, and
    // the politics payload is 874KB: ONE continuously-open tab was ~75GB
    // of Supabase egress a month against a 5GB free-tier allowance. The
    // reads bought nothing, because the bytes were identical.
    //
    // 300s is still shorter than the interval at which the underlying
    // job can produce new numbers, so nobody sees a staler page than
    // they did before — they see the same numbers fetched 10x less.
    //
    // The manual ↻ path bypasses this by asking a different url; see
    // fetchMarkets() in pages/index.js. Without that, a refresh would
    // write new prices and then be served the copy cached before the
    // write, which is a refresh button that only looks like one.
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    res.status(200).json({
      // One entry per Kalshi market; the Polymarket venues are `legs`
      // inside it. `pairs` remains the key because that is what a
      // reader of this response is counting, but the shape is now a
      // card, and `pairCount` says how many stored pairs it took.
      pairs: cards,
      pairCount: shaped.length,
      byCategory,
      // What the reader is looking at versus what exists, so a trimmed
      // response can never be mistaken for the whole set.
      cardCount: allCards.length,
      // NAMED, not a boolean and not the cap number. Which category hit
      // the wall is the whole question — and referencing a constant that
      // no longer existed would have thrown at exactly the moment this
      // needed to report something.
      ...(pairsTruncated ? { pairsTruncated } : {}),
      trimmedTo: top || null,
      perCategory: perCategory || null,
      needsEmbed: cards.length === 0,
      // A claim about the numbers actually in this response, not about
      // what the code is capable of. Before migration 0004 is run there
      // are no books to price, every `arb` is null, and answering
      // `true` here would assert fee-inclusive figures that do not
      // exist.
      feesIncluded: priced > 0,
      priceFromBook,
      wideBookSuppressed: wideBook,
      pricing: {
        priced,
        noExecutablePrice,
        // Live size re-check on the takeable pairs. `corrected` counts
        // how many had a stored depth that no longer held.
        depthChecked: depthCheck.checked,
        depthCorrected: depthCheck.corrected || 0,
        // The Polymarket half, reported separately. A polymarket.com
        // leg had no size at all until the CLOB book was wired in, and
        // most of the site's profitable legs are on that venue — so a
        // combined counter would hide which side is actually verified.
        polyDepthChecked: polyDepthCheck.checked || 0,
        polyDepthCorrected: polyDepthCheck.corrected || 0,
        ...(polyDepthCheck.errors?.length ? { polyDepthErrors: polyDepthCheck.errors } : {}),
        // Pairs whose maths says profitable but whose cross-venue gap
        // says "look at the data instead". Worth watching: a rising
        // count means matching quality is slipping.
        implausibleArbs,
        ...(priced === 0 && shaped.length > 0
          ? { notice: "no book data - run supabase/migrations/0004_bid_ask_and_fees.sql" }
          : {}),
      },
      // Why a pair is stored but not on screen, promoted out of
      // ?debug=1 and into the normal response. A thin tab is honest
      // work here - econ is 6 verified pairs out of 2,208 Kalshi
      // markets because precision is the product - but a reader cannot
      // tell "we found almost nothing" from "we found things and hid
      // them", and the difference decides whether they trust the tab.
      hidden: {
        longShots: dropped.kalshiOutOfBand + dropped.polyOutOfBand,
        // Named separately from longShots on purpose: a long shot is the
        // product working, this is the matcher failing, and folding them
        // together would hide a defect inside an expected number.
        implausibleSpread: dropped.implausibleSpread,
        expired: dropped.expired,
        missingPrice: dropped.missingPrice,
        total: data.length - shaped.length,
      },
      ...(req.query.debug === "1"
        ? { debug: { rowsFromRpc: data.length, dropped, sampleByReason } }
        : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
