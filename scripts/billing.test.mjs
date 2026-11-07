// Billing: checkout, the portal, the confirm route and the Stripe webhook,
// driven through the API routes against a fake Stripe and a fake Supabase
// (Auth and REST), with no network. Run: node scripts/billing.test.mjs
import { createHmac } from "node:crypto";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
process.env.STRIPE_API_BASE = "https://fake.stripe.test";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
process.env.ACCOUNTS_MODE = "on";
process.env.SITE_URL = "https://marketslap.com";

const { formEncode, verifySignature, ensurePrice, billingEnabled, testMode } = await import("../lib/billing/stripe.js");
const { planFromSubscriptions, passChain, GRACE_MS, recordPassSession } = await import("../lib/billing/sync.js");
const { CATALOG, lookupKey } = await import("../lib/billing/plans.js");
const checkout = (await import("../pages/api/billing/checkout.js")).default;
const portal = (await import("../pages/api/billing/portal.js")).default;
const confirm = (await import("../pages/api/billing/confirm.js")).default;
const webhook = (await import("../pages/api/billing/webhook.js")).default;
const me = (await import("../pages/api/me.js")).default;

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };

// ---- fakes ---------------------------------------------------------------
const S = {};
let seq = 0;
const nid = p => `${p}_${++seq}`;
function reset() {
  Object.assign(S, {
    users: { u1: { id: "u1", email: "a@x.com", user_metadata: {} }, u2: { id: "u2", email: "b@x.com", user_metadata: {} } },
    access: { AT1: "u1", AT2: "u2" },
    profiles: [
      { id: "u1", email: "a@x.com", plan: "free", plan_until: null, pass_until: null, referred_by: "CREATOR", stripe_customer_id: null },
      { id: "u2", email: "b@x.com", plan: "free", plan_until: null, pass_until: null, referred_by: null, stripe_customer_id: null },
    ],
    affiliates: [], payments: [],
    // Products and prices outlive a reset, as they outlive anything in a real
    // Stripe account: ensurePrice remembers them for the life of the process.
    st: { products: S.st?.products ?? {}, prices: S.st?.prices ?? [], customers: {}, sessions: {}, subs: [], invoices: {}, charges: {}, calls: [], down: false },
  });
}
const J = (status, body) => new Response(body == null ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// a[b][0]=x -> { a: { b: { 0: "x" } } }, then numeric-keyed objects to arrays.
function unflatten(params) {
  const out = {};
  for (const [k, v] of params) {
    const path = k.replace(/\]/g, "").split("[");
    let o = out;
    path.forEach((p, i) => { if (i === path.length - 1) o[p] = v; else o = o[p] ??= {}; });
  }
  const fix = o => (o && typeof o === "object" ? (Object.keys(o).every(k => /^\d+$/.test(k)) ? Object.values(o).map(fix) : Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fix(v)]))) : o);
  return fix(out);
}

