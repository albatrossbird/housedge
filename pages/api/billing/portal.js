// POST -> { url } of Stripe's customer portal: card, invoices, switching
// plan and cancelling, all on Stripe's side. Changes come back as webhooks.
import { buyer } from "../../../lib/billing/buyer.js";
import { stripe } from "../../../lib/billing/stripe.js";

export default async function handler(req, res) {
  try {
    const b = await buyer(req, res);
    if (b.error) return res.status(b.status).json({ error: b.error });
    if (!b.profile.stripe_customer_id) return res.status(404).json({ error: "No billing yet: nothing has been bought on this account." });
    const s = await stripe("POST", "/billing_portal/sessions", { customer: b.profile.stripe_customer_id, return_url: `${b.site}/account` });
    return res.status(200).json({ url: s.url });
  } catch (e) {
    return res.status(502).json({ error: `billing portal unavailable: ${e.message}` });
  }
}
