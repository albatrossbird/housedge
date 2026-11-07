// Plans and prices. Amounts come from lib/billing/plans.js, the same list
// checkout charges from, so the page cannot quote a price Stripe does not.
//
// Every button says what pressing it does right now: "Coming soon" while
// billing is off, "Sign up" when signed out, "Current plan" for the one held,
// "Manage billing" to switch from a paid plan (Stripe's portal prorates; a
// second checkout would bill twice).
import { useEffect, useState } from "react";
import AccountShell, { ACCENT, T } from "../components/AccountShell.js";
import { CATALOG, dollars } from "../lib/billing/plans.js";
import { FREE_EV_CAP } from "../lib/entitlements.js";

const cap = `+${Math.round(FREE_EV_CAP * 100)}%`;
const YEAR_SAVES = CATALOG.pro.amount * 12 - CATALOG.pro_year.amount;

const PLANS = [
  { id: "free", name: "Free", price: "$0", per: "", blurb: "See what MarketSlap finds.",
    features: ["Kalshi and Polymarket prices side by side, with search", `Sports +EV prices under ${cap}`, "How many bigger edges and arbitrages there are, by sport"] },
  { id: "ev", key: "ev", name: CATALOG.ev.name, price: dollars(CATALOG.ev.amount), per: "/month", blurb: "For betting value, game by game.",
    features: [`Every +EV price on the sports board, not just those under ${cap}`, "Fair price, EV after fees, and the book's limit", "A link straight to each bet"] },
  { id: "arb", key: "arb", name: CATALOG.arb.name, price: dollars(CATALOG.arb.amount), per: "/month", blurb: "For locking in both sides.",
    features: ["Every arbitrage on the sports board", "Both legs, the return after fees, and the most you can stake", "A link to each leg"] },
  { id: "pro", key: "pro", yearKey: "pro_year", name: CATALOG.pro.name, price: dollars(CATALOG.pro.amount), per: "/month", blurb: "Both boards.", best: true,
    features: ["Everything in +EV", "Everything in Arbitrage"] },
];

async function post(url, body = {}) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.manage = j.manage; throw e; }
  return j;
}

const btn = (kind, disabled) => ({
  display: "block", width: "100%", boxSizing: "border-box", textAlign: "center", textDecoration: "none", cursor: disabled ? "default" : "pointer",
  border: kind === "primary" ? 0 : `1px solid ${T.border}`, borderRadius: 8, padding: "11px 12px", fontSize: 14, fontWeight: 600, fontFamily: "inherit",
  color: kind === "primary" ? "#fff" : T.text, background: kind === "primary" ? ACCENT : T.surface, opacity: disabled ? 0.55 : 1,
});

