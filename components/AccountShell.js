// The frame for the sign-in, confirm and account pages: the sports page's
// header and palette, and one centred card.
import Head from "next/head";

export const ACCENT = "#5641D2";
export const T = { bg: "#F7F8FA", surface: "#FFFFFF", border: "#E4E7ED", text: "#0F1923", muted: "#6B7280", yes: "#059669", no: "#DC2626" };

export const input = {
  width: "100%", boxSizing: "border-box", border: `1px solid ${T.border}`, borderRadius: 8, padding: "11px 12px",
  fontSize: 15, fontFamily: "inherit", color: T.text, background: T.surface,
};
export const primary = {
  width: "100%", border: 0, borderRadius: 8, padding: "12px 14px", fontSize: 15, fontWeight: 600,
  fontFamily: "inherit", color: "#fff", background: ACCENT, cursor: "pointer",
};
export const secondary = { ...primary, color: T.text, background: T.surface, border: `1px solid ${T.border}` };

export default function AccountShell({ title, children }) {
  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "'Inter', system-ui, sans-serif", color: T.text }}>
      <Head><title>{`${title} · MarketSlap`}</title><meta name="robots" content="noindex" /></Head>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "0 clamp(12px, 4vw, 24px)" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", minHeight: 56, display: "flex", alignItems: "center", gap: 12 }}>
          <a href="/" aria-label="MarketSlap home" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
            <img src="/logo-mark.svg" alt="" aria-hidden="true" width={32} height={33} style={{ display: "block" }} />
            <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: "0.1em", color: T.text }}>MARKET<span className="ms-slap">SLAP</span></span>
          </a>
          <span style={{ marginLeft: "auto" }}><a href="/sports" style={{ color: T.muted, fontSize: 14, textDecoration: "none" }}>Sports</a></span>
        </div>
      </div>
      <div style={{ maxWidth: 420, margin: "0 auto", padding: "40px clamp(16px, 4vw, 24px)" }}>
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "28px 24px" }}>{children}</div>
      </div>
    </div>
  );
}
