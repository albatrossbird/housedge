// The frame for the sign-up, confirm, account and pricing pages, in the
// sports app's look (the MarketSlap Sports artifact, 2026-11-11): dark by
// default, a light theme when the device asks for one, the system font,
// pill buttons and chips, 18-20px cards, an 800-weight display face.
//
// Colours are CSS variables, not hex in JavaScript, so one set of styles
// serves both themes. T and ACCENT hand those variables to inline styles;
// a hex-plus-alpha trick like `${T.yes}12` does not work on a variable, so
// the soft fills have their own tokens (--good-soft and the rest).
import Head from "next/head";

export const THEME_CSS = `
:root {
  --bg: #0a0c11; --surface: #13161d; --raised: #1c2029; --line: #262b37; --fg: #f3f5f9; --muted: #8b93a7;
  --accent: #5b8cff; --accent-soft: rgba(91, 140, 255, .16); --on-accent: #ffffff;
  --good: #2fd17c; --good-soft: rgba(47, 209, 124, .15); --bad: #ff6262; --bad-soft: rgba(255, 98, 98, .14);
  --warn: #f2b84b; --warn-soft: rgba(242, 184, 75, .15); --shadow: 0 1px 2px rgba(0, 0, 0, .4);
  --ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --display: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {
  --bg: #f2f3f6; --surface: #ffffff; --raised: #eef0f4; --line: #e0e3ea; --fg: #0e1220; --muted: #5d6577;
  --accent: #2f62e6; --accent-soft: rgba(47, 98, 230, .1); --on-accent: #ffffff;
  --good: #0f9d55; --good-soft: rgba(15, 157, 85, .1); --bad: #d93b3b; --bad-soft: rgba(217, 59, 59, .09);
  --warn: #a86a00; --warn-soft: rgba(168, 106, 0, .1); --shadow: 0 1px 2px rgba(14, 18, 32, .08);
  color-scheme: light } }
body { background: var(--bg); color: var(--fg); margin: 0; -webkit-font-smoothing: antialiased; }
.ms-page a { color: var(--accent); }
.ms-page :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ms-page input:focus { border-color: var(--accent) !important; outline: none; }
.ms-page .num { font-variant-numeric: tabular-nums; }
`;

export const ACCENT = "var(--accent)";
export const T = {
  bg: "var(--bg)", surface: "var(--surface)", raised: "var(--raised)", border: "var(--line)",
  text: "var(--fg)", muted: "var(--muted)", yes: "var(--good)", no: "var(--bad)", warn: "var(--warn)",
  yesSoft: "var(--good-soft)", noSoft: "var(--bad-soft)", warnSoft: "var(--warn-soft)", accentSoft: "var(--accent-soft)",
  onAccent: "var(--on-accent)", shadow: "var(--shadow)", ui: "var(--ui)", display: "var(--display)",
};

export const input = {
  width: "100%", boxSizing: "border-box", border: "1px solid transparent", borderRadius: 14, padding: "0 14px", minHeight: 46,
  fontSize: 16, fontFamily: "inherit", color: T.text, background: T.raised,
};
export const primary = {
  width: "100%", border: 0, borderRadius: 999, minHeight: 46, padding: "0 18px", fontSize: 15, fontWeight: 700,
  fontFamily: "inherit", color: T.onAccent, background: ACCENT, cursor: "pointer",
};
export const secondary = { ...primary, color: T.text, background: T.raised, border: `1px solid ${T.border}`, fontWeight: 650 };
export const card = { background: T.surface, border: `1px solid ${T.border}`, borderRadius: 20, boxShadow: T.shadow };

// The site header: logo, wordmark, and a way back to the board.
export function ShellHeader({ width = 1080 }) {
  return (
    <header style={{ position: "sticky", top: 0, zIndex: 20, background: T.bg, padding: "0 max(16px, env(safe-area-inset-left, 0px))" }}>
      <div style={{ maxWidth: width, margin: "0 auto", minHeight: 58, display: "flex", alignItems: "center", gap: 12 }}>
        <a href="/" aria-label="MarketSlap home" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
          <img src="/logo-mark.svg" alt="" aria-hidden="true" width={30} height={31} style={{ display: "block" }} />
          <span style={{ font: `800 18px/1 ${T.display}`, letterSpacing: "0.08em", color: T.text }}>MARKET<span className="ms-slap">SLAP</span></span>
        </a>
        <nav style={{ marginLeft: "auto", display: "flex", gap: 16, fontSize: 14, fontWeight: 650 }}>
          <a href="/sports" style={{ color: T.muted, textDecoration: "none" }}>Sports</a>
          <a href="/pricing" style={{ color: T.muted, textDecoration: "none" }}>Pricing</a>
        </nav>
      </div>
    </header>
  );
}

export default function AccountShell({ title, children, wide = false, index = false }) {
  return (
    <div className="ms-page" style={{ minHeight: "100vh", background: T.bg, fontFamily: T.ui, color: T.text, fontSize: 15, lineHeight: 1.4 }}>
      <Head>
        <title>{`${title} · MarketSlap`}</title>
        {!index && <meta name="robots" content="noindex" />}
        <meta name="theme-color" content="#0a0c11" media="(prefers-color-scheme: dark)" />
        <meta name="theme-color" content="#f2f3f6" media="(prefers-color-scheme: light)" />
      </Head>
      <style dangerouslySetInnerHTML={{ __html: THEME_CSS }} />
      <ShellHeader width={wide ? 1080 : 900} />
      {wide
        ? <main style={{ maxWidth: 1080, margin: "0 auto", padding: "20px max(16px, env(safe-area-inset-right, 0px)) 56px max(16px, env(safe-area-inset-left, 0px))" }}>{children}</main>
        : (
          <main style={{ maxWidth: 440, margin: "0 auto", padding: "28px 16px 56px" }}>
            <div style={{ ...card, padding: "26px 22px" }}>{children}</div>
          </main>
        )}
    </div>
  );
}
