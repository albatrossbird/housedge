# Accounts: turning sign-in on

Stage 1 is built and **off** until `ACCOUNTS_MODE` is set. With it unset,
the site behaves exactly as before. These steps are all done in browser
dashboards, and no secret is ever pasted into chat or a file.

## 1. Run the migration

[`supabase/migrations/0033_accounts.sql`](https://github.com/albatrossbird/housedge/blob/main/supabase/migrations/0033_accounts.sql)
in the Supabase SQL editor. It creates `profiles` and `affiliates`, both
private to the server: RLS is on and anon has no access.

## 2. Email that comes from MarketSlap (Resend)

Supabase's built-in sender is limited to a few emails an hour and looks
like spam, so it is not usable for real sign-ins.

1. Create a Resend account, then **Domains -> Add domain**: `marketslap.com`.
   Add the DNS records it lists at your domain registrar, then wait for
   "Verified".
2. Resend -> **API Keys -> Create** (sending access). Copy it straight into
   the next step.
3. Supabase -> **Authentication -> Emails -> SMTP Settings** -> enable custom SMTP:
   - Host `smtp.resend.com`, port `465`, username `resend`, password = the Resend key
   - Sender email `signin@marketslap.com`, sender name `MarketSlap`
4. Supabase -> **Authentication -> Rate Limits**: raise "emails sent per
   hour" (e.g. 100).

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

1. Google Cloud console -> new project "MarketSlap" -> **APIs & Services -> OAuth consent screen**:
   - External; app name MarketSlap; your support email; authorised domain `marketslap.com`.
   - Scopes: the defaults (email, profile) only. Those need no Google review.
2. **Credentials -> Create credentials -> OAuth client ID -> Web application**:
   - Authorised redirect URI: `https://smoewpcbpjfcqpyswyli.supabase.co/auth/v1/callback`
3. Copy the client ID and secret into Supabase -> **Authentication -> Sign In / Providers -> Google**, and enable it.

Google's chooser will say "to continue to smoewpcbpjfcqpyswyli.supabase.co".
Supabase's custom-domain add-on (`auth.marketslap.com`) changes that line;
it is optional and can come later.

## 6. Vercel environment variables

Project -> Settings -> Environment Variables (Production), then **redeploy**:

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

**Before `on`:** fill in `state` (where the LLC was formed) in
`lib/legal.js`, which sets the governing-law clause on `/terms`. Create
the `support@marketslap.com` mailbox the Terms and Privacy pages name.
Have a lawyer read both pages.

## 7. Try it

- `https://marketslap.com/signup`: try both email and Google.
- `https://marketslap.com/account`: shows your plan.
- Give yourself a plan to see the paid view (SQL editor):
  `update profiles set plan = 'pro' where email = 'you@example.com';`
  Use `'free'` to see the locked view, or `'ev'`/`'arb'` for one board.
- Add an affiliate code:
  `insert into affiliates (code, name, email) values ('CODE', 'Their name', 'their@email');`
  Their link is `https://marketslap.com/?ref=CODE`. If they have an account,
  also set `profile_id` to their profile's id so the account page shows
  their link and they cannot refer themselves.
