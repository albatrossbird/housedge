// Stripe -> here. Verified against STRIPE_WEBHOOK_SECRET on the RAW body
// (a re-serialised body would not match the signature), then handed to
// lib/billing/sync.js. A failure answers 500 so Stripe retries for up to
// three days; an event we do not use answers 200 so it stops.
import { verifySignature } from "../../../lib/billing/stripe.js";
import { handleEvent } from "../../../lib/billing/sync.js";

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whsec || !process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: "billing is not configured" });
  const body = await rawBody(req);
  if (!verifySignature(body, req.headers["stripe-signature"], whsec)) return res.status(400).json({ error: "bad signature" });
  let event;
  try { event = JSON.parse(body); } catch { return res.status(400).json({ error: "not JSON" }); }
  try {
    const result = await handleEvent(event);
    return res.status(200).json({ received: event.id, type: event.type, result });
  } catch (e) {
    console.error(`stripe webhook ${event.type} ${event.id}: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
}
