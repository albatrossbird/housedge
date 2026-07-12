import { useState, useEffect, useCallback } from "react";

const T = {
  bg: "#F7F8FA",
  surface: "#FFFFFF",
  border: "#E4E7ED",
  text: "#0F1923",
  muted: "#6B7280",
  kalshi: "#2563EB",
  poly: "#7C3AED",
  yes: "#059669",
  no: "#DC2626",
  arb: "#D97706",
};

const pct = (v) => `${Math.round(v * 100)}%`;
const fmt = (v) =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` :
  v >= 1_000 ? `$${(v / 1_000).toFixed(0)}K` : `$${v}`;

function spread(m) { return Math.abs(m.kalshi.yes - m.poly.yes); }
function bestYes(m) { return m.kalshi.yes >= m.poly.yes ? "kalshi" : "poly"; }
function arbAlert(m) {
  const cost = Math.min(m.kalshi.yes, m.poly.yes) + Math.min(m.kalshi.no, m.poly.no);
  return cost < 0.97;
}

// ── Categories (UI display only) ──────────────────────────────
// Fetch config lives in pages/api/markets.js and pages/api/embed.js
const CATEGORIES = {
  sports:    { label: "Sports",    icon: "⚽", supported: true  },
  economics: { label: "Economics", icon: "📊", supported: true  },
  crypto:    { label: "Crypto",    icon: "₿",  supported: false },
  politics:  { label: "Politics",  icon: "🏛️", supported: false },
};

// ── Fetch from new Supabase-backed API ─────────────────────────
async function fetchMarkets(category) {
  const res = await fetch(`/api/markets?category=${category}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return await res.json();
}

