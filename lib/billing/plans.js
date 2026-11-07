// What can be bought, at what price. Read by the pricing page (in the
// browser), by checkout, and by the webhook — one list, so the price a
// reader is shown is the price Stripe charges.
//
// Prices live HERE, not in the Stripe dashboard. lib/billing/stripe.js
// creates each Stripe Price on first use, keyed by `lookupKey`, which
// carries the amount: changing an amount below makes a NEW Stripe price for
// new buyers, and every existing subscription stays on the price it was sold
// at until it is moved by hand. That is the founding-price lock, for free.
//
// `plan` is the profiles.plan a subscription grants (migration 0033); the
// day pass grants pass_until instead, so it never overwrites a plan.
export const CATALOG = {
  ev:       { key: "ev",       plan: "ev",  product: "ms_ev",   name: "+EV",        amount: 3900,  interval: "month" },
  arb:      { key: "arb",      plan: "arb", product: "ms_arb",  name: "Arbitrage",  amount: 3900,  interval: "month" },
  pro:      { key: "pro",      plan: "pro", product: "ms_pro",  name: "Sports Pro", amount: 5900,  interval: "month" },
  pro_year: { key: "pro_year", plan: "pro", product: "ms_pro",  name: "Sports Pro", amount: 49900, interval: "year" },
  pass:     { key: "pass",     plan: null,  product: "ms_pass", name: "Day pass",   amount: 900,   hours: 24 },
};

export const PRODUCT_NAMES = {
  ms_ev: "MarketSlap +EV",
  ms_arb: "MarketSlap Arbitrage",
  ms_pro: "MarketSlap Sports Pro",
  ms_pass: "MarketSlap Day Pass",
};

export const lookupKey = item => `ms_${item.key}_${item.amount}`;
export const isSubscription = item => Boolean(item?.interval);
export const dollars = cents => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
