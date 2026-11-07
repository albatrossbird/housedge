# Accounts: turning sign-in on

Stage 1 is built and **off** until `ACCOUNTS_MODE` is set. With it unset,
the site behaves exactly as before. These steps are all done in browser
dashboards, and no secret is ever pasted into chat or a file. Do them in
order: each needs the one before. Billing comes after, in
[billing-setup.md](billing-setup.md).

## 1. Run the migration

1. Open [`supabase/migrations/0033_accounts.sql`](https://github.com/albatrossbird/housedge/blob/main/supabase/migrations/0033_accounts.sql)
   and use **Copy raw file** (top right of the code).
2. Supabase → **SQL Editor → New query**, paste, **Run**. Expect "Success.
   No rows returned".

It creates `profiles` and `affiliates`, both private to the server: RLS is
on and anon has no access.

## 2. Email that comes from MarketSlap (Resend)

Supabase's built-in sender is limited to a few emails an hour and looks
like spam, so it is not usable for real sign-ins.

1. Sign up at resend.com. **Domains → Add domain**: `marketslap.com`, region
   **North Virginia (us-east-1)**.
2. It lists 3-4 DNS records (MX and TXT on `send`, TXT on
   `resend._domainkey`, optionally TXT on `_dmarc`). Add each where
   marketslap.com's DNS lives (**DNS → Records → Add record**):
   - Same type.
   - Name only the part shown (`send`, `resend._domainkey`).
   - The value copied with the copy button.
   - MX priority `10`.
3. Back in Resend, **Verify DNS Records**, and wait until every row says
   **Verified** (minutes, sometimes hours).
4. **API Keys → Create API key**:
   - Name `Supabase SMTP`, permission **Sending access**, domain `marketslap.com`.
   - Leave it on screen for the next step.
5. Supabase → **Authentication → Emails → SMTP Settings** → **Enable custom
   SMTP**, then **Save**:
   - Sender email `signin@marketslap.com`, sender name `MarketSlap`
   - Host `smtp.resend.com`, port `465`, username `resend`
   - Password: the Resend key
6. Supabase → **Authentication → Rate Limits**: email sending `100` per hour.
7. Supabase → **Authentication → Sign In / Providers**:
   - **Allow new users to sign up**: on.
   - **Email** provider: enabled, **Confirm email** on, **Email OTP Length**
     `6`, **Email OTP Expiration** `3600`.

## 3. Email templates

Supabase -> **Authentication -> Emails -> Templates**. New users get
**Confirm signup**; returning users get **Magic Link**. Both use the same
link and code, and only the wording differs.

**Confirm signup**, subject `Confirm your MarketSlap account`:

```html
<h2>Welcome to MarketSlap</h2>
<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">Confirm your account</a></p>
<p>Or enter this code on the sign-up page: <strong>{{ .Token }}</strong></p>
<p>The link and code expire in an hour. If you did not sign up, you can ignore this email.</p>
```

**Magic Link**, subject `Your MarketSlap login link`:

```html
<h2>Log in to MarketSlap</h2>
<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">Log in to MarketSlap</a></p>
<p>Or enter this code on the sign-up page: <strong>{{ .Token }}</strong></p>
<p>The link and code expire in an hour. If you did not ask for this, you can ignore this email.</p>
```

The link opens a page with a "Continue" button rather than signing in
straight away. Mail scanners open every link in an email, and a link that
signed in on open would be spent before you clicked it.

## 4. URLs

Supabase -> **Authentication -> URL Configuration**:
- Site URL: `https://marketslap.com`
- Redirect URLs: `https://marketslap.com/api/auth/callback`

## 5. Google sign-in

1. console.cloud.google.com → project picker → **New project** `MarketSlap`,
   then select it.
2. **APIs & Services → OAuth consent screen → Get started**, then **Create**:
   - App name `MarketSlap`, support email yours, audience **External**,
     contact email yours.
3. **Branding**, then **Save**:
   - Home page `https://marketslap.com`.
   - Privacy `https://marketslap.com/privacy`, terms `https://marketslap.com/terms`.
   - Authorized domains `marketslap.com` and `smoewpcbpjfcqpyswyli.supabase.co`.
   - **No logo**: a logo sends the app to Google's review.
4. **Data access → Add or remove scopes**: `openid`, `.../auth/userinfo.email`,
   `.../auth/userinfo.profile`. Only these, which need no Google review.
5. **Clients → Create client**, then **Create** and keep the ID and secret on
   screen:
   - Type **Web application**, name `MarketSlap web`.
   - JavaScript origin `https://marketslap.com`.
   - Redirect URI `https://smoewpcbpjfcqpyswyli.supabase.co/auth/v1/callback`.
6. **Audience → Publish app**. In "Testing" only listed test users can sign in.
7. Supabase → **Authentication → Sign In / Providers → Google**: enable, paste
   the client ID and secret, **Save**.

Google's chooser will say "to continue to smoewpcbpjfcqpyswyli.supabase.co".
Supabase's custom-domain add-on (`auth.marketslap.com`) changes that line;
it is optional and can come later.

## 6. Vercel environment variables

First, **Settings → Domains**: `www.marketslap.com` must redirect to
`marketslap.com`. A sign-in started on www and finished on the bare domain
loses its cookies.

Then **Settings → Environment Variables** (Production), then **redeploy**:

| Variable | Value |
|---|---|
| `ACCOUNTS_MODE` | `preview` |
| `ACCOUNTS_ALLOWLIST` | your email (comma-separated for more testers) |
| `SITE_URL` | `https://marketslap.com` |

`SUPABASE_SERVICE_ROLE_KEY` is already set (v2 uses it). Accounts need it,
and it must never be a `NEXT_PUBLIC_` variable.

In `preview`, only allowlisted emails can sign in, and the public sports
board stays whole for everyone else. `on` opens sign-in to everyone and
makes the public board the free view.

**Before `on`:**
- Create the `support@marketslap.com` mailbox the Terms and Privacy pages name.
- Have a lawyer read both pages.

## 7. Try it

In a private window:
- **Email link:** `https://marketslap.com/signup` → **Continue with email**.
  The email comes from MarketSlap (check spam). The link, then **Continue
  to MarketSlap**, lands you signed in on `/sports`.
- **Email code:** sign out on `/account`, then sign in again with the 6-digit
  code instead of the link.
- **Google:** **Continue with Google**.
- **Allowlist:** an email that is not on the allowlist is refused.
- **Plans:** give yourself a plan to see the paid view (SQL editor):
  `update profiles set plan = 'pro' where email = 'you@example.com';`
  Use `'free'` to see the locked view, or `'ev'`/`'arb'` for one board.
- **Affiliates:** add an affiliate code with
  `insert into affiliates (code, name, email) values ('CODE', 'Their name', 'their@email');`
  - Their link is `https://marketslap.com/?ref=CODE`.
  - If they have an account, also set `profile_id` to their profile's id.
    The account page then shows their link, and they cannot refer
    themselves.
