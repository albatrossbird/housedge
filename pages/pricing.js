// Plans and prices. Amounts come from lib/billing/plans.js, the same list
// checkout charges from, so the page cannot quote a price Stripe does not.
//
// Arbs is the product sold on money; +EV rides inside Pro as a tool with a
// published record, never as a profit claim (decided 2026-11-11). Every
// button says what pressing it does right now: "Coming soon" while billing
// is off, "Sign up" when signed out, "Current plan" for the one held, "Switch
// plan" to move between paid plans (Stripe's portal prorates; a second
// checkout would bill twice).
import { useEffect, useState } from "react";
import AccountShell, { ACCENT, T, card } from "../components/AccountShell.js";
import { CATALOG, dollars } from "../lib/billing/plans.js";
import { FREE_EV_CAP } from "../lib/entitlements.js";

const cap = `+${Math.round(FREE_EV_CAP * 100)}%`;

const PLANS = [
  { id: "free", name: "Free", blurb: "See what MarketSlap finds.",
    features: ["Kalshi and Polymarket prices side by side, with search", `Sports +EV prices under ${cap}, with how picks like them have actually done`, "How many arbs are open right now, by sport"] },
  { id: "arb", name: CATALOG.arb.name, blurb: "Pregame arbs, for steady side income.", month: "arb", year: "arb_year",
    features: ["Every pregame arb we find across 17 sportsbooks and exchanges", "Returns after each venue's fees", "Stake calculator, with links that open the bet", "Filters for your books, kickoff window and bet types"] },
  { id: "pro", name: CATALOG.pro.name, blurb: "Arbs and +EV, with alerts.", month: "pro", year: "pro_year", best: true,
    features: ["Everything in Arbs", "Every +EV price, with quality flags and our published track record", ["Email alerts on your own conditions", "Soon"], ["A free 1:1 onboarding call", "Yearly"]] },
];

async function post(url, body = {}) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.manage = j.manage; throw e; }
  return j;
}

const btn = (kind, disabled) => ({
  display: "flex", alignItems: "center", justifyContent: "center", width: "100%", boxSizing: "border-box", minHeight: 46, padding: "0 16px",
  borderRadius: 999, textDecoration: "none", cursor: disabled ? "default" : "pointer", fontSize: 15, fontWeight: 700, fontFamily: "inherit",
  border: kind === "primary" ? 0 : `1px solid ${T.border}`, color: kind === "primary" ? T.onAccent : T.text,
  background: kind === "primary" ? ACCENT : T.raised, opacity: disabled ? 0.55 : 1,
});
const tag = (bg, fg) => ({ fontSize: 11, fontWeight: 750, letterSpacing: ".04em", padding: "3px 8px", borderRadius: 999, background: bg, color: fg, whiteSpace: "nowrap" });

