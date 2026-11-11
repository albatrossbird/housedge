// Terms of Service. A plain-language draft for MarketSlap LLC, written
// around what the site actually does (lib/legal.js holds the facts). Have a
// lawyer review it before paid plans launch.
import LegalPage, { h2, p, li } from "../components/LegalPage.js";
import { LEGAL, stateName } from "../lib/legal.js";

export default function Terms() {
  const E = LEGAL.entity;
  return (
    <LegalPage title="Terms of Service">
      <p style={p}>
        These terms are an agreement between you and {E} ("MarketSlap", "we", "us") about your use of {LEGAL.site} and
        anything we provide through it (the "Service"). By creating an account or using the Service, you agree to them.
        If you do not agree, do not use the Service.
      </p>

      <h2 style={h2}>1. Who can use MarketSlap</h2>
      <p style={p}>
        You must be at least 18 years old. You are responsible for knowing and following the laws that apply to you,
        including any rules about where and whether you may trade or bet on the venues we show. The Service is not offered
        anywhere it would be unlawful to offer it.
      </p>

      <h2 style={h2}>2. What MarketSlap is, and is not</h2>
      <p style={p}>
        MarketSlap is an information service. We compare publicly available prices from prediction markets and sportsbooks
        and show calculations based on them, such as price gaps, expected value estimates and arbitrage pairs.
      </p>
      <ul style={{ paddingLeft: 20, margin: "0 0 10px" }}>
        <li style={li}>We do not accept bets or orders, hold your money, or place trades for you.</li>
        <li style={li}>We are not a sportsbook, exchange, broker or adviser, and nothing on the Service is financial, investment, betting or legal advice.</li>
        <li style={li}>We are not affiliated with, endorsed by or operated by any venue we show. Their names and marks belong to them.</li>
      </ul>

      <h2 style={h2}>3. Prices and calculations can be wrong</h2>
      <p style={p}>
        Prices move constantly, and what we show may be delayed, incomplete or inaccurate. Two markets we display side by
        side may have different rules, settlement sources or deadlines. Fees, limits and availability vary by venue and by
        account. Estimates such as "expected value" are models, not promises, and past results do not predict future ones.
      </p>
      <p style={p}>
        Always check the price, rules and fees on the venue itself before you act. Any decision you make is yours, and you
        are responsible for any losses. We do not guarantee any profit or outcome.
      </p>

      <h2 style={h2}>4. Your account</h2>
      <p style={p}>
        You sign in with an email link or a third-party login such as Google. Keep access to that email account secure.
        One account is for one person; do not share it or let others use your subscription. You are responsible for
        activity on your account. We may suspend or close accounts that break these terms.
      </p>

      <h2 style={h2}>5. Plans, payments and cancellation</h2>
      <ul style={{ paddingLeft: 20, margin: "0 0 10px" }}>
        <li style={li}>Some features need a paid plan. Prices and what each plan includes are shown before you buy.</li>
        <li style={li}>Payments are processed by Stripe. We do not see or store your full card number.</li>
        <li style={li}>Subscriptions are billed in advance and renew automatically each period until you cancel. You can cancel at any time; access continues to the end of the period you have paid for.</li>
        <li style={li}>A day pass is a one-time purchase for the stated period and does not renew.</li>
        <li style={li}>A trial costs the amount shown and lasts the stated number of days. When it ends it becomes a paid subscription at the regular price shown before you start, unless you cancel before it ends. Cancel anytime from your account. One trial per person.</li>
        <li style={li}>Except where the law requires otherwise, payments are not refundable, including for partly used periods. If something went wrong on our side, contact us and we will look at it.</li>
        <li style={li}>We may change prices. A change to a subscription you hold takes effect at your next renewal, and we will tell you in advance.</li>
        <li style={li}>Prices do not include taxes, which may be added where required.</li>
      </ul>

      <h2 style={h2}>6. Acceptable use</h2>
      <p style={p}>You agree not to:</p>
      <ul style={{ paddingLeft: 20, margin: "0 0 10px" }}>
        <li style={li}>copy, resell, republish or redistribute the Service's data or results, in whole or in large part;</li>
        <li style={li}>scrape, crawl or access the Service by automated means, except as we expressly allow;</li>
        <li style={li}>get around any limit, paywall or security measure, or access features your plan does not include;</li>
        <li style={li}>share your login or subscription with others;</li>
        <li style={li}>use the Service for anything unlawful, or interfere with its operation.</li>
      </ul>

      <h2 style={h2}>7. Referral program</h2>
      <p style={p}>
        If we invite you to refer others, the commission terms we agree with you apply alongside these terms. Referrers
        must clearly disclose that they are paid, must not promise or imply guaranteed profits, and must not target anyone
        under 18. We may withhold or reverse commissions for refunded or charged-back payments, self-referrals, or misleading
        promotion. Customers who arrive through a referral pay the same price as everyone else unless an offer says otherwise.
      </p>

      <h2 style={h2}>8. Our content</h2>
      <p style={p}>
        The Service, including its software, design and analysis, belongs to {E}. We give you a personal, non-transferable
        right to use it under these terms while your account is in good standing. Market data shown on the Service comes
        from third parties and remains subject to their rights.
      </p>

      <h2 style={h2}>9. Links to other sites</h2>
      <p style={p}>
        We link to venues and other sites we do not control. Your use of them is governed by their own terms, and we are not
        responsible for them.
      </p>

      <h2 style={h2}>10. Disclaimers</h2>
      <p style={p}>
        THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS OR IMPLIED,
        INCLUDING WARRANTIES OF ACCURACY, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT. WE DO NOT
        WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, TIMELY OR ERROR-FREE.
      </p>

      <h2 style={h2}>11. Limitation of liability</h2>
      <p style={p}>
        TO THE FULLEST EXTENT THE LAW ALLOWS, {E.toUpperCase()} WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
        CONSEQUENTIAL OR PUNITIVE DAMAGES, OR FOR ANY TRADING OR BETTING LOSSES, LOST PROFITS OR LOST DATA, ARISING FROM YOUR
        USE OF THE SERVICE. OUR TOTAL LIABILITY FOR ANY CLAIM IS LIMITED TO THE GREATER OF THE AMOUNT YOU PAID US IN THE 12
        MONTHS BEFORE THE CLAIM AND $100.
      </p>

      <h2 style={h2}>12. Indemnity</h2>
      <p style={p}>
        You agree to cover {E}'s reasonable losses and costs, including legal fees, arising from your breach of these terms
        or your misuse of the Service.
      </p>

      <h2 style={h2}>13. Ending your use</h2>
      <p style={p}>
        You can stop using the Service and delete your account at any time by contacting us. We may suspend or end your
        access if you break these terms or if we stop offering the Service. Sections 3, 8 and 10 to 15 continue to apply
        after your access ends.
      </p>

      <h2 style={h2}>14. Governing law</h2>
      <p style={p}>
        These terms are governed by the laws of {stateName()}, without regard to its conflict-of-law rules. Any dispute will
        be handled in the state or federal courts located there, and you and we consent to their jurisdiction.
      </p>

      <h2 style={h2}>15. Changes to these terms</h2>
      <p style={p}>
        We may update these terms. If a change is material, we will tell you by email or on the site before it takes effect.
        Continuing to use the Service after that means you accept the updated terms.
      </p>

      <h2 style={h2}>16. Contact</h2>
      <p style={p}>
        {E} · <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>
      </p>
      <p style={p}>
        If gambling is causing problems for you or someone you know, free and confidential help is available at
        1-800-GAMBLER.
      </p>
    </LegalPage>
  );
}