function fakeStripe(u, method, form) {
  const st = S.st;
  st.calls.push(`${method} ${u.pathname}`);
  if (st.down) return J(500, { error: { message: "stripe down" } });
  const p = method === "GET" ? unflatten(u.searchParams) : unflatten(new URLSearchParams(form));
  const parts = u.pathname.replace(/^\/v1\//, "").split("/");
  const miss = () => J(404, { error: { code: "resource_missing", message: "No such object" } });
  if (parts[0] === "prices" && method === "GET") return J(200, { data: st.prices.filter(x => p.lookup_keys.includes(x.lookup_key) && x.active).slice(0, 1) });
  if (parts[0] === "prices") {
    if (st.prices.some(x => x.lookup_key === p.lookup_key)) return J(400, { error: { message: "lookup key in use" } });
    const price = { id: nid("price"), active: true, lookup_key: p.lookup_key, product: p.product, unit_amount: Number(p.unit_amount), recurring: p.recurring ?? null, metadata: p.metadata ?? {} };
    st.prices.push(price); return J(200, price);
  }
  if (parts[0] === "products") {
    if (st.products[p.id]) return J(400, { error: { code: "resource_already_exists", message: "exists" } });
    st.products[p.id] = { id: p.id, name: p.name }; return J(200, st.products[p.id]);
  }
  if (parts[0] === "customers" && method === "POST") { const c = { id: nid("cus"), email: p.email, metadata: p.metadata ?? {} }; st.customers[c.id] = c; return J(200, c); }
  if (parts[0] === "customers") return st.customers[parts[1]] ? J(200, st.customers[parts[1]]) : miss();
  if (parts[0] === "checkout" && method === "POST") {
    if (!st.customers[p.customer]) return miss();
    const s = { id: nid("cs_test"), url: `https://checkout.stripe.test/${seq}`, ...p, payment_status: "unpaid", amount_total: 0, currency: "usd", livemode: false };
    st.sessions[s.id] = s; return J(200, s);
  }
  if (parts[0] === "checkout") return st.sessions[parts[2]] ? J(200, st.sessions[parts[2]]) : miss();
  if (parts[0] === "subscriptions") return J(200, { data: st.subs.filter(s => s.customer === p.customer) });
  if (parts[0] === "invoices") return st.invoices[parts[1]] ? J(200, st.invoices[parts[1]]) : miss();
  if (parts[0] === "charges") return st.charges[parts[1]] ? J(200, st.charges[parts[1]]) : miss();
  if (parts[0] === "billing_portal") return J(200, { url: `https://billing.stripe.test/${p.customer}`, return_url: p.return_url });
  return J(404, { error: { message: `fake stripe: no route ${u.pathname}` } });
}

// PostgREST filters this module uses: eq., is.null, and order.
const match = (r, q) => Object.entries(q).every(([k, v]) => ["select", "order", "on_conflict"].includes(k) || (v.startsWith("eq.") ? String(r[k]) === v.slice(3) : v === "is.null" ? r[k] == null : v === "is.true" ? r[k] === true : true));
function fakeRest(u, method, body, prefer = "") {
  const table = u.pathname.slice(9), q = Object.fromEntries(u.searchParams);
  const rows = S[table];
  if (!rows) return J(404, { message: `no table ${table}` });
  if (method === "GET") {
    let out = rows.filter(r => match(r, q));
    if (q.order) { const [col] = q.order.split("."); out = [...out].sort((a, b) => String(a[col]).localeCompare(String(b[col]))); }
    return J(200, out);
  }
  if (method === "PATCH") { const hit = rows.filter(r => match(r, q)); hit.forEach(r => Object.assign(r, body)); return J(200, prefer.includes("representation") ? hit : null); }
  if (method === "POST") {
    for (const b of body) {
      const ex = rows.find(r => r.id === b.id);
      if (!ex) rows.push({ refunded_cents: 0, paid_at: new Date(S.clock ?? Date.now()).toISOString(), ...b });
      else if (prefer.includes("merge-duplicates")) Object.assign(ex, b);
    }
    return J(201, null);
  }
  return J(405, {});
}

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || "GET";
  if (u.host === "fake.stripe.test") {
    if (opts.headers?.Authorization !== "Bearer sk_test_fake") return J(401, { error: { message: "bad key" } });
    if (opts.headers?.["Stripe-Version"] !== "2024-06-20") return J(400, { error: { message: "unpinned version" } });
    return fakeStripe(u, method, opts.body);
  }
  if (u.pathname === "/auth/v1/user") {
    const uid = S.access[String(opts.headers?.Authorization || "").replace(/^Bearer /, "")];
    return uid ? J(200, S.users[uid]) : J(401, { msg: "invalid JWT" });
  }
  if (u.pathname.startsWith("/rest/v1/")) {
    if (opts.headers?.apikey !== "service-key") return J(401, { message: "no key" });
    return fakeRest(u, method, opts.body ? JSON.parse(opts.body) : null, opts.headers?.Prefer);
  }
  return J(404, {});
};

function mkRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.getHeader = k => res.headers[k.toLowerCase()];
  return res;
}
const mkReq = ({ method = "POST", body, at, origin, headers = {}, raw } = {}) => {
  const req = { method, query: {}, body, headers: { host: "marketslap.com", ...(origin ? { origin } : {}), ...(at ? { cookie: `ms_at=${at}` } : {}), ...headers } };
  if (raw != null) req[Symbol.asyncIterator] = async function* () { yield Buffer.from(raw.slice(0, 7)); yield Buffer.from(raw.slice(7)); };
  return req;
};
async function run(handler, opts) { const res = mkRes(); await handler(mkReq(opts), res); return res; }

