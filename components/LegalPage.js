// The frame for /terms and /privacy: the site header and a readable column.
import Head from "next/head";
import { T } from "./AccountShell.js";
import { LEGAL } from "../lib/legal.js";

export const h2 = { fontSize: 17, margin: "28px 0 8px" };
export const p = { margin: "0 0 10px", fontSize: 15, lineHeight: 1.65, color: T.text };
export const li = { margin: "0 0 6px", fontSize: 15, lineHeight: 1.6 };

export default function LegalPage({ title, children }) {
  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "'Inter', system-ui, sans-serif", color: T.text }}>
      <Head><title>{`${title} · MarketSlap`}</title></Head>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "0 clamp(12px, 4vw, 24px)" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", minHeight: 56, display: "flex", alignItems: "center", gap: 12 }}>
          <a href="/" aria-label="MarketSlap home" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
            <img src="/logo-mark.svg" alt="" aria-hidden="true" width={32} height={33} style={{ display: "block" }} />
            <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: "0.1em", color: T.text }}>MARKET<span className="ms-slap">SLAP</span></span>
          </a>
        </div>
      </div>
      <main style={{ maxWidth: 760, margin: "0 auto", padding: "28px clamp(16px, 4vw, 24px) 48px" }}>
        <h1 style={{ fontSize: 26, margin: "0 0 4px" }}>{title}</h1>
        <p style={{ margin: "0 0 20px", fontSize: 13, color: T.muted }}>Effective {LEGAL.effective}</p>
        {children}
        <p style={{ marginTop: 32, fontSize: 13, color: T.muted }}>
          <a href="/terms" style={{ color: T.muted }}>Terms</a> · <a href="/privacy" style={{ color: T.muted }}>Privacy</a> · <a href={`mailto:${LEGAL.email}`} style={{ color: T.muted }}>{LEGAL.email}</a>
        </p>
      </main>
    </div>
  );
}
