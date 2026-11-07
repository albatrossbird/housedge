// Privacy Policy. A plain-language draft for MarketSlap LLC, written around
// what the code actually collects (lib/auth/*, migration 0033) and the
// services it actually uses. Update it when either changes, and have a
// lawyer review it before paid plans launch.
import LegalPage, { h2, p, li } from "../components/LegalPage.js";
import { LEGAL } from "../lib/legal.js";

const ul = { paddingLeft: 20, margin: "0 0 10px" };

export default function Privacy() {
  const E = LEGAL.entity;
  return (
    <LegalPage title="Privacy Policy">
      <p style={p}>
        This policy explains what {E} ("MarketSlap", "we", "us") collects when you use {LEGAL.site}, why, and the choices
        you have. We collect as little as we need to run the Service, and we do not sell your personal information.
      </p>

      <h2 style={h2}>1. What we collect</h2>
      <ul style={ul}>
        <li style={li}><b>Account details:</b> your email address. If you sign in with Google, we receive your email address and basic profile details from Google; we do not receive your Google password.</li>
        <li style={li}><b>Your agreement:</b> when you confirmed you are 18 or older and accepted our terms.</li>
        <li style={li}><b>Plan and billing status:</b> which plan you hold, until when, an identifier for your customer record at Stripe, and a record of each payment (amount, date and any refund). Stripe handles your card details; we never see or store your full card number.</li>
        <li style={li}><b>Referral:</b> if you arrived through a referral link, the referral code that brought you.</li>
        <li style={li}><b>Technical information:</b> like most websites, our hosting and database providers log requests, including IP address, browser type and the pages requested, to run and secure the Service.</li>
      </ul>
      <p style={p}>
        We do not use advertising trackers, and we do not ask for your betting or trading accounts or their passwords.
      </p>

      <h2 style={h2}>2. Cookies</h2>
      <p style={p}>We use a small number of cookies, all needed for the Service to work:</p>
      <ul style={ul}>
        <li style={li}><b>Sign-in cookies</b> keep you signed in. They cannot be read by scripts on the page.</li>
        <li style={li}><b>A referral cookie</b> remembers a referral code for up to 60 days, so the right person is credited if you sign up.</li>
        <li style={li}><b>Short-lived sign-in cookies</b> (about 10 minutes) are used while you sign in with Google.</li>
      </ul>

      <h2 style={h2}>3. How we use it</h2>
      <ul style={ul}>
        <li style={li}>to create your account, sign you in and keep it secure;</li>
        <li style={li}>to provide the features your plan includes, and to process payments;</li>
        <li style={li}>to credit referrals and pay referrers;</li>
        <li style={li}>to send you emails about your account, such as sign-in links and receipts, and occasional product updates you can opt out of;</li>
        <li style={li}>to prevent abuse, fix problems and improve the Service;</li>
        <li style={li}>to meet legal, tax and accounting obligations.</li>
      </ul>

      <h2 style={h2}>4. Who we share it with</h2>
      <p style={p}>We share information only with service providers that run parts of the Service for us, under their own privacy and security commitments:</p>
      <ul style={ul}>
        <li style={li}><b>Supabase</b> — database and sign-in;</li>
        <li style={li}><b>Vercel</b> — website hosting;</li>
        <li style={li}><b>Stripe</b> — payments;</li>
        <li style={li}><b>Resend</b> — sending emails;</li>
        <li style={li}><b>Google</b> — only if you choose to sign in with Google.</li>
      </ul>
      <p style={p}>
        Referrers see counts and commission totals, not who you are. We may also disclose information if the law requires
        it, to protect our rights or users, or as part of a sale or reorganisation of the business. We do not sell or rent
        personal information.
      </p>

      <h2 style={h2}>5. How long we keep it</h2>
      <p style={p}>
        We keep your account information while your account is open. When you ask us to delete your account, we delete
        your personal information, except records we must keep for tax, accounting or legal reasons, such as payment
        records.
      </p>

      <h2 style={h2}>6. Your choices and rights</h2>
      <p style={p}>
        You can ask us for a copy of your information, to correct it, or to delete your account, by emailing{" "}
        <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>. Depending on where you live, you may have further rights under
        local law; we will honour requests as the law requires and will not treat you differently for making one. You can
        unsubscribe from product emails at any time.
      </p>

      <h2 style={h2}>7. Security</h2>
      <p style={p}>
        We use encryption in transit, keep account data on the server rather than in your browser, and limit who can access
        it. No system is perfectly secure, and we will tell you if a breach affects your information as the law requires.
      </p>

      <h2 style={h2}>8. Age</h2>
      <p style={p}>
        The Service is for people 18 and older. We do not knowingly collect information from anyone under 18; if we learn
        that we have, we will delete it.
      </p>

      <h2 style={h2}>9. Changes</h2>
      <p style={p}>
        We may update this policy. If a change is material, we will tell you by email or on the site before it takes effect.
      </p>

      <h2 style={h2}>10. Contact</h2>
      <p style={p}>
        {E} · <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>
      </p>
    </LegalPage>
  );
}