const sign = (raw, t = Math.floor(Date.now() / 1000), secret = "whsec_fake") => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
async function deliver(event, { sig } = {}) {
  const raw = JSON.stringify(event);
  return run(webhook, { raw, headers: { "stripe-signature": sig ?? sign(raw) } });
}
const prof = id => S.profiles.find(p => p.id === id);
const priceOf = key => S.st.prices.find(p => p.lookup_key === lookupKey(CATALOG[key]));
const sub = (customer, key, { status = "active", end = Date.now() / 1000 + 30 * 86400, itemLevel = false } = {}) => {
  const s = { id: nid("sub"), customer, status, items: { data: [{ price: priceOf(key), ...(itemLevel ? { current_period_end: Math.floor(end) } : {}) }] }, ...(itemLevel ? {} : { current_period_end: Math.floor(end) }) };
  S.st.subs.push(s); return s;
};

// ---- pure parts ----------------------------------------------------------
const enc = formEncode({ a: 1, line_items: [{ price: "p", quantity: 1 }], metadata: { k: "v" }, skip: undefined, nul: null }).toString();
ok(enc === "a=1&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Bk%5D=v", "Stripe form encoding: nested objects and arrays, nothing for null", enc);

const raw = '{"id":"evt_1"}';
const now = Date.now();
const t = Math.floor(now / 1000);
ok(verifySignature(raw, sign(raw, t), "whsec_fake", { now }), "a correctly signed body verifies");
ok(!verifySignature(raw + " ", sign(raw, t), "whsec_fake", { now }), "a body changed after signing does not");
ok(!verifySignature(raw, sign(raw, t, "whsec_other"), "whsec_fake", { now }), "a signature made with another secret does not");
ok(!verifySignature(raw, sign(raw, t - 301), "whsec_fake", { now }) && verifySignature(raw, sign(raw, t - 299), "whsec_fake", { now }), "outside five minutes is a replay, inside is fine");
ok(verifySignature(raw, `t=${t},v1=00ff,${sign(raw, t).split(",")[1]}`, "whsec_fake", { now }), "any one of several v1 signatures is enough (secret rotation)");
ok(!verifySignature(raw, `t=${t},v0=${sign(raw, t).split("v1=")[1]}`, "whsec_fake", { now }) && !verifySignature(raw, "", "whsec_fake", { now }) && !verifySignature(raw, sign(raw, t), "", { now }), "v0, a missing header and a missing secret all fail");

reset();
const P = (key, s = Date.parse("2026-12-01T00:00:00Z") / 1000) => ({ price: { metadata: { ms_key: key } }, s });
const subOf = (status, ...items) => ({ status, current_period_end: items[0].s, items: { data: items.map(i => ({ price: i.price })) } });
const dec1 = Date.parse("2026-12-01T00:00:00Z");
let pl = planFromSubscriptions([subOf("active", P("pro"))]);
ok(pl.plan === "pro" && pl.until === new Date(dec1 + GRACE_MS).toISOString(), "an active subscription holds its plan until the period end plus a day's grace", JSON.stringify(pl));
pl = planFromSubscriptions([subOf("active", P("ev", dec1 / 1000)), subOf("active", P("arb", dec1 / 1000 - 86400))]);
ok(pl.plan === "pro" && pl.until === new Date(dec1 - 86400000 + GRACE_MS).toISOString(), "+EV and Arbitrage together are Sports Pro, until the earlier end");
ok(planFromSubscriptions([subOf("canceled", P("pro")), subOf("incomplete", P("ev")), subOf("unpaid", P("arb"))]).plan === "free", "cancelled, incomplete and unpaid subscriptions grant nothing");
ok(planFromSubscriptions([subOf("past_due", P("ev"))]).plan === "ev" && planFromSubscriptions([subOf("trialing", P("arb"))]).plan === "arb", "past due and trialing keep the plan while Stripe retries");
ok(planFromSubscriptions([{ status: "active", items: { data: [{ price: { metadata: { ms_key: "ev" } }, current_period_end: dec1 / 1000 }] } }]).plan === "ev", "the period end is read from the item when the subscription lacks it (newer API shape)");
ok(planFromSubscriptions([subOf("active", { price: { metadata: { ms_key: "mystery" } }, s: dec1 / 1000 })]).plan === "free", "a price that is not ours grants nothing");

