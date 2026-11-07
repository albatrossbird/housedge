// POST { session_id } from the account page after Checkout returns: apply
// that purchase now instead of waiting for the webhook. The webhook does the
// same work and both are idempotent, so whichever lands second changes
// nothing — and a webhook that is late, or misconfigured, does not leave a
// buyer looking at the free view.
import { buyer } from "../../../lib/billing/buyer.js";
import { stripe } from "../../../lib/billing/stripe.js";
import { recordPassSession, syncCustomer } from "../../../lib/billing/sync.js";

export default async function handler(req, res) {
  try {
    const b = await buyer(req, res);
    if (b.error) return res.status(b.status).json({ error: b.error });
    const id = String(req.body?.session_id || "");
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: "bad session id" });
    const s = await stripe("GET", `/checkout/sessions/${id}`);
    const mine = s.client_reference_id === b.profile.id || (s.customer && s.customer === b.profile.stripe_customer_id);
    if (!mine) return res.status(403).json({ error: "not your checkout" });
    const result = s.mode === "payment" ? await recordPassSession(id, { forProfile: b.profile.id }) : await syncCustomer(s.customer);
    return res.status(200).json({ ok: true, result });
  } catch (e) {
    return res.status(502).json({ error: `could not confirm yet: ${e.message}` });
  }
}