// ── Spread bar ─────────────────────────────────────────────────
function SpreadBar({ market }) {
  const kPct = Math.round(market.kalshi.yes * 100);
  const pPct = Math.round(market.poly.yes * 100);
  const diff = Math.abs(kPct - pPct);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 52, fontSize: 11, color: T.kalshi, fontWeight: 600, letterSpacing: "0.03em" }}>KALSHI</span>
        <div style={{ flex: 1, height: 6, background: T.border, borderRadius: 99, overflow: "hidden" }}>
          <div style={{ width: `${kPct}%`, height: "100%", background: T.kalshi, borderRadius: 99, transition: "width 0.6s ease" }} />
        </div>
        <span style={{ width: 32, fontSize: 13, fontWeight: 700, color: T.text, textAlign: "right" }}>{kPct}%</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 52, fontSize: 11, color: T.poly, fontWeight: 600, letterSpacing: "0.03em" }}>POLY</span>
        <div style={{ flex: 1, height: 6, background: T.border, borderRadius: 99, overflow: "hidden" }}>
          <div style={{ width: `${pPct}%`, height: "100%", background: T.poly, borderRadius: 99, transition: "width 0.6s ease" }} />
        </div>
        <span style={{ width: 32, fontSize: 13, fontWeight: 700, color: T.text, textAlign: "right" }}>{pPct}%</span>
      </div>
      {diff > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <span style={{ fontSize: 10, color: diff >= 5 ? T.arb : T.muted, fontWeight: diff >= 5 ? 700 : 400, letterSpacing: "0.04em" }}>
            {diff >= 5 ? `⚡ ${diff}pt spread` : `${diff}pt spread`}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Market card ────────────────────────────────────────────────
function MarketCard({ market }) {
  const best = bestYes(market);
  const isArb = arbAlert(market);

  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${isArb ? T.arb : T.border}`,
      borderRadius: 10, padding: "18px 20px",
      display: "flex", flexDirection: "column", gap: 14,
      boxShadow: isArb ? `0 0 0 1px ${T.arb}22` : "0 1px 3px rgba(0,0,0,0.04)",
    }}>
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
          {market.trending && <span style={{ fontSize: 10, fontWeight: 600, color: T.yes, letterSpacing: "0.04em" }}>↑ TRENDING</span>}
          {isArb && <span style={{ fontSize: 10, fontWeight: 700, color: T.arb, letterSpacing: "0.04em" }}>⚡ ARB</span>}
          {market.similarity && (
            <span style={{ fontSize: 10, color: T.muted, letterSpacing: "0.04em" }}>
              {Math.round(market.similarity * 100)}% match
            </span>
          )}
        </div>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: T.text, lineHeight: 1.4 }}>{market.title}</p>
        {market.polyTitle && (
          <p style={{ margin: "4px 0 0", fontSize: 11, color: T.muted, lineHeight: 1.3 }}>
            Poly: {market.polyTitle}
          </p>
        )}
      </div>

      <SpreadBar market={market} />

      <div style={{ display: "flex", justifyContent: "space-between", borderTop: `1px solid ${T.border}`, paddingTop: 12, fontSize: 11, color: T.muted, flexWrap: "wrap", gap: 8 }}>
        <span>
          Best YES:{" "}
          <span style={{ color: best === "kalshi" ? T.kalshi : T.poly, fontWeight: 700 }}>
            {best === "kalshi" ? "Kalshi" : "Polymarket"} {pct(Math.max(market.kalshi.yes, market.poly.yes))}
          </span>
        </span>
        <span style={{ display: "flex", gap: 10 }}>
          <a href={market.kalshi.url} target="_blank" rel="noopener noreferrer"
            style={{ color: T.kalshi, fontWeight: 600, textDecoration: "none" }}>Kalshi ↗</a>
          <a href={market.poly.url} target="_blank" rel="noopener noreferrer"
            style={{ color: T.poly, fontWeight: 600, textDecoration: "none" }}>Poly ↗</a>
        </span>
      </div>
      <div style={{ fontSize: 11, color: T.muted }}>
        Vol {fmt(market.kalshi.volume + market.poly.volume)}
      </div>
    </div>
  );
}

// ── Loading skeleton ───────────────────────────────────────────
function Skeleton() {
  return (
    <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))" }}>
      {[1,2,3,4,5,6].map(i => (
        <div key={i} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "18px 20px", height: 180 }}>
          <div style={{ height: 12, width: "60%", background: T.border, borderRadius: 6, marginBottom: 12 }} />
          <div style={{ height: 10, width: "90%", background: T.border, borderRadius: 6, marginBottom: 20 }} />
          <div style={{ height: 6, background: T.border, borderRadius: 99, marginBottom: 10 }} />
          <div style={{ height: 6, background: T.border, borderRadius: 99 }} />
        </div>
      ))}
    </div>
  );
}

// ── Main app ───────────────────────────────────────────────────
export default function HouseEdge() {
  const [activeCategory, setActiveCategory] = useState("sports");
  const [sort, setSort] = useState("trending");
  const [markets, setMarkets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [unsupported, setUnsupported] = useState(false);
  const [needsEmbed, setNeedsEmbed] = useState(false);

  const loadMarkets = useCallback(async (categoryKey) => {
    const cat = CATEGORIES[categoryKey];
    setLoading(true);
    setError(null);
    setUnsupported(false);
    setNeedsEmbed(false);

    if (!cat.supported) {
      setUnsupported(true);
      setMarkets([]);
      setLoading(false);
      return;
    }

    try {
      const { pairs, needsEmbed: ne } = await fetchMarkets(categoryKey);
      setMarkets(pairs || []);
      setNeedsEmbed(!!ne);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMarkets(activeCategory);
    const interval = setInterval(() => loadMarkets(activeCategory), 60_000);
    return () => clearInterval(interval);
  }, [activeCategory, loadMarkets]);

  const sorted = [...markets].sort((a, b) => {
    if (sort === "spread") return spread(b) - spread(a);
    if (sort === "volume") return (b.kalshi.volume + b.poly.volume) - (a.kalshi.volume + a.poly.volume);
    if (sort === "similarity") return (b.similarity || 0) - (a.similarity || 0);
    return (b.trending ? 1 : 0) - (a.trending ? 1 : 0);
  });

  const arbCount = markets.filter(arbAlert).length;

  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Nav */}
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "0 24px", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 900, margin: "0 auto", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: T.text, letterSpacing: "-0.03em" }}>
              hous<span style={{ color: T.kalshi }}>edge</span>
            </span>
            <span style={{ fontSize: 11, color: T.muted, fontWeight: 500 }}>Kalshi vs Polymarket</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {lastUpdated && (
              <span style={{ fontSize: 10, color: T.muted }}>
                Updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
            {arbCount > 0 && (
              <span style={{ background: `${T.arb}18`, color: T.arb, fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 99 }}>
                ⚡ {arbCount} arb {arbCount === 1 ? "signal" : "signals"}
              </span>
            )}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "28px 24px" }}>
        {/* Category tabs */}
        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          {Object.entries(CATEGORIES).map(([key, cat]) => (
            <button
              key={key}
              onClick={() => setActiveCategory(key)}
              style={{
                padding: "8px 16px", borderRadius: 99, fontSize: 13, fontWeight: 600,
                cursor: "pointer", border: `1px solid ${activeCategory === key ? T.kalshi : T.border}`,
                background: activeCategory === key ? `${T.kalshi}12` : T.surface,
                color: activeCategory === key ? T.kalshi : T.muted, transition: "all 0.15s",
                display: "flex", alignItems: "center", gap: 6,
                opacity: cat.supported ? 1 : 0.5,
              }}
            >
              <span>{cat.icon}</span> {cat.label}
            </button>
          ))}
        </div>

        {/* Sort controls */}
        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            style={{ padding: "10px 14px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13, color: T.text, background: T.surface, cursor: "pointer", outline: "none" }}
          >
            <option value="trending">Sort: Trending</option>
            <option value="spread">Sort: Biggest spread</option>
            <option value="volume">Sort: Most volume</option>
            <option value="similarity">Sort: Best match</option>
          </select>
          <button
            onClick={() => loadMarkets(activeCategory)}
            style={{ padding: "10px 16px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13, color: T.muted, background: T.surface, cursor: "pointer" }}
          >
            ↻ Refresh
          </button>
        </div>

        {/* Stats bar */}
        {!loading && markets.length > 0 && (
          <div style={{ display: "flex", gap: 24, marginBottom: 24, padding: "14px 18px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, flexWrap: "wrap" }}>
            {[
              { label: "Markets matched", value: markets.length },
              { label: "Arb signals", value: arbCount, color: T.arb },
              { label: "Avg spread", value: markets.length ? `${Math.round(markets.reduce((s, m) => s + spread(m), 0) / markets.length * 100)}pt` : "—" },
              { label: "Total volume", value: fmt(markets.reduce((s, m) => s + m.kalshi.volume + m.poly.volume, 0)) },
            ].map(({ label, value, color }) => (
              <div key={label}>
                <div style={{ fontSize: 11, color: T.muted, marginBottom: 2, letterSpacing: "0.04em" }}>{label}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: color || T.text, letterSpacing: "-0.02em" }}>{value}</div>
              </div>
            ))}
          </div>
        )}

        {/* States */}
        {loading && <Skeleton />}

        {unsupported && (
          <div style={{ padding: "24px", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, color: "#92400E", fontSize: 14 }}>
            <strong>{CATEGORIES[activeCategory].label} coming soon</strong> — we're working on adding this category. Sports and Economics are live now.
          </div>
        )}

        {needsEmbed && !loading && (
          <div style={{ padding: "24px", background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10, color: "#1E40AF", fontSize: 14 }}>
            <strong>No matched markets yet.</strong> The embedding engine needs to run first to match markets across platforms.
            <br /><br />
            <a href="/api/embed" target="_blank" rel="noopener noreferrer"
              style={{ padding: "8px 16px", background: T.kalshi, color: "#fff", borderRadius: 6, textDecoration: "none", fontSize: 13, fontWeight: 600 }}>
              Initialize matching engine ↗
            </a>
          </div>
        )}

        {error && (
          <div style={{ padding: "24px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, color: T.no, fontSize: 14 }}>
            <strong>Could not load data:</strong> {error}
            <br /><br />
            <button onClick={() => loadMarkets(activeCategory)} style={{ padding: "8px 16px", background: T.no, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
              Try again
            </button>
          </div>
        )}

        {!loading && !error && !unsupported && !needsEmbed && sorted.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 0", color: T.muted, fontSize: 14 }}>
            No overlapping {CATEGORIES[activeCategory].label.toLowerCase()} markets found right now.
          </div>
        )}

        {!loading && !error && !unsupported && sorted.length > 0 && (
          <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))" }}>
            {sorted.map(m => <MarketCard key={m.id} market={m} />)}
          </div>
        )}

        {/* Legend */}
        <div style={{ marginTop: 32, padding: "14px 18px", border: `1px solid ${T.border}`, borderRadius: 10, display: "flex", gap: 20, flexWrap: "wrap", fontSize: 11, color: T.muted }}>
          <span><span style={{ color: T.kalshi, fontWeight: 700 }}>■</span> Kalshi</span>
          <span><span style={{ color: T.poly, fontWeight: 700 }}>■</span> Polymarket</span>
          <span><span style={{ color: T.arb, fontWeight: 700 }}>⚡</span> Arb = YES + NO cost &lt; $0.97 across platforms</span>
          <span>Auto-refreshes every 60s</span>
        </div>
      </div>
    </div>
  );
}