const h = hrs => new Date(Date.parse("2026-11-07T00:00:00Z") + hrs * 3600000).toISOString();
ok(passChain([{ paid_at: h(0), amount_cents: 900, refunded_cents: 0 }]) === h(24), "a pass lasts 24 hours from purchase");
ok(passChain([{ paid_at: h(2), amount_cents: 900, refunded_cents: 0 }, { paid_at: h(0), amount_cents: 900, refunded_cents: 0 }]) === h(48), "two passes bought a day apart or less stack, in either order");
ok(passChain([{ paid_at: h(0), amount_cents: 900, refunded_cents: 0 }, { paid_at: h(30), amount_cents: 900, refunded_cents: 0 }]) === h(54), "a pass bought after the last one ended starts when bought");
ok(passChain([{ paid_at: h(0), amount_cents: 900, refunded_cents: 900 }]) === null && passChain([]) === null, "a fully refunded pass grants nothing");

ok(billingEnabled({ ACCOUNTS_MODE: "on", STRIPE_SECRET_KEY: "sk_live_x" }) && !billingEnabled({ ACCOUNTS_MODE: "off", STRIPE_SECRET_KEY: "sk_live_x" }) && !billingEnabled({ ACCOUNTS_MODE: "on" }), "billing needs accounts on and a key");
ok(testMode({ STRIPE_SECRET_KEY: "sk_test_1" }) && !testMode({ STRIPE_SECRET_KEY: "sk_live_1" }), "a test key is reported as test mode");

// ---- prices are made from the catalogue, once ----------------------------
reset();
const p1 = await ensurePrice("pro");
const made = priceOf("pro");
ok(made && made.unit_amount === 5900 && made.recurring?.interval === "month" && made.product === "ms_pro" && made.metadata.ms_key === "pro" && S.st.products.ms_pro, "the first use makes the product and the price from lib/billing/plans.js", JSON.stringify(made));
const callsBefore = S.st.calls.length;
ok((await ensurePrice("pro")) === p1 && S.st.calls.length === callsBefore, "a second use is served from memory");
await ensurePrice("pro_year");
ok(priceOf("pro_year").recurring.interval === "year" && Object.keys(S.st.products).length === 1, "the yearly price joins the existing product rather than failing on it");
await ensurePrice("pass");
ok(priceOf("pass").recurring == null && priceOf("pass").unit_amount === 900, "the day pass is a one-off price");

// ---- checkout ------------------------------------------------------------
reset();
ok((await run(checkout, { method: "GET", at: "AT1", body: { plan: "pro" } })).statusCode === 405, "checkout: POST only");
ok((await run(checkout, { at: "AT1", origin: "https://evil.example", body: { plan: "pro" } })).statusCode === 403, "checkout: a cross-site POST is refused");
ok((await run(checkout, { body: { plan: "pro" } })).statusCode === 401, "checkout: signed out is refused");
ok((await run(checkout, { at: "AT1", body: { plan: "platinum" } })).statusCode === 400, "checkout: an unknown plan is refused");
process.env.ACCOUNTS_MODE = "off";
ok((await run(checkout, { at: "AT1", body: { plan: "pro" } })).statusCode === 404, "checkout: nothing while accounts are off");
process.env.ACCOUNTS_MODE = "on";
const keep = process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_SECRET_KEY;
ok((await run(checkout, { at: "AT1", body: { plan: "pro" } })).statusCode === 404, "checkout: nothing without a Stripe key");
process.env.STRIPE_SECRET_KEY = keep;

let r = await run(checkout, { at: "AT1", origin: "https://marketslap.com", body: { plan: "pro" } });
const cus1 = prof("u1").stripe_customer_id;
const cs = Object.values(S.st.sessions)[0];
ok(r.statusCode === 200 && r.body.url === cs.url, "checkout: answers with Stripe's checkout url", JSON.stringify(r.body));
ok(cus1 && S.st.customers[cus1].metadata.profile_id === "u1" && S.st.customers[cus1].email === "a@x.com", "checkout: a Stripe customer is made for the profile, named in its metadata, and stored");
ok(cs.mode === "subscription" && cs.customer === cus1 && cs.client_reference_id === "u1" && cs.line_items[0].price === priceOf("pro").id && cs.allow_promotion_codes === "true", "checkout: the session is the right plan, customer and profile, with promotion codes allowed");
ok(cs.subscription_data?.metadata?.profile_id === "u1" && cs.success_url === "https://marketslap.com/account?checkout=done&session_id={CHECKOUT_SESSION_ID}" && cs.cancel_url === "https://marketslap.com/pricing", "checkout: returns to the account page with the session id, or to pricing");
ok(prof("u1").plan === "free", "checkout grants nothing by itself");

