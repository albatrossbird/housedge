import { createClient } from "@supabase/supabase-js";
import { polyOutcomeIndex } from "../../lib/sportsKeys.js";
import { bestArb, complementBook } from "../../lib/fees.js";

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

        // Kalshi's site only reliably resolves the series-level page
        // (e.g. kalshi.com/markets/kxgdp) - a combined series+event+
        // strike ticker as one path segment (what this used to build)
        // 404s. The event-level URL needs a human-readable slug we
        // don't have (e.g. "annual-gdp", not the raw ticker), so this
        // links to the series page rather than guessing at that.
        const seriesTicker = (row.kalshi_id || "").split("-")[0];
        const kalshiUrl = seriesTicker
          ? `https://kalshi.com/markets/${seriesTicker.toLowerCase()}`
          : "https://kalshi.com/";
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
            profitable: arb.r.profitable,
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
