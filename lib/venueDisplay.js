// Which Polymarket legs a card shows under the US venue filter.
//
// The filter used to DROP every global leg, on the principle that a
// site should not show a reader a price they cannot take. That
// principle is right as a default and wrong as an absolute, and the
// measurement is what settles it: of the profitable legs the site
// finds, 43 of 52 are polymarket.com only. Filtering them away removes
// most of the arbitrage signal for the readers most motivated to use it
// — a US trader with a VPN is a large and deliberate cohort
// (polymarket.com traded $9B in April 2026 against polymarket.us's
// $1.3B), not an edge case.
//
// The other direction is just as real: on the 94 cards that carry both
// legs, the median gap between the two venues' prices is 0.6 POINTS. A
// third bar that repeats the second one to within six tenths of a point
// costs a glance on every card and answers nothing, and re-introduces
// the "which of these is mine?" question that merging the two cards
// into legs was built to end.
//
// So a global leg earns its row by saying something:
//
//   * it is the ONLY leg — there is no US market, which is itself the
//     answer to "can I trade this", and 74% of cards are in this state;
//   * it prices at least MATERIAL_GAP_PTS away from the US leg;
//   * it carries a profitable arb.
//
// Otherwise it collapses to one line of text naming the venue and the
// gap, so nothing is hidden — only de-emphasised.
//
// THE ARB CLAUSE IS NOT REDUNDANT WITH THE GAP CLAUSE, and that is the
// whole reason it exists. An arb comes from the KALSHI-to-Polymarket
// gap, not from the US-to-global one, so a global leg can sit within
// half a point of its US sibling and still be the profitable side of
// the card. A materiality rule keyed only on the venue gap would
// collapse exactly the leg a reader wants. Sizes are deliberately NOT
// part of the test — the card states the size, and hiding a real edge
// because it is small is a judgement the reader should make.
export const MATERIAL_GAP_PTS = 2;

const isUs = leg => !!leg?.poly?.usTradable;
const yesPct = leg => {
  const v = Number(leg?.poly?.yes);
  return isFinite(v) ? v * 100 : null;
};
const hasArb = leg => !!(leg?.arb && leg.arb.profitable);

// Returns the legs to render plus, when one was collapsed, what to say
// about it. `collapsed` is null when nothing was hidden, so a caller
// can render the note purely on its presence.
export function legsForUsView(legs, { materialGapPts = MATERIAL_GAP_PTS } = {}) {
  const all = Array.isArray(legs) ? legs : [];
  const us = all.filter(isUs);
  const global = all.filter(l => !isUs(l));

  // NO US MARKET MEANS NO ROWS UNDER THE US FILTER.
  //
  // Returning the global leg here looks generous and quietly breaks the
  // control: the filter would stop meaning "what a US account can
  // trade" and the tab would show every card, which is measurable —
  // it put "Markets compared 662" under a filter whose own chip read
  // "US 207".
  //
  // The front door's fallback is a deliberate exception to this and
  // handles itself: it only calls this function for a card that HAS a
  // US leg, and when a whole category has none it renders the global
  // card untouched and FLAGGED, rather than leaving a reader to infer
  // it from a venue label.
  if (!us.length) return { legs: [], collapsed: null };
  if (!global.length) return { legs: us, collapsed: null };

  // Compare against the US leg the card leads with.
  const usPct = yesPct(us[0]);

  const kept = [];
  const hidden = [];
  for (const g of global) {
    const gPct = yesPct(g);
    const gap = usPct == null || gPct == null ? null : Math.abs(gPct - usPct);
    // An UNREADABLE gap is not a small one. If either side has no
    // price, we cannot claim the two agree, so the leg is shown.
    if (gap == null || gap >= materialGapPts || hasArb(g)) kept.push(g);
    else hidden.push({ leg: g, gap });
  }

  if (!hidden.length) return { legs: [...us, ...kept], collapsed: null };

  const closest = hidden.reduce((a, b) => (b.gap < a.gap ? b : a));
  return {
    legs: [...us, ...kept],
    collapsed: {
      count: hidden.length,
      gapPts: Math.round(closest.gap * 10) / 10,
    },
  };
}