await run(checkout, { at: "AT1", body: { plan: "ev" } });
ok(Object.keys(S.st.customers).length === 1, "checkout: a second checkout reuses the customer");
S.st.customers = {};
await run(checkout, { at: "AT1", body: { plan: "ev" } });
ok(prof("u1").stripe_customer_id !== cus1 && S.st.customers[prof("u1").stripe_customer_id], "checkout: a stored customer Stripe no longer knows (a test one, once the key is live) is replaced");

const before = prof("u1").stripe_customer_id;
S.st.customers[before] = { id: before, deleted: true };     // how Stripe answers for a deleted customer: 200, not 404
await run(checkout, { at: "AT1", body: { plan: "ev" } });
ok(prof("u1").stripe_customer_id !== before && !S.st.customers[prof("u1").stripe_customer_id].deleted, "checkout: a customer deleted in Stripe is replaced, not checked out as");

prof("u1").plan = "ev"; prof("u1").plan_until = new Date(Date.now() + 86400000).toISOString();
r = await run(checkout, { at: "AT1", body: { plan: "pro" } });
ok(r.statusCode === 409 && r.body.manage === true, "checkout: a second subscription is refused and sent to the portal", JSON.stringify(r.body));
ok((await run(checkout, { at: "AT1", body: { plan: "pass" } })).statusCode === 200, "checkout: a day pass beside a single-board plan is allowed");
prof("u1").plan = "pro";
ok((await run(checkout, { at: "AT1", body: { plan: "pass" } })).statusCode === 409, "checkout: a day pass is refused on Sports Pro, which already has everything");
prof("u1").plan = "free"; prof("u1").pass_until = new Date(Date.now() + 3600000).toISOString();
ok((await run(checkout, { at: "AT1", body: { plan: "pass" } })).statusCode === 200, "checkout: a second pass while one runs is allowed (they stack)");
const passCs = Object.values(S.st.sessions).find(s => s.mode === "payment");
ok(Object.values(S.st.sessions).filter(s => s.mode === "payment").length === 2, "checkout: two pass sessions were made");
ok(passCs.metadata.ms_key === "pass" && passCs.payment_intent_data.metadata.profile_id === "u1" && passCs.line_items[0].price === priceOf("pass").id, "checkout: the day pass is a one-off payment for the pass price");

reset(); S.st.down = true;
r = await run(checkout, { at: "AT1", body: { plan: "pro" } });
ok(r.statusCode === 502 && /stripe down/.test(r.body.error), "checkout: a Stripe outage is a 502 naming it");

// ---- webhook -------------------------------------------------------------
reset();
const ev = (type, object, id = nid("evt")) => ({ id, type, data: { object } });
delete process.env.STRIPE_WEBHOOK_SECRET;
ok((await deliver(ev("customer.subscription.created", {}))).statusCode === 503, "webhook: 503 until its secret is set, so Stripe keeps retrying");
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
r = await deliver(ev("customer.subscription.created", { customer: "cus_x" }), { sig: sign("{}") });
ok(r.statusCode === 400, "webhook: a signature for another body is refused");
r = await deliver(ev("customer.subscription.created", { customer: "cus_x" }), { sig: "t=1,v1=00" });
ok(r.statusCode === 400, "webhook: an old or forged signature is refused");

await run(checkout, { at: "AT1", body: { plan: "pro" } });
const cus = prof("u1").stripe_customer_id;
const s1 = sub(cus, "pro");
r = await deliver(ev("customer.subscription.created", s1));
ok(r.statusCode === 200 && prof("u1").plan === "pro" && Date.parse(prof("u1").plan_until) === s1.current_period_end * 1000 + GRACE_MS, "webhook: a new subscription sets the plan and its end", JSON.stringify(r.body));
s1.status = "canceled";
await deliver(ev("customer.subscription.deleted", { ...s1 }));
await deliver(ev("customer.subscription.updated", { ...s1, status: "active" }));
ok(prof("u1").plan === "free" && prof("u1").plan_until === null, "webhook: an `updated` arriving after `deleted` cannot revive the plan (state is read from Stripe, not the event)");
await ensurePrice("arb");
const s2 = sub(cus, "arb", { itemLevel: true });
await deliver(ev("customer.subscription.created", { id: s2.id, customer: cus }));
ok(prof("u1").plan === "arb", "webhook: a resubscription to another plan takes effect");

