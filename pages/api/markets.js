import { createClient } from "@supabase/supabase-js";
import { polyOutcomeIndex } from "../../lib/sportsKeys.js";
import { bestArb, complementBook } from "../../lib/fees.js";

// Beyond this gap the two venues are not pricing the same thing, and
// the difference is a matching or data fault rather than an edge.
const IMPLAUSIBLE_SPREAD_PTS = 15;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const SPORT_TAGS = {
  sports:    ["soccer", "nba", "nhl", "mlb"],
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

export default async function handler(req, res) {
  const category = req.query.category || "sports";
  const tags = SPORT_TAGS[category];
  if (!tags) return res.status(400).json({ error: `Unknown category: ${category}` });

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
        const polyUrl = row.p_slug ? `https://polymarket.com/event/${row.p_slug}` : "https://polymarket.com/";

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
          id: row.kalshi_id,
          title: row.k_title,
          polyTitle: row.p_title,
          similarity: row.similarity,
          category: row.k_sport_tag,
          _gameDate: extractTickerDate(row.kalshi_id),
          kalshi: {
            yes: row.k_yes_price, no: row.k_no_price, volume: row.k_volume || 0, url: kalshiUrl,
            bid: row.k_bid ?? null, ask: row.k_ask ?? null,
            noBid: row.k_no_bid ?? null, noAsk: row.k_no_ask ?? null,
          },
          poly: {
            yes: pYes, no: 1 - pYes, volume: row.p_volume || 0, url: polyUrl,
            bid: polyBook.bid ?? null, ask: polyBook.ask ?? null,
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

    const priced = shaped.filter(m => m.arb).length;

    res.setHeader("Cache-Control", "s-maxage=30");
    res.status(200).json({
      pairs: shaped,
      needsEmbed: shaped.length === 0,
      // A claim about the numbers actually in this response, not about
      // what the code is capable of. Before migration 0004 is run there
      // are no books to price, every `arb` is null, and answering
      // `true` here would assert fee-inclusive figures that do not
      // exist.
      feesIncluded: priced > 0,
      pricing: {
        priced,
        noExecutablePrice,
        // Pairs whose maths says profitable but whose cross-venue gap
        // says "look at the data instead". Worth watching: a rising
        // count means matching quality is slipping.
        implausibleArbs,
        ...(priced === 0 && shaped.length > 0
          ? { notice: "no book data - run supabase/migrations/0004_bid_ask_and_fees.sql" }
          : {}),
      },
      ...(req.query.debug === "1"
        ? { debug: { rowsFromRpc: data.length, dropped, sampleDropped: sampleDropped.slice(0, 5) } }
        : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
