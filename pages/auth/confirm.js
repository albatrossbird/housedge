// Where the emailed link lands: ?token_hash=...&type=email.
//
// A button, not an automatic sign-in. Mail scanners open every link in an
// email; if opening the link spent it, the person who clicks would get
// "expired". Scanners do not press buttons.
import { useState } from "react";
import { useRouter } from "next/router";
import AccountShell, { T, primary } from "../../components/AccountShell.js";

export default function Confirm() {
  const router = useRouter();
  const { token_hash: tokenHash, type, next } = router.query;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function finish() {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/auth/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token_hash: tokenHash, type }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      window.location.assign(typeof next === "string" && /^\/(?![/\\])/.test(next) ? next : "/sports");
      return;
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  return (
    <AccountShell title="Continue to MarketSlap">
      <h1 style={{ fontSize: 20, margin: "0 0 6px" }}>Almost there</h1>
      {router.isReady && !tokenHash ? (
        <p style={{ color: T.muted, fontSize: 14 }}>This link is incomplete. <a href="/signup">Request a new one.</a></p>
      ) : (
        <>
          <p style={{ margin: "0 0 18px", color: T.muted, fontSize: 14 }}>One more click and you are in.</p>
          <button onClick={finish} disabled={busy || !router.isReady} style={{ ...primary, opacity: busy ? 0.6 : 1 }}>{busy ? "Signing in…" : "Continue to MarketSlap"}</button>
          {error && <p role="alert" style={{ margin: "14px 0 0", color: T.no, fontSize: 13 }}>{error} {/expired/.test(error) && <a href="/signup">Get a new link.</a>}</p>}
        </>
      )}
    </AccountShell>
  );
}
