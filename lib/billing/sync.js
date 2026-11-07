// Stripe -> profiles and payments. Every function here is safe to run twice:
// webhooks are delivered at least once, out of order, and sometimes late, so
// nothing trusts an event's payload or its order.
//
// - A plan is RECOMPUTED from the customer's subscriptions as Stripe holds
//   them now, never patched from "this event says X". An `updated` that
//   arrives after a `deleted` therefore cannot resurrect a cancelled plan.
// - A payment is upserted on its Stripe id (invoice or Checkout Session).
// - A day pass is RECOMPUTED as a chain over every pass payment, so two
//   passes stack and a redelivered event adds nothing.
import { stripe, catalogKeyOf, StripeError } from "./stripe.js";
import { CATALOG } from "./plans.js";
import { getProfile, updateProfile, profileByCustomer, req } from "../auth/profiles.js";

// A renewal is charged at the period end and its webhook lands seconds to
// minutes later; a day's grace keeps a paying customer from being locked out
// in between. A cancellation is a `deleted` event, which ends it at once.
export const GRACE_MS = 24 * 3600 * 1000;
const LIVE = new Set(["active", "trialing", "past_due"]);
const iso = ms => new Date(ms).toISOString();

// Subscriptions -> { plan, until }. +EV and Arbitrage held together are Sports
// Pro, until the earlier of the two ends.
export function planFromSubscriptions(subs) {
  const held = {};
  for (const s of subs ?? []) {
    if (!LIVE.has(s.status)) continue;
    for (const it of s.items?.data ?? []) {
      const plan = CATALOG[catalogKeyOf(it.price)]?.plan;
      const end = Number(s.current_period_end ?? it.current_period_end) * 1000;
      if (plan && Number.isFinite(end) && end > 0) held[plan] = Math.max(held[plan] ?? 0, end);
    }
  }
  let plan = "free", end = null;
  if (held.pro) [plan, end] = ["pro", held.pro];
  else if (held.ev && held.arb) [plan, end] = ["pro", Math.min(held.ev, held.arb)];
  else if (held.ev) [plan, end] = ["ev", held.ev];
  else if (held.arb) [plan, end] = ["arb", held.arb];
  return { plan, until: end ? iso(end + GRACE_MS) : null };
}

// Each pass starts when it is bought or when the one before it ends,
// whichever is later. A pass refunded in full grants nothing.
export function passChain(rows, hours = CATALOG.pass.hours) {
  let until = 0;
  for (const r of [...(rows ?? [])].sort((a, b) => Date.parse(a.paid_at) - Date.parse(b.paid_at))) {
    if (Number(r.refunded_cents) >= Number(r.amount_cents)) continue;
    until = Math.max(until, Date.parse(r.paid_at)) + hours * 3600 * 1000;
  }
  return until ? iso(until) : null;
}

// The profile a Stripe customer belongs to. The customer's metadata names it
// too, which covers a checkout whose stripe_customer_id write was lost.
export async function profileForCustomer(customerId) {
  if (!customerId) return null;
  const p = await profileByCustomer(customerId);
  if (p) return p;
  let c;
  try { c = await stripe("GET", `/customers/${encodeURIComponent(customerId)}`); }
  catch (e) { if (e instanceof StripeError && e.status === 404) return null; throw e; }
  const id = c?.metadata?.profile_id;
  if (!id || c.deleted) return null;
  const byId = await getProfile(id);
  if (!byId) return null;
  return (await updateProfile(id, { stripe_customer_id: customerId })) ?? byId;
}

// The customer to check out as. A stored id that Stripe no longer knows —
// deleted in the dashboard, or a TEST customer once the key is live — is
// replaced, or every checkout after the switch would fail.
export async function ensureCustomer(profile) {
  if (profile.stripe_customer_id) {
    try {
      const c = await stripe("GET", `/customers/${encodeURIComponent(profile.stripe_customer_id)}`);
      if (!c.deleted) return c.id;
    } catch (e) {
      if (!(e instanceof StripeError && e.status === 404)) throw e;
    }
  }
  const c = await stripe("POST", "/customers", { email: profile.email, metadata: { profile_id: profile.id } });
  await updateProfile(profile.id, { stripe_customer_id: c.id });
  return c.id;
}

export async function syncCustomer(customerId) {
  const profile = await profileForCustomer(customerId);
  if (!profile) return { skipped: `no profile for customer ${customerId}` };
  const subs = await stripe("GET", "/subscriptions", { customer: customerId, status: "all", limit: 100 });
  const next = planFromSubscriptions(subs.data);
  await updateProfile(profile.id, { plan: next.plan, plan_until: next.until });
  return { profile: profile.id, ...next };
}