export default function Pricing() {
  const [me, setMe] = useState(null);
  const [period, setPeriod] = useState("month");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { fetch("/api/me").then(r => r.json()).then(setMe).catch(() => setMe({ enabled: false })); }, []);

  const open = me?.billing?.enabled;
  const signedIn = Boolean(me?.user);
  const held = me?.plan?.id ?? "free";
  const paidHeld = signedIn && held !== "free" && me?.hasBilling;

  async function go(url, body, which) {
    setBusy(which); setError(null);
    try { window.location.assign((await post(url, body)).url); return; }
    catch (e) {
      if (e.manage) { try { window.location.assign((await post("/api/billing/portal")).url); return; } catch (e2) { setError(e2.message); } }
      else setError(e.message);
    }
    setBusy(null);
  }
  const buy = key => go("/api/billing/checkout", { plan: key }, key);
  const manage = () => go("/api/billing/portal", {}, "manage");

  function Action({ plan }) {
    const key = plan[period];
    if (!me) return <span style={btn("secondary", true)}>&nbsp;</span>;
    if (plan.id === "free") {
      if (signedIn) return <span style={btn("secondary", true)}>{held === "free" ? "Current plan" : "Included"}</span>;
      return me.enabled ? <a href="/signup?next=/pricing" style={btn("secondary")}>Sign up free</a> : <a href="/" style={btn("secondary")}>Use it now</a>;
    }
    const kind = plan.best ? "primary" : "secondary";
    if (!open) return <span style={btn(kind, true)}>Coming soon</span>;
    if (!signedIn) return <a href="/signup?next=/pricing" style={btn(kind)}>Sign up to subscribe</a>;
    if (held === plan.id && me?.hasBilling) return <button onClick={manage} disabled={!!busy} style={btn("secondary", !!busy)}>{busy === "manage" ? "Opening…" : "Current plan · Manage"}</button>;
    if (held === plan.id) return <span style={btn("secondary", true)}>Current plan</span>;
    if (held === "pro") return <span style={btn("secondary", true)}>Included in Pro</span>;
    if (paidHeld) return <button onClick={manage} disabled={!!busy} style={btn(kind, !!busy)}>{busy === "manage" ? "Opening…" : "Switch plan"}</button>;
    return <button onClick={() => buy(key)} disabled={!!busy} style={btn(kind, !!busy)}>{busy === key ? "Opening checkout…" : `Get ${plan.name}`}</button>;
  }

  function Price({ plan }) {
    if (!plan.month) return <div style={{ margin: "16px 0 2px" }}><span style={{ font: `800 34px/1 ${T.display}`, letterSpacing: "-0.02em" }}>$0</span><div style={{ fontSize: 13, color: T.muted, minHeight: 19, marginTop: 6 }}>Free for good</div></div>;
    const m = CATALOG[plan.month].amount, y = CATALOG[plan.year].amount;
    const yearly = period === "year";
    return (
      <div style={{ margin: "16px 0 2px" }}>
        <span className="num" style={{ font: `800 34px/1 ${T.display}`, letterSpacing: "-0.02em" }}>{dollars(yearly ? y : m)}</span>
        <span style={{ fontSize: 14, color: T.muted, marginLeft: 3 }}>{yearly ? "/year" : "/month"}</span>
        <div className="num" style={{ fontSize: 13, color: yearly ? T.yes : T.muted, minHeight: 19, marginTop: 6 }}>
          {yearly ? `${dollars(Math.round(y / 12))} a month, saving ${dollars(m * 12 - y)}` : `or ${dollars(y)} a year`}
        </div>
      </div>
    );
  }

  const passCovered = held === "pro";
  const passRunning = Boolean(me?.plan?.passUntil);
  const segBtn = on => ({ border: 0, borderRadius: 9, padding: "8px 16px", fontWeight: 650, fontSize: 14, fontFamily: "inherit", cursor: "pointer",
    background: on ? T.surface : "transparent", color: on ? T.text : T.muted, boxShadow: on ? T.shadow : "none" });

  return (
    <AccountShell title="Pricing" wide>
      <div style={{ textAlign: "center", maxWidth: 620, margin: "8px auto 22px", display: "grid", gap: 10, justifyItems: "center" }}>
        <h1 style={{ font: `800 clamp(28px, 6vw, 38px)/1.1 ${T.display}`, letterSpacing: "-0.02em", margin: 0 }}>Pricing</h1>
        <p style={{ color: T.muted, fontSize: 16, margin: 0, lineHeight: 1.5 }}>
          Prediction-market comparison stays free. Paid plans unlock every sports arb and +EV price. Cancel anytime.
        </p>
        {open && me?.billing?.test && <p style={{ ...tag(T.warnSoft, T.warn), fontSize: 13, fontWeight: 650, letterSpacing: 0, padding: "8px 14px", whiteSpace: "normal", margin: 0 }}>Test mode: pay with card 4242 4242 4242 4242, any future date and any CVC. No real money moves.</p>}
        <div role="group" aria-label="Billing period" style={{ display: "inline-flex", background: T.raised, borderRadius: 12, padding: 3, gap: 2, marginTop: 4 }}>
          <button type="button" aria-pressed={period === "month"} onClick={() => setPeriod("month")} style={segBtn(period === "month")}>Monthly</button>
          <button type="button" aria-pressed={period === "year"} onClick={() => setPeriod("year")} style={segBtn(period === "year")}>Yearly</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(280px, 100%), 1fr))", gap: 12, alignItems: "stretch" }}>
        {PLANS.map(plan => (
          <section key={plan.id} aria-label={plan.name} style={{ ...card, padding: "20px 18px", display: "flex", flexDirection: "column", position: "relative", border: `${plan.best ? 2 : 1}px solid ${plan.best ? ACCENT : T.border}` }}>
            {plan.best && <span style={{ ...tag(ACCENT, T.onAccent), position: "absolute", top: -11, left: 18 }}>BEST VALUE</span>}
            <div style={{ font: `750 18px/1.2 ${T.display}` }}>{plan.name}</div>
            <div style={{ fontSize: 14, color: T.muted, marginTop: 3 }}>{plan.blurb}</div>
            <Price plan={plan} />
            <ul style={{ listStyle: "none", padding: 0, margin: "16px 0 20px", display: "grid", alignContent: "start", gap: 10, fontSize: 14.5, lineHeight: 1.4, flex: 1 }}>
              {plan.features.map(f => {
                const [text, note] = Array.isArray(f) ? f : [f];
                if (note === "Yearly" && period !== "year") return null;
                return (
                  <li key={text} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                    <span aria-hidden="true" style={{ color: T.yes, fontWeight: 800 }}>✓</span>
                    <span style={{ flex: 1 }}>{text}</span>
                    {note && <span style={tag(note === "Soon" ? T.raised : T.yesSoft, note === "Soon" ? T.muted : T.yes)}>{note}</span>}
                  </li>
                );
              })}
            </ul>
            <Action plan={plan} />
          </section>
        ))}
      </div>

      <section aria-label="Day pass" style={{ ...card, marginTop: 12, padding: "16px 18px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: "999 1 260px" }}>
          <div style={{ font: `750 17px/1.2 ${T.display}` }}>{CATALOG.pass.name} · <span className="num">{dollars(CATALOG.pass.amount)}</span></div>
          <div style={{ fontSize: 14, color: T.muted, marginTop: 4, lineHeight: 1.45 }}>Everything in Pro for {CATALOG.pass.hours} hours. One payment, nothing renews. Try it on a big game day.</div>
        </div>
        <div style={{ flex: "1 1 220px" }}>
          {!me ? <span style={btn("secondary", true)}>&nbsp;</span>
            : !open ? <span style={btn("secondary", true)}>Coming soon</span>
            : !signedIn ? <a href="/signup?next=/pricing" style={btn("secondary")}>Sign up to buy</a>
            : passCovered ? <span style={btn("secondary", true)}>Included in Pro</span>
            : <button onClick={() => buy("pass")} disabled={!!busy} style={btn("secondary", !!busy)}>{busy === "pass" ? "Opening checkout…" : `${passRunning ? `Add ${CATALOG.pass.hours} hours` : "Buy a day pass"} · ${dollars(CATALOG.pass.amount)}`}</button>}
          {passRunning && !passCovered && <div style={{ fontSize: 12, color: T.muted, marginTop: 6, textAlign: "center" }}>Yours runs until {new Date(me.plan.passUntil).toLocaleString()}</div>}
        </div>
      </section>

      {error && <p role="alert" style={{ color: T.no, fontSize: 14, textAlign: "center", margin: "14px 0 0" }}>{error}</p>}

      <div style={{ maxWidth: 700, margin: "26px auto 0", fontSize: 13, color: T.muted, lineHeight: 1.6, textAlign: "center", display: "grid", gap: 8 }}>
        <p style={{ margin: 0 }}>
          Arbs pay the same whichever side wins, but they carry real risks: prices move before both bets are in, sportsbooks can void a bet,
          and they limit accounts that win. Returns are small per bet, usually under 1%.
        </p>
        <p style={{ margin: 0 }}>
          +EV is a tool, not a promise. It shows prices that beat the sportsbooks' consensus after fees, and we publish how picks like them have
          actually done: on the exchanges they have lost after fees.
        </p>
        <p style={{ margin: 0 }}>
          Prices in US dollars. Subscriptions renew automatically until you cancel; cancel anytime from your account and keep access to the end
          of the period you paid for. Taxes may be added where required. Payments are handled by Stripe. MarketSlap shows information and takes
          no bets.
        </p>
        <p style={{ margin: 0 }}><a href="/terms" style={{ color: T.muted }}>Terms</a> · <a href="/privacy" style={{ color: T.muted }}>Privacy</a></p>
      </div>
    </AccountShell>
  );
}