// A checkout whose customer-id write was lost: the customer's metadata finds the profile.
S.st.customers.cus_orphan = { id: "cus_orphan", email: "b@x.com", metadata: { profile_id: "u2" } };
sub("cus_orphan", "ev");
await deliver(ev("customer.subscription.created", { customer: "cus_orphan" }));
ok(prof("u2").plan === "ev" && prof("u2").stripe_customer_id === "cus_orphan", "webhook: a customer not yet stored on a profile is found through its metadata, and stored");
S.st.customers.cus_dash = { id: "cus_dash", email: "c@x.com", metadata: {} };
r = await deliver(ev("customer.subscription.created", { customer: "cus_dash" }));
const r2 = await deliver(ev("customer.subscription.created", { customer: "cus_gone" }));
ok(r.statusCode === 200 && /no profile/.test(r.body.result?.skipped) && r2.statusCode === 200 && /no profile/.test(r2.body.result?.skipped), "webhook: a customer with no profile (made in the dashboard, or deleted) is skipped, not retried for three days", JSON.stringify([r.body, r2.body]));

// Payments, referral credit, and refunds.
reset();
await run(checkout, { at: "AT1", body: { plan: "pro" } });
const c1 = prof("u1").stripe_customer_id;
S.st.invoices.in_1 = { id: "in_1", customer: c1, status: "paid", amount_paid: 5900, currency: "usd", payment_intent: "pi_1", livemode: false, status_transitions: { paid_at: 1794000000 }, lines: { data: [{ price: priceOf("pro") }] } };
sub(c1, "pro");
r = await deliver(ev("invoice.paid", { id: "in_1", customer: c1 }));
const pay = S.payments.find(p => p.id === "in_1");
ok(r.statusCode === 200 && pay && pay.amount_cents === 5900 && pay.kind === "subscription" && pay.plan === "pro" && pay.profile_id === "u1" && pay.payment_intent === "pi_1" && pay.paid_at === new Date(1794000000 * 1000).toISOString(), "webhook: a paid invoice is recorded as a payment", JSON.stringify(pay));
ok(pay.referred_by === "CREATOR", "webhook: the payment carries the referral it was earned under");
ok(prof("u1").plan === "pro", "webhook: a paid invoice also brings the plan up to date");
S.st.charges.ch_1 = { id: "ch_1", payment_intent: "pi_1", amount_refunded: 5900 };
await deliver(ev("charge.refunded", { id: "ch_1" }));
ok(pay.refunded_cents === 5900, "webhook: a refund is written onto its payment");
await deliver(ev("invoice.paid", { id: "in_1", customer: c1 }));
ok(S.payments.filter(p => p.id === "in_1").length === 1 && S.payments.find(p => p.id === "in_1").refunded_cents === 5900, "webhook: a redelivered invoice neither duplicates the payment nor clears its refund");
S.st.invoices.in_0 = { ...S.st.invoices.in_1, id: "in_0", amount_paid: 0 };
await deliver(ev("invoice.paid", { id: "in_0", customer: c1 }));
ok(!S.payments.some(p => p.id === "in_0"), "webhook: a $0 invoice (a 100%-off code) is not a payment");

