import { createClient } from "@supabase/supabase-js";
import { polyOutcomeIndex } from "../../lib/sportsKeys.js";
import { bestArb, complementBook } from "../../lib/fees.js";
import { cleanTitle, polymarketUsUrl, polymarketComUrl } from "../../lib/titles.js";

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
  sports:    ["soccer", "nba", "nhl", "mlb", "nfl"],
  economics: ["econ"],
  crypto:    ["crypto"],
  politics:  ["politics"],
};

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
    return Math.round(((b + a) / 2) * 10000) / 10000;
  }
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
    const { data, error } = await supabase.rpc("get_pairs", {
      sport_tags: tags,
    });

    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(200).json({ pairs: [], needsEmbed: true });
    }

    const dropped = { missingPrice: 0, kalshiOutOfBand: 0, polyOutOfBand: 0, expired: 0 };
    // How often the shown price came from the book rather than the
    // stored last-trade figure. A large poly number is the bug this
    // replaced still being present in the data.
    const priceFromBook = { kalshi: 0, poly: 0 };
    let noExecutablePrice = 0;
    let implausibleArbs = 0;
    const sampleDropped = [];

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
        const rawPolyBook = { bid: row.p_bid, ask: row.p_ask };
        const polyBook = polyOnOutcome1
          ? complementBook(row.p_bid, row.p_ask)
          : rawPolyBook;
        const polyOtherBook = polyOnOutcome1
          ? rawPolyBook
          : complementBook(row.p_bid, row.p_ask);

        // Display the mid of the book this leg actually trades on.
        // polyBook is already index-aware, so this cannot quote the
        // opponent's side the way the raw book would.
        const pYesShown = bookMid(polyBook.bid, polyBook.ask, pYes);
        const kYesShown = bookMid(row.k_bid, row.k_ask, row.k_yes_price);
        if (pYesShown !== pYes) priceFromBook.poly++;
        if (kYesShown !== row.k_yes_price) priceFromBook.kalshi++;

        const arb = bestArb(
          {
            yesAsk: row.k_ask,
            noAsk:  row.k_no_ask,
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
        const spreadPts = Math.abs((row.k_yes_price ?? 0) - (pYes ?? 0)) * 100;
        const implausible = spreadPts > IMPLAUSIBLE_SPREAD_PTS;
        if (implausible && arb?.r?.profitable) implausibleArbs++;

        return {
          // `id` is the KALSHI id and is no longer unique per row: with
          // both Polymarket exchanges paired, one Kalshi market yields
          // two pairs. Anything keying on it (React lists included) will
          // collide and reuse the wrong row, so pairs carry their own
          // identity as well.
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
            bid: row.k_bid ?? null, ask: row.k_ask ?? null,
            noBid: row.k_no_bid ?? null, noAsk: row.k_no_ask ?? null,
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
            edgeDollars: arb.maxContracts != null
              ? Math.round(arb.r.edge * arb.maxContracts * 100) / 100
              : null,
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
        const note = r => {
          dropped[r]++;
          if (sampleDropped.length < 5) {
            sampleDropped.push({
              reason: r, id: m.id, title: (m.title || "").slice(0, 70),
              k: m.kalshi.yes, p: m.poly.yes,
              gameDate: m._gameDate ? m._gameDate.toISOString().slice(0, 10) : null,
            });
          }
          return false;
        };
        if (!m.kalshi.yes || !m.poly.yes)                   return note("missingPrice");
        if (m.kalshi.yes <= 0.05 || m.kalshi.yes >= 0.95)   return note("kalshiOutOfBand");
        if (m.poly.yes   <= 0.05 || m.poly.yes   >= 0.95)   return note("polyOutOfBand");
        if (m._gameDate && m._gameDate.getTime() < todayMs) return note("expired");
        return true;
      })
      .map(({ _gameDate, ...m }) => m);

    const depthCheck = await verifyKalshiDepth(shaped);
    const priced = shaped.filter(m => m.arb).length;
    // After the depth re-check, so every leg carries its final numbers.
    const cards = mergeByKalshiMarket(shaped);

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
      needsEmbed: cards.length === 0,
      // A claim about the numbers actually in this response, not about
      // what the code is capable of. Before migration 0004 is run there
      // are no books to price, every `arb` is null, and answering
      // `true` here would assert fee-inclusive figures that do not
      // exist.
      feesIncluded: priced > 0,
      priceFromBook,
      pricing: {
        priced,
        noExecutablePrice,
        // Live size re-check on the takeable pairs. `corrected` counts
        // how many had a stored depth that no longer held.
        depthChecked: depthCheck.checked,
        depthCorrected: depthCheck.corrected || 0,
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
        expired: dropped.expired,
        missingPrice: dropped.missingPrice,
        total: data.length - shaped.length,
      },
      ...(req.query.debug === "1"
        ? { debug: { rowsFromRpc: data.length, dropped, sampleDropped: sampleDropped.slice(0, 5) } }
        : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
