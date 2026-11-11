// The frame for /terms and /privacy: the site header and a readable column.
import Head from "next/head";
import { T, THEME_CSS, ShellHeader } from "./AccountShell.js";
import { LEGAL } from "../lib/legal.js";

export const h2 = { font: "750 18px/1.3 var(--display)", margin: "28px 0 8px" };
export const p = { margin: "0 0 10px", fontSize: 15, lineHeight: 1.65, color: T.text };
export const li = { margin: "0 0 6px", fontSize: 15, lineHeight: 1.6 };

export default function LegalPage({ title, children }) {
  return (
    <div className="ms-page" style={{ minHeight: "100vh", background: T.bg, fontFamily: T.ui, color: T.text }}>
      <Head><title>{`${title} · MarketSlap`}</title></Head>
      <style dangerouslySetInnerHTML={{ __html: THEME_CSS }} />
      <ShellHeader width={760} />
      <main style={{ maxWidth: 760, margin: "0 auto", padding: "28px clamp(16px, 4vw, 24px) 48px" }}>
        <h1 style={{ font: "800 30px/1.15 var(--display)", letterSpacing: "-0.02em", margin: "0 0 6px" }}>{title}</h1>
        <p style={{ margin: "0 0 20px", fontSize: 13, color: T.muted }}>Effective {LEGAL.effective}</p>
        {children}
        <p style={{ marginTop: 32, fontSize: 13, color: T.muted }}>
          <a href="/terms" style={{ color: T.muted }}>Terms</a> · <a href="/privacy" style={{ color: T.muted }}>Privacy</a> · <a href={`mailto:${LEGAL.email}`} style={{ color: T.muted }}>{LEGAL.email}</a>
        </p>
      </main>
    </div>
  );
}
