// Sign in or create an account: Google, or an emailed link (with a code in
// the same email, for opening it on a different device). No passwords.
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import AccountShell, { ACCENT, T, input, primary, secondary } from "../components/AccountShell.js";

const ERRORS = { agree: "Please confirm you are 18 or older." };

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/>
    </svg>
  );
}

export default function SignIn() {
  const router = useRouter();
  const next = typeof router.query.next === "string" ? router.query.next : "/sports";
  const [me, setMe] = useState(null);
  const [email, setEmail] = useState("");
  const [agree, setAgree] = useState(false);
  const [sentTo, setSentTo] = useState(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { fetch("/api/me").then(r => r.json()).then(setMe).catch(() => setMe({ enabled: false })); }, []);
  useEffect(() => { if (router.query.error) setError(ERRORS[router.query.error] || String(router.query.error)); }, [router.query.error]);
  useEffect(() => { if (me?.user) router.replace(next); }, [me, next, router]);

  async function send(e) {
    e?.preventDefault();
    if (!agree) return setError(ERRORS.agree);
    setBusy(true); setError(null);
    try { await post("/api/auth/send", { email, agree: true }); setSentTo(email.trim().toLowerCase()); }
    catch (err) { setError(err.message); }
    setBusy(false);
  }
  async function verify(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await post("/api/auth/verify", { email: sentTo, code }); window.location.assign(next); return; }
    catch (err) { setError(err.message); }
    setBusy(false);
  }
  function google() {
    if (!agree) return setError(ERRORS.agree);
    window.location.assign(`/api/auth/google?agree=1&next=${encodeURIComponent(next)}`);
  }

  if (me && !me.enabled) {
    return <AccountShell title="Sign in"><h1 style={{ fontSize: 20, margin: 0 }}>Accounts are coming soon</h1>
      <p style={{ color: T.muted, fontSize: 14, lineHeight: 1.5 }}>MarketSlap accounts are not open yet. Everything on the site is free to use in the meantime.</p></AccountShell>;
  }

  return (
    <AccountShell title="Sign in">
      {!sentTo ? (
        <>
          <h1 style={{ fontSize: 20, margin: "0 0 6px" }}>Sign in to MarketSlap</h1>
          <p style={{ margin: "0 0 20px", color: T.muted, fontSize: 14 }}>New here? This creates your account. No password needed.</p>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14, lineHeight: 1.4, marginBottom: 18, cursor: "pointer" }}>
            <input type="checkbox" checked={agree} onChange={e => { setAgree(e.target.checked); setError(null); }} style={{ marginTop: 2, width: 16, height: 16, accentColor: ACCENT }} />
            <span>I am 18 or older, and I will only bet where it is legal for me (21 or older in most US states).</span>
          </label>
          <button type="button" onClick={google} style={{ ...secondary, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
            <GoogleMark /> Continue with Google
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0", color: T.muted, fontSize: 12 }}>
            <span style={{ flex: 1, height: 1, background: T.border }} />or<span style={{ flex: 1, height: 1, background: T.border }} />
          </div>
          <form onSubmit={send}>
            <input type="email" required autoComplete="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} style={input} />
            <button type="submit" disabled={busy} style={{ ...primary, marginTop: 10, opacity: busy ? 0.6 : 1 }}>{busy ? "Sending…" : "Email me a sign-in link"}</button>
          </form>
        </>
      ) : (
        <>
          <h1 style={{ fontSize: 20, margin: "0 0 6px" }}>Check your email</h1>
          <p style={{ margin: "0 0 18px", color: T.muted, fontSize: 14, lineHeight: 1.5 }}>
            We sent a sign-in link to <b style={{ color: T.text }}>{sentTo}</b>. Open it on this device, or type the code from the email here.
          </p>
          <form onSubmit={verify}>
            <input inputMode="numeric" autoComplete="one-time-code" placeholder="Code" value={code} onChange={e => setCode(e.target.value)} style={{ ...input, letterSpacing: "0.2em", fontSize: 18, textAlign: "center" }} />
            <button type="submit" disabled={busy || code.trim().length < 6} style={{ ...primary, marginTop: 10, opacity: busy || code.trim().length < 6 ? 0.6 : 1 }}>{busy ? "Signing in…" : "Sign in"}</button>
          </form>
          <div style={{ marginTop: 16, fontSize: 13, color: T.muted, display: "flex", justifyContent: "space-between" }}>
            <button type="button" onClick={() => { setSentTo(null); setCode(""); setError(null); }} style={{ background: "none", border: 0, color: ACCENT, cursor: "pointer", padding: 0, fontFamily: "inherit", fontSize: 13 }}>Use a different email</button>
            <button type="button" disabled={busy} onClick={() => { setEmail(sentTo); send(); }} style={{ background: "none", border: 0, color: ACCENT, cursor: "pointer", padding: 0, fontFamily: "inherit", fontSize: 13 }}>Send again</button>
          </div>
        </>
      )}
      {error && <p role="alert" style={{ margin: "14px 0 0", color: T.no, fontSize: 13 }}>{error}</p>}
    </AccountShell>
  );
}