// Day passes: recorded once, stacked, never moved by a redelivery.
reset();
await run(checkout, { at: "AT1", body: { plan: "pass" } });
const pcs = Object.values(S.st.sessions)[0];
Object.assign(pcs, { amount_total: 900, payment_intent: "pi_p1" });
r = await deliver(ev("checkout.session.completed", { id: pcs.id, mode: "payment" }));
ok(r.statusCode === 200 && prof("u1").pass_until === null && !S.payments.length, "webhook: an unpaid pass session grants nothing yet");
pcs.payment_status = "paid";
S.clock = Date.parse("2026-11-07T00:00:00Z");
await deliver(ev("checkout.session.async_payment_succeeded", { id: pcs.id, mode: "payment" }));
ok(prof("u1").pass_until === h(24) && S.payments[0].kind === "pass" && S.payments[0].referred_by === "CREATOR", "webhook: a paid pass runs 24 hours from when it is recorded", prof("u1").pass_until);
S.clock = Date.parse("2026-11-07T05:00:00Z");
await deliver(ev("checkout.session.completed", { id: pcs.id, mode: "payment" }));
ok(prof("u1").pass_until === h(24) && S.payments.length === 1, "webhook: a redelivered pass changes nothing");
await run(checkout, { at: "AT1", body: { plan: "pass" } });
const pcs2 = Object.values(S.st.sessions).find(s => s.id !== pcs.id);
Object.assign(pcs2, { amount_total: 900, payment_status: "paid" });
await deliver(ev("checkout.session.completed", { id: pcs2.id, mode: "payment" }));
ok(prof("u1").pass_until === h(48), "webhook: a second pass bought while one runs starts when the first ends", prof("u1").pass_until);
prof("u1").pass_until = h(100);
await deliver(ev("checkout.session.completed", { id: pcs2.id, mode: "payment" }));
ok(prof("u1").pass_until === h(100), "webhook: a pass given by hand for longer is never shortened");
S.clock = undefined;

reset();
r = await deliver(ev("customer.created", { id: "cus_1" }));
ok(r.statusCode === 200 && r.body.result?.ignored === "customer.created", "webhook: an event we do not use is acknowledged, so Stripe stops sending it");
S.st.down = true;
r = await deliver(ev("customer.subscription.updated", { customer: "cus_1" }));
ok(r.statusCode === 500, "webhook: a failure answers 500, so Stripe retries");

// ---- confirm (the return from Checkout) ----------------------------------
reset();
await run(checkout, { at: "AT1", body: { plan: "pass" } });
const mine = Object.values(S.st.sessions)[0];
Object.assign(mine, { payment_status: "paid", amount_total: 900 });
ok((await run(confirm, { at: "AT1", body: { session_id: "../evil" } })).statusCode === 400, "confirm: a malformed session id is refused before reaching Stripe");
ok((await run(confirm, { at: "AT2", body: { session_id: mine.id } })).statusCode === 403 && prof("u1").pass_until === null && prof("u2").pass_until === null, "confirm: another user's checkout is refused and grants nothing");
ok((await recordPassSession(mine.id, { forProfile: "u2" })).forbidden && !S.payments.length, "a pass session is applied only to the profile it belongs to, even if a caller skipped its own check");
r = await run(confirm, { at: "AT1", body: { session_id: mine.id } });
ok(r.statusCode === 200 && prof("u1").pass_until, "confirm: the buyer's own pass applies at once, without waiting on the webhook", JSON.stringify(r.body));
await run(checkout, { at: "AT2", body: { plan: "ev" } });
const subCs = Object.values(S.st.sessions).find(s => s.mode === "subscription");
sub(prof("u2").stripe_customer_id, "ev");
r = await run(confirm, { at: "AT2", body: { session_id: subCs.id } });
ok(r.statusCode === 200 && prof("u2").plan === "ev", "confirm: a subscription applies at once too");

// ---- portal and /api/me ----------------------------------------------------
reset();
ok((await run(portal, { at: "AT1" })).statusCode === 404, "portal: nothing to manage before a purchase");
await run(checkout, { at: "AT1", body: { plan: "pro" } });
r = await run(portal, { at: "AT1" });
ok(r.statusCode === 200 && r.body.url.endsWith(prof("u1").stripe_customer_id), "portal: opens Stripe's portal for the account's own customer");
const meRes = mkRes(); await me({ method: "GET", query: {}, headers: { host: "marketslap.com", cookie: "ms_at=AT1" } }, meRes);
ok(meRes.body.billing?.enabled === true && meRes.body.billing?.test === true && meRes.body.hasBilling === true, "/api/me says billing is open, in test mode, and that this account has billing", JSON.stringify(meRes.body));
const meOut = mkRes(); await me({ method: "GET", query: {}, headers: { host: "marketslap.com" } }, meOut);
ok(meOut.body.user === null && meOut.body.billing?.enabled === true, "/api/me tells a signed-out reader whether billing is open");
ok(!JSON.stringify(meRes.body).includes("cus_"), "/api/me never sends the Stripe customer id to the browser");

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall billing checks passed");
