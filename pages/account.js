// Your account: email, plan, billing, your affiliate code if you have one,
// sign out. Checkout returns here with ?checkout=done&session_id=..., and
// the page applies that purchase at once (/api/billing/confirm) rather than
// waiting on the webhook.
import { useEffect, useState } from "react";
import AccountShell, { ACCENT, T, primary, secondary } from "../components/AccountShell.js";

const day = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null);

async function post(url, body = {}) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export default function Account() {
  const [me, setMe] = useState(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = () => fetch("/api/me?full=1").then(r => r.json());
    const q = new URLSearchParams(window.location.search);
    const sessionId = q.get("checkout") === "done" ? q.get("session_id") : null;
    (async () => {
      let j = await load();
      if (j.enabled && !j.user) { window.location.replace("/signup?next=/account"); return; }
      if (sessionId) {
        window.history.replaceState(null, "", "/account");
        setNotice("Payment received. Updating your plan…");
        setMe(j);
        try { await post("/api/billing/confirm", { session_id: sessionId }); j = await load(); setNotice("Payment received. Thank you!"); }
        catch { setNotice("Payment received. Your plan will update within a minute; refresh this page if it hasn't."); }
      }
      setMe(j);
    })().catch(() => setMe({ error: "Could not load your account." }));
  }, []);

  async function signOut() {
    await fetch("/api/auth/signout", { method: "POST" }).catch(() => {});
    window.location.assign("/");
  }
  async function manage() {
    setBusy(true); setError(null);
    try { window.location.assign((await post("/api/billing/portal")).url); return; }
    catch (e) { setError(e.message); }
    setBusy(false);
  }

  if (!me) return <AccountShell title="Account"><p style={{ color: T.muted, margin: 0 }}>Loading…</p></AccountShell>;
  if (!me.enabled) return <AccountShell title="Account"><p style={{ color: T.muted, margin: 0 }}>Accounts are not open yet.</p></AccountShell>;
  const link = me.affiliateCode && typeof window !== "undefined" ? `${window.location.origin}/?ref=${me.affiliateCode}` : null;
  const row = { display: "flex", justifyContent: "space-between", gap: 12, padding: "12px 0", borderBottom: `1px solid ${T.border}`, fontSize: 14 };
  const free = me.plan?.id === "free";

  return (
    <AccountShell title="Account">
      <h1 style={{ fontSize: 20, margin: "0 0 12px" }}>Your account</h1>
      {notice && <p role="status" style={{ background: `${T.yes}12`, color: T.yes, borderRadius: 8, padding: "10px 12px", fontSize: 14, margin: "0 0 8px" }}>{notice}</p>}
      <div style={row}><span style={{ color: T.muted }}>Email</span><span style={{ overflowWrap: "anywhere", textAlign: "right" }}>{me.user?.email}</span></div>
      <div style={row}>
        <span style={{ color: T.muted }}>Plan</span>
        <span style={{ textAlign: "right" }}>
          {me.plan?.name ?? "—"}
          {/* A paid plan's stored end carries a day's grace past the renewal (lib/billing/sync.js), so its dates are left to the billing portal. */}
          {me.plan?.until && !me.hasBilling && <span style={{ color: T.muted }}> · until {day(me.plan.until)}</span>}
          {me.plan?.passUntil && <span style={{ display: "block", color: T.muted, fontSize: 12 }}>Day pass until {new Date(me.plan.passUntil).toLocaleString()}</span>}
        </span>
      </div>
      {me.billing?.enabled
        ? (
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            {free && <a href="/pricing" style={{ ...primary, flex: 1, textAlign: "center", textDecoration: "none", boxSizing: "border-box" }}>See plans</a>}
            {me.hasBilling && <button onClick={manage} disabled={busy} style={{ ...secondary, flex: 1, opacity: busy ? 0.6 : 1 }}>{busy ? "Opening…" : "Manage billing"}</button>}
          </div>
        )
        : free && !me.plan?.passUntil && <p style={{ fontSize: 13, color: T.muted, margin: "12px 0 0" }}>Paid plans are coming soon.</p>}
      {me.billing?.test && <p style={{ fontSize: 12, color: T.muted, margin: "8px 0 0" }}>Billing is in Stripe test mode: no real money moves.</p>}
      {link && (
        <div style={{ ...row, flexDirection: "column", gap: 6 }}>
          <span style={{ color: T.muted }}>Your referral link</span>
          <button onClick={() => { navigator.clipboard?.writeText(link).then(() => setCopied(true)); }} style={{ ...secondary, fontSize: 13, padding: "8px 10px", textAlign: "left", overflowWrap: "anywhere", color: ACCENT }}>
            {copied ? "Copied" : link}
          </button>
        </div>
      )}
      {(me.error || error) && <p role="alert" style={{ color: T.no, fontSize: 13 }}>{error || me.error}</p>}
      <button onClick={signOut} style={{ ...secondary, marginTop: 20 }}>Sign out</button>
    </AccountShell>
  );
}
