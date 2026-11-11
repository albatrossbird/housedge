// POST { plan: "arb" | "arb_year" | "pro" | "pro_year" | "pass" } -> { url } of a
// Stripe Checkout page. Nothing here grants anything: the plan changes only
// when Stripe says it was paid (the webhook, or /api/billing/confirm).
import { buyer } from "../../../lib/billing/buyer.js";
import { stripe, ensurePrice } from "../../../lib/billing/stripe.js";
import { ensureCustomer } from "../../../lib/billing/sync.js";
import { CATALOG, isSubscription, isOffered } from "../../../lib/billing/plans.js";
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
    if (isSubscription(item) && ent.plan !== "free" && profile.stripe_customer_id) {
      return res.status(409).json({ error: "You already have a plan. Change it from Manage billing.", manage: true });
    }
    // A pass beside a running pass is allowed: they stack (lib/billing/sync.js).
    if (!isSubscription(item) && ent.plan === "pro") {
      return res.status(409).json({ error: "Pro already includes everything a day pass unlocks." });
    }
    const customer = await ensureCustomer(profile);
    const price = await ensurePrice(item.key);
    const meta = { profile_id: profile.id, ms_key: item.key };
    const session = await stripe("POST", "/checkout/sessions", {
      mode: isSubscription(item) ? "subscription" : "payment",
      customer,
      client_reference_id: profile.id,
      line_items: [{ price, quantity: 1 }],
      allow_promotion_codes: true,
      metadata: meta,
      ...(isSubscription(item) ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: meta } }),
      success_url: `${site}/account?checkout=done&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/pricing`,
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(502).json({ error: `checkout unavailable: ${e.message}` });
  }
}
