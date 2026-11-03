// Your account: email, plan, your affiliate code if you have one, sign out.
import { useEffect, useState } from "react";
import AccountShell, { ACCENT, T, secondary } from "../components/AccountShell.js";

const day = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null);

export default function Account() {
  const [me, setMe] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    fetch("/api/me?full=1").then(r => r.json()).then(j => {
      if (j.enabled && !j.user) window.location.replace("/signin?next=/account");
      else setMe(j);
    }).catch(() => setMe({ error: "Could not load your account." }));
  }, []);

  async function signOut() {
    await fetch("/api/auth/signout", { method: "POST" }).catch(() => {});
    window.location.assign("/");
  }

  if (!me) return <AccountShell title="Account"><p style={{ color: T.muted, margin: 0 }}>Loading…</p></AccountShell>;
  if (!me.enabled) return <AccountShell title="Account"><p style={{ color: T.muted, margin: 0 }}>Accounts are not open yet.</p></AccountShell>;
  const link = me.affiliateCode && typeof window !== "undefined" ? `${window.location.origin}/?ref=${me.affiliateCode}` : null;
  const row = { display: "flex", justifyContent: "space-between", gap: 12, padding: "12px 0", borderBottom: `1px solid ${T.border}`, fontSize: 14 };

  return (
    <AccountShell title="Account">
      <h1 style={{ fontSize: 20, margin: "0 0 12px" }}>Your account</h1>
      <div style={row}><span style={{ color: T.muted }}>Email</span><span style={{ overflowWrap: "anywhere", textAlign: "right" }}>{me.user?.email}</span></div>
      <div style={row}>
        <span style={{ color: T.muted }}>Plan</span>
        <span style={{ textAlign: "right" }}>
          {me.plan?.name ?? "—"}
          {me.plan?.until && <span style={{ color: T.muted }}> · until {day(me.plan.until)}</span>}
          {me.plan?.passUntil && <span style={{ display: "block", color: T.muted, fontSize: 12 }}>Day pass until {new Date(me.plan.passUntil).toLocaleString()}</span>}
        </span>
      </div>
      {me.plan?.id === "free" && !me.plan?.passUntil && <p style={{ fontSize: 13, color: T.muted, margin: "12px 0 0" }}>Paid plans are coming soon.</p>}
      {link && (
        <div style={{ ...row, flexDirection: "column", gap: 6 }}>
          <span style={{ color: T.muted }}>Your referral link</span>
          <button onClick={() => { navigator.clipboard?.writeText(link).then(() => setCopied(true)); }} style={{ ...secondary, fontSize: 13, padding: "8px 10px", textAlign: "left", overflowWrap: "anywhere", color: ACCENT }}>
            {copied ? "Copied" : link}
          </button>
        </div>
      )}
      {me.error && <p role="alert" style={{ color: T.no, fontSize: 13 }}>{me.error}</p>}
      <button onClick={signOut} style={{ ...secondary, marginTop: 20 }}>Sign out</button>
    </AccountShell>
  );
}