export default function Pricing() {
  const [me, setMe] = useState(null);
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

  // One button per plan, saying what it does now.
  function Action({ plan, k = plan.key, label = "Subscribe", kind = "primary" }) {
    if (!me) return <span style={btn(kind, true)}>&nbsp;</span>;
    if (plan.id === "free") {
      if (signedIn) return <span style={btn("secondary", true)}>{held === "free" ? "Current plan" : "Included"}</span>;
      return me.enabled ? <a href="/signup?next=/pricing" style={btn("secondary")}>Sign up free</a> : <a href="/" style={btn("secondary")}>Use it now</a>;
    }
    if (!open) return <span style={btn(kind, true)}>Coming soon</span>;
    if (!signedIn) return <a href="/signup?next=/pricing" style={btn(kind)}>Sign up to subscribe</a>;
    if (held === plan.id && me?.hasBilling) return <button onClick={manage} disabled={!!busy} style={btn("secondary", !!busy)}>{busy === "manage" ? "Opening…" : "Current plan · Manage"}</button>;
    if (held === plan.id || held === "pro") return <span style={btn("secondary", true)}>{held === plan.id ? "Current plan" : "Included in your plan"}</span>;
    if (paidHeld) return <button onClick={manage} disabled={!!busy} style={btn(kind, !!busy)}>{busy === "manage" ? "Opening…" : "Switch plan"}</button>;
    return <button onClick={() => buy(k)} disabled={!!busy} style={btn(kind, !!busy)}>{busy === k ? "Opening checkout…" : label}</button>;
  }

  const passCovered = held === "pro";
  const passRunning = Boolean(me?.plan?.passUntil);

  return (
    <AccountShell title="Pricing" wide>
      <div style={{ textAlign: "center", maxWidth: 620, margin: "0 auto 28px" }}>
        <h1 style={{ fontSize: "clamp(24px, 5vw, 32px)", margin: "0 0 8px" }}>Pricing</h1>
        <p style={{ color: T.muted, fontSize: 15, margin: 0, lineHeight: 1.5 }}>
          Prediction-market comparison stays free. Paid plans unlock the whole sports board. Cancel anytime.
        </p>
        {open && me?.billing?.test && <p style={{ fontSize: 13, color: T.no, margin: "10px 0 0" }}>Test mode: pay with card 4242 4242 4242 4242, any future date and any CVC. No real money moves.</p>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(230px, 100%), 1fr))", gap: 14, alignItems: "stretch" }}>
        {PLANS.map(plan => (
          <div key={plan.id} style={{ background: T.surface, border: `${plan.best ? 2 : 1}px solid ${plan.best ? ACCENT : T.border}`, borderRadius: 12, padding: "20px 18px", display: "flex", flexDirection: "column", position: "relative" }}>
            {plan.best && <span style={{ position: "absolute", top: -11, left: 18, background: ACCENT, color: "#fff", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", borderRadius: 99, padding: "3px 10px" }}>BEST VALUE</span>}
            <div style={{ fontSize: 16, fontWeight: 700 }}>{plan.name}</div>
            <div style={{ fontSize: 13, color: T.muted, marginTop: 2 }}>{plan.blurb}</div>
            <div style={{ margin: "14px 0 4px" }}>
              <span style={{ fontSize: 30, fontWeight: 800 }}>{plan.price}</span>
              <span style={{ fontSize: 14, color: T.muted }}>{plan.per}</span>
            </div>
            {plan.yearKey
              ? <div style={{ fontSize: 13, color: T.muted, minHeight: 20 }}>or {dollars(CATALOG.pro_year.amount)} a year, saving {dollars(YEAR_SAVES)}</div>
              : <div style={{ minHeight: 20 }} />}
            <ul style={{ listStyle: "none", padding: 0, margin: "14px 0 18px", display: "grid", alignContent: "start", gap: 8, fontSize: 14, lineHeight: 1.4, flex: 1 }}>
              {plan.features.map(f => (
                <li key={f} style={{ display: "flex", gap: 8 }}><span aria-hidden="true" style={{ color: T.yes, fontWeight: 700 }}>✓</span><span>{f}</span></li>
              ))}
            </ul>
            <div style={{ display: "grid", gap: 8 }}>
              <Action plan={plan} />
              {plan.yearKey && open && signedIn && !paidHeld && held !== "pro" && <Action plan={plan} k={plan.yearKey} label={`Pay yearly · ${dollars(CATALOG.pro_year.amount)}`} kind="secondary" />}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 14, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "16px 18px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: "999 1 260px" }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{CATALOG.pass.name} · {dollars(CATALOG.pass.amount)}</div>
          <div style={{ fontSize: 14, color: T.muted, marginTop: 2 }}>Everything in Sports Pro for {CATALOG.pass.hours} hours. One payment, nothing renews. A good way to try it on a big game day.</div>
        </div>
        {/* The text takes the row's spare width; wrapped onto its own line on a phone, the button takes all of it. */}
        <div style={{ flex: "1 1 220px" }}>
          {!me ? <span style={btn("secondary", true)}>&nbsp;</span>
            : !open ? <span style={btn("secondary", true)}>Coming soon</span>
            : !signedIn ? <a href="/signup?next=/pricing" style={btn("secondary")}>Sign up to buy</a>
            : passCovered ? <span style={btn("secondary", true)}>Included in your plan</span>
            : <button onClick={() => buy("pass")} disabled={!!busy} style={btn("secondary", !!busy)}>{busy === "pass" ? "Opening checkout…" : `${passRunning ? `Add ${CATALOG.pass.hours} hours` : "Buy a day pass"} · ${dollars(CATALOG.pass.amount)}`}</button>}
          {passRunning && !passCovered && <div style={{ fontSize: 12, color: T.muted, marginTop: 6, textAlign: "center" }}>Yours runs until {new Date(me.plan.passUntil).toLocaleString()}</div>}
        </div>
      </div>

      {error && <p role="alert" style={{ color: T.no, fontSize: 14, textAlign: "center", margin: "14px 0 0" }}>{error}</p>}

      <div style={{ maxWidth: 680, margin: "24px auto 0", fontSize: 13, color: T.muted, lineHeight: 1.6, textAlign: "center" }}>
        <p style={{ margin: "0 0 8px" }}>
          Prices in US dollars. Subscriptions renew automatically until you cancel; cancel anytime from your account and keep
          access to the end of the period you paid for. Taxes may be added where required. Payments are handled by Stripe.
        </p>
        <p style={{ margin: "0 0 8px" }}>
          MarketSlap shows information and takes no bets. Prices move and estimates can be wrong; no profit is guaranteed.
        </p>
        <p style={{ margin: 0 }}><a href="/terms" style={{ color: T.muted }}>Terms</a> · <a href="/privacy" style={{ color: T.muted }}>Privacy</a></p>
      </div>
    </AccountShell>
  );
}
