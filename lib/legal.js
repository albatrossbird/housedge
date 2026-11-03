// The facts the Terms and Privacy pages are written around. Fill in the
// blanks here, not in the pages: one place, so the two cannot disagree.
//
// state: where MarketSlap LLC was formed (Virginia), for governing law. If null
// the pages say so visibly rather than inventing one.
export const LEGAL = {
  entity: "MarketSlap LLC",
  site: "marketslap.com",
  email: "support@marketslap.com",
  state: "the Commonwealth of Virginia",
  effective: "November 3, 2026",
};
export const stateName = () => LEGAL.state || "[STATE OF FORMATION — to be filled in]";
