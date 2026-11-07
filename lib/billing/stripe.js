// Stripe over plain HTTPS, server-side only — no SDK, the same choice as
// lib/auth/gotrue.js: a few form-encoded calls, every one keeping its status.
//
// STRIPE_SECRET_KEY      sk_test_... while trying it, sk_live_... to sell.
//                        Server-only: never a NEXT_PUBLIC_ variable.
// STRIPE_WEBHOOK_SECRET  whsec_... from the webhook endpoint (docs/billing-setup.md).
// STRIPE_API_BASE        tests only (the fake Stripe); unset in production.
//
// The API version is PINNED. Webhook payloads arrive in whatever version the
// endpoint was made with, so the handler reads only an event's type and
// object id and re-fetches the object here, in this version: the shape it
// reads can then never drift with Stripe's defaults. In 2024-06-20 a
// subscription carries current_period_end, an invoice its payment_intent and
// a charge its invoice; later versions move all three.
import { createHmac, timingSafeEqual } from "node:crypto";
import { accountsMode } from "../auth/config.js";
import { CATALOG, PRODUCT_NAMES, lookupKey, isSubscription } from "./plans.js";

export const STRIPE_VERSION = "2024-06-20";
const base = () => String(process.env.STRIPE_API_BASE || "https://api.stripe.com").replace(/\/+$/, "");
const secret = () => process.env.STRIPE_SECRET_KEY || "";

// Billing needs accounts on (preview or on) and a key. With preview, only the
// allowlist can sign in, so a test key on production is safe to try.
export const billingEnabled = (env = process.env) => accountsMode(env) !== "off" && Boolean(env.STRIPE_SECRET_KEY);
export const testMode = (env = process.env) => /^(sk|rk)_test_/.test(String(env.STRIPE_SECRET_KEY || ""));

// Stripe's form encoding: nested objects as a[b][c], arrays as a[0].
export function formEncode(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [i, x])) : v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export class StripeError extends Error {
  constructor(status, body) {
    super(`stripe ${status}: ${body?.error?.message || "request failed"}`);
    this.status = status;
    this.code = body?.error?.code;
  }
}

export async function stripe(method, path, params = {}, { idempotencyKey } = {}) {
  if (!secret()) throw new Error("billing needs STRIPE_SECRET_KEY (server-side only)");
  const form = formEncode(params).toString();
  const url = `${base()}/v1${path}${method === "GET" && form ? `?${form}` : ""}`;
  const headers = { Authorization: `Bearer ${secret()}`, "Stripe-Version": STRIPE_VERSION };
  if (method !== "GET") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const r = await fetch(url, { method, headers, body: method === "GET" ? undefined : form, signal: AbortSignal.timeout(15000) });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new StripeError(r.status, body);
  return body;
}

// The Stripe Price for a CATALOG entry, made on first use. Products have
// fixed ids (ms_pro, ...) so a second creation fails rather than duplicating;
// prices are found by lookup key, which Stripe keeps unique per account.
const priceCache = new Map();
export async function ensurePrice(key) {
  const item = CATALOG[key];
  if (!item) throw new Error(`unknown plan ${key}`);
  const lk = lookupKey(item);
  if (priceCache.has(lk)) return priceCache.get(lk);
  const find = async () => (await stripe("GET", "/prices", { lookup_keys: [lk], active: true, limit: 1 })).data?.[0]?.id ?? null;
  let id = await find();
  if (!id) {
    try { await stripe("POST", "/products", { id: item.product, name: PRODUCT_NAMES[item.product] }); }
    catch (e) { if (e.code !== "resource_already_exists") throw e; }
    try {
      const price = await stripe("POST", "/prices", {
        product: item.product, currency: "usd", unit_amount: item.amount, lookup_key: lk,
        recurring: isSubscription(item) ? { interval: item.interval } : undefined,
        metadata: { ms_key: item.key, ms_plan: item.plan ?? "" },
      });
      id = price.id;
    } catch (e) {
      id = await find();            // another request made it first
      if (!id) throw e;
    }
  }
  priceCache.set(lk, id);
  return id;
}

// The plan key a Stripe price stands for, from its metadata or its lookup key.
export function catalogKeyOf(price) {
  if (price?.metadata?.ms_key && CATALOG[price.metadata.ms_key]) return price.metadata.ms_key;
  return Object.values(CATALOG).find(i => lookupKey(i) === price?.lookup_key)?.key ?? null;
}

// Stripe-Signature: t=<unix>,v1=<hex>[,v1=...]. HMAC-SHA256 of "<t>.<raw body>"
// with the endpoint secret, compared in constant time, inside a 5-minute
// window so a captured delivery cannot be replayed later.
export function verifySignature(rawBody, header, whsec, { now = Date.now(), toleranceSec = 300 } = {}) {
  if (!whsec || !header) return false;
  const parts = String(header).split(",").map(p => p.split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const want = createHmac("sha256", whsec).update(`${t}.${rawBody}`).digest();
  return sigs.some(s => {
    const got = Buffer.from(String(s), "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}
