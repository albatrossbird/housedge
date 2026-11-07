# Billing: turning Stripe on

The code is built and **off** until `STRIPE_SECRET_KEY` is set. Billing also
needs accounts on (`ACCOUNTS_MODE=preview` or `on`; see
[accounts-setup.md](accounts-setup.md)), so in `preview` only allowlisted
testers ever see a checkout. No secret is ever pasted into chat or a file.

Prices are set in [`lib/billing/plans.js`](../lib/billing/plans.js), not in
Stripe. The products and prices are created in Stripe automatically, the
first time someone opens checkout for each one. Changing an amount in that
file gives NEW buyers the new price; existing subscribers keep theirs.

## 1. Run the migration

[`supabase/migrations/0034_payments.sql`](https://github.com/albatrossbird/housedge/blob/main/supabase/migrations/0034_payments.sql)
in the Supabase SQL editor. It creates `payments`, private to the server
like `profiles`.

## 2. Stripe account

Create it as **MarketSlap LLC** with the EIN, and payouts to the business bank
account.
- Business description: *Subscriptions to sports and prediction-market data
  and analytics. MarketSlap shows prices and calculations; it takes no bets
  and holds no customer funds.*
- Public details (**Settings → Business → Public details**): statement
  descriptor `MARKETSLAP`, support email `support@marketslap.com`, website
  `https://marketslap.com`.
- Leave the dashboard in **Test mode** (toggle at the top right) for steps
  3-6.

## 3. Keys and webhook (test mode)

1. **Developers → API keys**: reveal the **Secret key** (`sk_test_...`) and
   copy it straight into Vercel (step 5).
2. **Developers → Webhooks → Add endpoint** (newer dashboards: **Workbench →
   Webhooks → Create an event destination**, "Your account"):
   - URL: `https://marketslap.com/api/billing/webhook`
   - Events: `checkout.session.completed`,
     `checkout.session.async_payment_succeeded`,
     `customer.subscription.created`, `customer.subscription.updated`,
     `customer.subscription.deleted`, `customer.subscription.paused`,
     `customer.subscription.resumed`, `invoice.paid`, `charge.refunded`
   - After saving, reveal the **Signing secret** (`whsec_...`) for step 5.

## 4. Customer portal

**Settings → Billing → Customer portal** (test mode), then **Activate**:
- Payment methods: allow updating. Invoice history: on.
- Cancellations: allow, **at the end of the billing period**.
- Subscriptions: allow switching plans, with proration. Add the products
  MarketSlap +EV, Arbitrage and Sports Pro. They appear after the first test
  checkout of each (step 6), so come back to this after it.
- Business information: Terms `https://marketslap.com/terms`, Privacy
  `https://marketslap.com/privacy`.

## 5. Vercel

Project → Settings → Environment Variables (Production), then **redeploy**:

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | the secret key |
| `STRIPE_WEBHOOK_SECRET` | the signing secret |

Server-only. Never a `NEXT_PUBLIC_` variable.

## 6. Try it (test mode)

Signed in as an allowlisted tester:
- `/pricing` says "Test mode" and shows Subscribe buttons. Subscribe to
  +EV with card `4242 4242 4242 4242`, any future date, any CVC.
- You land on `/account` showing **+EV**. Stripe → Webhooks → the endpoint
  should list deliveries with `200`.
- `/sports` shows every +EV price; arbitrage is still locked.
- **Manage billing** → switch to Sports Pro → back on `/account` it says
  Sports Pro. Cancel → it stays until the period ends.
- Buy a day pass: the account page shows when it ends. A second one adds 24
  hours.
- Refund a payment from the Stripe dashboard: `payments.refunded_cents` fills in.

## 7. Going live

1. Switch the dashboard to **live mode** and repeat steps 3 and 4 there.
   Live has its own keys, its own webhook endpoint and secret, and its own
   portal settings.
2. Replace both Vercel variables with the live values and redeploy.
3. Testers keep their test plan until its period ends. To clear it now:
   `update profiles set plan = 'free', plan_until = null, pass_until = null where email = 'you@example.com';`
   Their old test customer id is replaced automatically at their next checkout.
4. Open sign-up to everyone with `ACCOUNTS_MODE=on`, after the support
   mailbox exists and a lawyer has read `/terms` and `/privacy`.

**Sales tax.** Some states tax digital subscriptions. Ask the accountant;
if needed, Stripe Tax can be switched on (it costs 0.5% a transaction) and
checkout needs one line, `automatic_tax: { enabled: true }`.

## Affiliates

- **A discount code for an affiliate's audience:**
  - **Product catalog → Coupons → New**: e.g. 20% off, duration *Once*.
  - Then **Add promotion code**, using the affiliate's own code (e.g. `CREATOR`).
  - Checkout accepts promotion codes.
- **Who earns commission:** whoever is in `profiles.referred_by`, set by the
  `?ref=` link at sign-up. A promotion code alone is a discount; it does not
  move credit.
- **Monthly commission report**, for last calendar month, net of refunds,
  live payments only. Run it after the 30-day hold.

```sql
select a.code, a.name, a.email, a.commission_pct,
       count(*) as payments,
       sum(p.amount_cents - p.refunded_cents) / 100.0 as net_usd,
       round(sum(p.amount_cents - p.refunded_cents) * a.commission_pct / 100.0) / 100.0 as commission_usd
from payments p
join affiliates a on a.code = p.referred_by
join profiles pr on pr.id = p.profile_id
where p.livemode
  and p.paid_at >= date_trunc('month', now()) - interval '1 month'
  and p.paid_at <  date_trunc('month', now())
  and (a.commission_months is null or p.paid_at < pr.created_at + make_interval(months => a.commission_months))
group by a.code, a.name, a.email, a.commission_pct
order by commission_usd desc;
```

`net_usd` is what the customer paid less refunds, before Stripe's fees.