async function upsertPayment(row, { keepFirst = false } = {}) {
  const prefer = `resolution=${keepFirst ? "ignore-duplicates" : "merge-duplicates"},return=minimal`;
  await req("/payments?on_conflict=id", { method: "POST", body: [row], prefer });
}

export async function recordInvoice(invoiceId) {
  const inv = await stripe("GET", `/invoices/${encodeURIComponent(invoiceId)}`);
  if (inv.status !== "paid" || !(inv.amount_paid > 0)) return { skipped: `invoice ${inv.status}, ${inv.amount_paid}c` };
  const profile = await profileForCustomer(inv.customer);
  const line = inv.lines?.data?.find(l => l.price) ?? null;
  const paidAt = inv.status_transitions?.paid_at ? inv.status_transitions.paid_at * 1000 : Date.now();
  // refunded_cents is left out, so a redelivery after a refund keeps it.
  await upsertPayment({
    id: inv.id, profile_id: profile?.id ?? null, customer_id: inv.customer, kind: "subscription",
    plan: CATALOG[catalogKeyOf(line?.price)]?.plan ?? null, amount_cents: inv.amount_paid, currency: inv.currency,
    payment_intent: inv.payment_intent ?? null, referred_by: profile?.referred_by ?? null,
    livemode: Boolean(inv.livemode), paid_at: iso(paidAt),
  });
  return { payment: inv.id, profile: profile?.id ?? null };
}

export async function recomputePass(profileId) {
  const rows = await req(`/payments?profile_id=eq.${encodeURIComponent(profileId)}&kind=eq.pass&select=amount_cents,refunded_cents,paid_at&order=paid_at.asc`);
  const chain = passChain(rows);
  const p = await getProfile(profileId);
  // Never shortens one: a pass given by hand stays as long as it was given.
  if (chain && !(p?.pass_until && Date.parse(p.pass_until) >= Date.parse(chain))) await updateProfile(profileId, { pass_until: chain });
  return chain;
}

// A paid day-pass Checkout Session. `forProfile` is set when the buyer's own
// browser asks (/api/billing/confirm): the session must then be theirs.
export async function recordPassSession(sessionId, { forProfile = null } = {}) {
  const s = await stripe("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (s.mode !== "payment" || s.metadata?.ms_key !== "pass") return { skipped: "not a day pass" };
  const profile = (s.customer && await profileForCustomer(s.customer)) || (s.client_reference_id && await getProfile(s.client_reference_id));
  if (!profile) return { skipped: `no profile for session ${s.id}` };
  if (forProfile && profile.id !== forProfile) return { forbidden: true };
  if (s.payment_status !== "paid") return { pending: s.payment_status };
  // First write wins, and with it paid_at: a redelivery cannot move the
  // pass's start, so the chain is the same however often this runs.
  await upsertPayment({
    id: s.id, profile_id: profile.id, customer_id: s.customer ?? null, kind: "pass", plan: null,
    amount_cents: s.amount_total ?? 0, currency: s.currency ?? "usd", payment_intent: s.payment_intent ?? null,
    referred_by: profile.referred_by ?? null, livemode: Boolean(s.livemode),
  }, { keepFirst: true });
  return { profile: profile.id, passUntil: await recomputePass(profile.id) };
}

export async function recordRefund(chargeId) {
  const ch = await stripe("GET", `/charges/${encodeURIComponent(chargeId)}`);
  if (!ch.payment_intent) return { skipped: "charge has no payment intent" };
  await req(`/payments?payment_intent=eq.${encodeURIComponent(ch.payment_intent)}`, {
    method: "PATCH", body: { refunded_cents: ch.amount_refunded ?? 0 }, prefer: "return=minimal",
  });
  return { refunded: ch.amount_refunded, payment_intent: ch.payment_intent };
}

// One verified webhook event. Only its type and object id are read; the
// object itself is fetched fresh (see STRIPE_VERSION in ./stripe.js).
export async function handleEvent(event) {
  const o = event?.data?.object ?? {};
  switch (event?.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      if (o.mode === "payment") return recordPassSession(o.id);
      if (o.mode === "subscription" && o.customer) return syncCustomer(o.customer);
      return { ignored: o.mode };
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      return syncCustomer(o.customer);
    case "invoice.paid": {
      const payment = await recordInvoice(o.id);
      return { payment, plan: o.customer ? await syncCustomer(o.customer) : null };
    }
    case "charge.refunded":
      return recordRefund(o.id);
    default:
      return { ignored: event?.type ?? "no type" };
  }
}
