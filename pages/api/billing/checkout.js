// POST { plan: "arb" | "arb_year" | "pro" | "pro_year" | "pass" | "trial" } -> { url } of a
// Stripe Checkout page. Nothing here grants anything: the plan changes only
// when Stripe says it was paid (the webhook, or /api/billing/confirm).
import { buyer } from "../../../lib/billing/buyer.js";
import { stripe, ensurePrice } from "../../../lib/billing/stripe.js";
import { ensureCustomer } from "../../../lib/billing/sync.js";
import { CATALOG, isSubscription, isOffered, isTrial } from "../../../lib/billing/plans.js";
import { entitlementsOf } from "../../../lib/entitlements.js";

export default async function handler(req, res) {
  try {
    const b = await buyer(req, res);
    if (b.error) return res.status(b.status).json({ error: b.error });
    const item = CATALOG[req.body?.plan];
    if (!isOffered(item)) return res.status(400).json({ error: "unknown plan" });
    const { profile, site } = b;
    const ent = entitlementsOf(profile);
    // One subscription per account: a second would bill twice for what the
    // first already grants. Switching goes through Stripe's portal, which
    // prorates.
    const recurring = isSubscription(item) || isTrial(item);
    if (recurring && ent.plan !== "free" && profile.stripe_customer_id) {
      return res.status(409).json({ error: "You already have a plan. Change it from Manage billing.", manage: true });
    }
    // A pass beside a running pass is allowed: they stack (lib/billing/sync.js).
    if (!recurring && ent.plan === "pro") {
      return res.status(409).json({ error: "Pro already includes everything a day pass unlocks." });
    }
    const customer = await ensureCustomer(profile);
    const meta = { profile_id: profile.id, ms_key: item.key };
    let mode, lineItems, extra;
    if (isTrial(item)) {
      // One trial per account: anyone who has ever subscribed, trial
      // included, is refused, whatever has happened since.
      const prior = await stripe("GET", "/subscriptions", { customer, status: "all", limit: 1 });
      if (prior.data?.length) return res.status(409).json({ error: "The $1 trial is for new members. Pick a plan instead." });
      // The plan's recurring price with Stripe's trial, plus the $1 as a
      // one-time item on the first invoice. Checkout shows the date the
      // full price starts.
      const [plan, fee] = await Promise.all([ensurePrice(item.converts), ensurePrice(item.key)]);
      mode = "subscription";
      lineItems = [{ price: plan, quantity: 1 }, { price: fee, quantity: 1 }];
      extra = { subscription_data: { trial_period_days: item.trialDays, metadata: meta } };
    } else {
      mode = isSubscription(item) ? "subscription" : "payment";
      lineItems = [{ price: await ensurePrice(item.key), quantity: 1 }];
      extra = isSubscription(item) ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: meta } };
    }
    const session = await stripe("POST", "/checkout/sessions", {
      mode,
      customer,
      client_reference_id: profile.id,
      line_items: lineItems,
      // A promotion code on top of a $1 trial is a discount on a discount.
      allow_promotion_codes: isTrial(item) ? undefined : true,
      metadata: meta,
      ...extra,
      success_url: `${site}/account?checkout=done&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/pricing`,
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(502).json({ error: `checkout unavailable: ${e.message}` });
  }
}
