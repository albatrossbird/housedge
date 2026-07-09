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

// ── Categories ───────────────────────────────────────────────
// This is UI-display metadata only (tab labels/icons) — the actual
// fetch configuration (which Kalshi series + Polymarket tags to pull)
// lives in pages/api/markets.js as `kalshiSeriesBySport`/`polyTagsBySport`,
// keep these two in sync if categories change. The user PICKS the
// category by clicking a tab, so we never need to detect it from text —
// this eliminates the cross-category false-match bugs we hit doing pure
// auto-detection (GDP vs soccer team).
const CATEGORIES = {
  sports: { label: "Sports", icon: "⚽", supported: true },
  economics: { label: "Economics", icon: "📊", supported: true },
  crypto: { label: "Crypto", icon: "₿", supported: false }, // TODO: find correct tag_id
  politics: { label: "Politics", icon: "🏛️", supported: false }, // TODO: find correct tag_id
};

// ── Team/entity alias map ───────────────────────────────────────
// Known naming differences between platforms for the SAME entity.
// This is the "curated mapping" approach real arbitrage bots use
// instead of pure fuzzy text matching (per research) — start small,
// add entries as mismatches are discovered.
const ALIASES = {
  "bosnia and herzegovina": ["bosnia-herzegovina", "bosnia", "herzegovina"],
  "czechia": ["czech republic"],
  "ivory coast": ["cote d'ivoire", "côte d'ivoire"],
  "south korea": ["korea republic", "korea"],
  "usa": ["united states", "us"],
  "uk": ["united kingdom", "great britain"],
  // MLB — Kalshi abbreviates same-city teams with a single trailing
  // letter (e.g. "Los Angeles D" for Dodgers, "New York Y" for Yankees)
  // which our keyword filter was dropping (1-char words get filtered),
  // causing city-only matches that wrongly paired different teams from
  // the same city (Dodgers matching Angels, Yankees matching Mets).
  "los angeles d": ["los angeles dodgers"],
  "los angeles a": ["los angeles angels"],
  "new york y": ["new york yankees"],
  "new york m": ["new york mets"],
  "chicago c": ["chicago cubs"],
  "chicago w": ["chicago white sox"],
};

function normalizeEntity(text) {
  const lower = text.toLowerCase().trim();
  for (const [canonical, variants] of Object.entries(ALIASES)) {
    if (lower === canonical || variants.includes(lower)) return canonical;
  }
  return lower;
}

const STOPWORDS = new Set([
  "the","and","for","will","that","this","with","from","are","has","was",
  "its","not","have","had","but","they","been","their","more","also","into",
  "win","wins","winner","does","did","what","when","who","which","how","than","then",
  "each","both","after","before","between","during","about","over","under","professional",
  "vs","game","on",
]);

function getKeywords(title) {
  return title.toLowerCase().split(/\W+/).filter(w =>
    w.length > 2 &&
    !STOPWORDS.has(w) &&
    !/^\d+$/.test(w) // strip pure numbers (dates)
  );
}

// Sub-bet structure phrases — these distinguish "who wins the match" from
// "halftime result" / "first goalscorer" etc within the SAME game, so
// sibling markets don't get matched to the wrong one.
const STRUCTURE_PHRASES = [
  "win the world cup", "win the championship", "win the super bowl",
  "win the finals", "make the playoffs", "make the final", "reach the final",
  "advance to", "qualify for", "stanley cup", "nba finals", "world series",
  "halftime", "half-time", "half time", "first half", "second half",
  "overtime", "extra time", "penalties", "penalty shootout",
  "corners", "yellow card", "red card", "both teams to score", "btts",
  "clean sheet", "draw at", "to win by", "correct score", "first goal",
  "to score first", "score first", "anytime goal",
  // Kalshi's actual season-futures phrasing (discovered via debug log —
  // "Will New York win the 2026 Pro Baseball Championship?" does NOT
  // contain the literal words "win the championship", it says
  // "Pro X Championship" instead). Without these, season-long futures
  // matched against individual single-game markets with no warning.
  "pro baseball championship", "pro basketball championship",
  "pro football championship", "pro hockey championship",
  "stanley cup finals", "championship?",
];

function getStructureSignature(text) {
  const lower = text.toLowerCase();
  return STRUCTURE_PHRASES.filter(p => lower.includes(p)).sort().join("|");
}

function parseKalshiYes(km) {
  if (km.yes_ask_dollars != null) {
    const v = parseFloat(km.yes_ask_dollars);
    if (!isNaN(v) && v > 0) return v;
  }
  if (km.yes_bid_dollars != null) {
    const v = parseFloat(km.yes_bid_dollars);
    if (!isNaN(v) && v > 0) return v;
  }
  if (km.last_price_dollars != null) {
    const v = parseFloat(km.last_price_dollars);
    if (!isNaN(v) && v > 0) return v;
  }
  return null;
}

// ── Matching — now operates WITHIN a single pre-selected category ──
// No category detection/gating needed since the user already picked it
// by clicking a tab. This removes the entire class of cross-category
// false-positive bugs (e.g. "Real GDP" vs "CD Real Tomayapo").
// Extract just the calendar date (YYYY-MM-DD) from any of the various
// date fields each platform uses. Needed because the SAME two teams can
// play multiple games across different dates (a series), and both
// platforms create a separate market per date — without this, "Washington
// vs Boston Winner?" (4 separate Kalshi markets, one per game date) had
// no way to know which specific date's Polymarket event it corresponded
// to, so it would grab whichever one scored highest on team-name overlap,
// producing wrong/inconsistent prices across each match attempt.
//
// NOTE: Polymarket's gameStartTime/endDate metadata fields proved
// unreliable (often a placeholder like "2026-02-01" repeated across
// hundreds of unrelated markets, or a far-future "2500-12-31" sentinel).
// The slug is far more trustworthy — it embeds the real game date
// directly, e.g. "mlb-stl-cin-2026-05-24-spread-away-3pt5".
function extractDateOnly(dateStr) {
  if (!dateStr) return null;
  const match = String(dateStr).match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function matchMarketsInCategory(kalshiMarkets, polyMarkets) {
  const matched = [];
  const usedPolyIds = new Set();

  const polyWithKeywords = polyMarkets.map(pm => {
    const baseText = pm.question || pm.title || pm.eventTitle || "";
    const sideText = pm.groupItemTitle || "";
    const text = `${baseText} ${sideText}`.trim();
    return {
      pm,
      keywords: getKeywords(text),
      structureSig: getStructureSignature(`${baseText} ${pm.eventTitle || ""}`),
      sideLabel: sideText,
      sideNormalized: sideText ? normalizeEntity(sideText) : "",
      sportTag: pm.sportTag || null,
      gameDate: extractDateOnly(pm.slug || pm.eventTitle || ""),
    };
  });

  for (const km of kalshiMarkets) {
    const kTitle = (km.title || km.subtitle || "").trim();
    if (!kTitle) continue;

    const sideLabel = km.yes_sub_title || "";
    const searchText = `${kTitle} ${sideLabel}`;
    const kKeywords = getKeywords(searchText);
    if (kKeywords.length < 1) continue;

    // Reliable structural signal: Kalshi season-futures tickers follow the
    // pattern SERIES-YY (e.g. "KXMLB-26", "KXNHL-27") — a bare 2-digit year
    // suffix, no game-specific info. Individual-game tickers always have
    // more detail after the year (e.g. "KXWCGAME-26JUN27CODUZB"). This is
    // far more reliable than matching exact phrasing, since Kalshi's
    // wording varies ("win the championship" vs "Pro Baseball
    // Championship") in ways a fixed phrase list will always lag behind.
    const isKalshiSeasonFutures = /-\d{2}$/.test(km.event_ticker || "");
    const kStructureSig = isKalshiSeasonFutures ? "season-futures" : getStructureSignature(searchText);
    const kSideNormalized = sideLabel ? normalizeEntity(sideLabel) : "";
    const kSportTag = km.sportTag || null;
    const kGameDate = extractDateOnly(km.close_time);

    const kYes = parseKalshiYes(km);
    if (kYes == null || kYes <= 0.01 || kYes >= 0.99) continue;

    let bestMatch = null;
    let bestScore = 0;

    for (const { pm, keywords: pKeywords, structureSig, sideLabel: pSideLabel, sideNormalized, sportTag, gameDate } of polyWithKeywords) {
      if (usedPolyIds.has(pm.id)) continue;
      if (!pKeywords.length) continue;

      // HARD GATE: sport sub-category must match exactly. "Sports" tab
      // covers soccer/NBA/NHL/MLB together, but they must never cross-
      // match each other — this is what stopped "Los Angeles Dodgers"
      // (MLB) from matching "Los Angeles Angels" (also MLB but wrong
      // team) and worse, baseball matching basketball on shared city
      // names like "New York".
      if (kSportTag && sportTag && kSportTag !== sportTag) continue;

      // HARD GATE: when the SAME two teams play multiple games (a
      // series), each date is a separate market on both platforms with
      // genuinely different odds. Without checking the date, Kalshi's 4
      // identically-titled "Washington vs Boston Winner?" markets (one
      // per game date) could pair with the wrong Polymarket event,
      // producing wildly inconsistent/wrong prices on each match attempt.
      if (kGameDate && gameDate && kGameDate !== gameDate) continue;

      // Structure must match: "full match result" vs "halftime result" etc
      // should never cross-match even within the same category/game.
      const structureMismatch =
        (kStructureSig !== "" || structureSig !== "") && kStructureSig !== structureSig;
      if (structureMismatch) continue;

      // When both sides specify an entity (team name), check alias-aware
      // equality first — this is the precise check. Fall back to soft
      // keyword overlap only if no side label exists on either side, and
      // even then require a DISTINCTIVE word match, not just a shared
      // city name. "Los Angeles D[odgers]" and "Los Angeles Angels" both
      // contain "los"/"angeles" — matching on city alone wrongly pairs
      // different teams from the same city. Require overlap on a word
      // that ISN'T a common city-name fragment.
      const CITY_FRAGMENTS = new Set([
        "los", "angeles", "new", "york", "san", "francisco", "diego",
        "louis", "tampa", "bay", "kansas", "city",
      ]);

      if (kSideNormalized && sideNormalized) {
        if (kSideNormalized !== sideNormalized) continue;
      } else if (pSideLabel && pSideLabel.trim().length > 0) {
        const sideKeywords = getKeywords(pSideLabel);
        if (sideKeywords.length > 0) {
          const distinctiveOverlap = sideKeywords.some(w =>
            kKeywords.includes(w) && !CITY_FRAGMENTS.has(w)
          );
          if (!distinctiveOverlap) continue;
        }
      } else if (kSideNormalized) {
        // BUG FIX: when Kalshi specifies a side (e.g. "Los Angeles A") but
        // this Polymarket candidate has NO side label at all (empty
        // groupItemTitle — happens for non-moneyline market types or
        // malformed entries), there's nothing to verify the team against.
        // Previously this fell through BOTH branches above with no check
        // applied, letting completely unrelated games slip through (e.g.
        // "Los Angeles Angels" matched to "Milwaukee vs Arizona"). Require
        // the Kalshi side name to appear in the full question text instead.
        const distinctiveOverlap = kKeywords.some(w =>
          pKeywords.includes(w) && !CITY_FRAGMENTS.has(w)
        );
        if (!distinctiveOverlap) continue;
      }

      const kHits = kKeywords.filter(w => pKeywords.includes(w)).length;
      const pHits = pKeywords.filter(w => kKeywords.includes(w)).length;
      const kCoverage = kHits / kKeywords.length;
      const pCoverage = pHits / pKeywords.length;
      const score = (kCoverage + pCoverage) / 2;

      // Raised from 0.3 — that threshold let "Miami vs Colorado" match
      // "Miami Marlins vs. Athletics" since "miami" alone cleared 30%
      // coverage despite the OPPONENT team being completely wrong. Team
      // matchup titles are short (3-5 meaningful words total for both
      // teams), so a genuinely correct match should clear ~0.6+ coverage
      // on both sides; a wrong-opponent match caps out much lower since
      // only one team name can possibly overlap.
      // Tuned down from 0.6/0.5 — that was too strict and caused "No
      // overlapping markets" for genuinely correct pairs (the opponent-
      // verification fix above already blocks wrong-team matches more
      // precisely, so this threshold doesn't need to carry that burden
      // alone anymore).
      if (score > bestScore && kCoverage >= 0.45 && pCoverage >= 0.35) {
        bestScore = score;
        bestMatch = pm;
      }
    }

    if (!bestMatch) continue;

    // CRITICAL FIX: outcomePrices[0] is NOT always the side we want — for
    // a moneyline market like "Cincinnati Reds vs. Pittsburgh Pirates"
    // with outcomes ["Cincinnati Reds", "Pittsburgh Pirates"], the price
    // at index 0 is Cincinnati's, not Pittsburgh's. We must find the
    // index that actually corresponds to our target side (sideLabel /
    // Kalshi's yes_sub_title) within Poly's outcomes array, and use THAT
    // index into outcomePrices — never assume position 0.
    let pYes = null;
    try {
      const outcomes = JSON.parse(bestMatch.outcomes || "[]");
      const prices = JSON.parse(bestMatch.outcomePrices || "[]");

      // Determine which outcome index represents our target side.
      // Priority 1: groupItemTitle tells us this market's specific side
      // directly (most reliable, used by team-vs-team event markets).
      // Priority 2: match the Kalshi side label against the outcomes text.
      let targetIndex = -1;

      if (sideLabel) {
        const sideKeywords = getKeywords(sideLabel);
        targetIndex = outcomes.findIndex(o => {
          const oKeywords = getKeywords(o);
          return sideKeywords.some(w => oKeywords.includes(w));
        });
      }

      if (targetIndex === -1 && bestMatch.groupItemTitle) {
        // groupItemTitle on the market itself often already IS the side
        // (e.g. for "Will Pittsburgh win?" type markets); if it textually
        // matches outcomes[0] vs outcomes[1], use that.
        const gKeywords = getKeywords(bestMatch.groupItemTitle);
        targetIndex = outcomes.findIndex(o => {
          const oKeywords = getKeywords(o);
          return gKeywords.some(w => oKeywords.includes(w));
        });
      }

      if (targetIndex === -1) targetIndex = 0; // last resort fallback

      pYes = prices[targetIndex] != null ? parseFloat(prices[targetIndex]) : null;
    } catch {
      pYes = bestMatch.lastTradePrice != null ? parseFloat(bestMatch.lastTradePrice) : null;
    }
    if (pYes == null || pYes <= 0.01 || pYes >= 0.99) continue;

    const kVol = parseFloat(km.volume_24h_fp || km.volume_fp || 0);
    const pVol = parseFloat(bestMatch.volumeNum || bestMatch.volume || 0);

    usedPolyIds.add(bestMatch.id);

    matched.push({
      id: km.ticker || km.id,
      title: sideLabel ? `${kTitle} — ${sideLabel}` : kTitle,
      polyTitle: bestMatch.question || bestMatch.title,
      kalshi: {
        yes: kYes,
        no: Math.round((1 - kYes) * 100) / 100,
        volume: kVol,
        url: `https://kalshi.com/markets/${(km.event_ticker || "").toLowerCase()}`,
      },
      poly: {
        yes: pYes,
        no: Math.round((1 - pYes) * 100) / 100,
        volume: pVol,
        url: bestMatch.events && bestMatch.events[0]?.slug
          ? `https://polymarket.com/event/${bestMatch.events[0].slug}`
          : `https://polymarket.com/event/${bestMatch.slug}`,
      },
      trending: (kVol + pVol) > 5_000,
      matchScore: bestScore,
    });
  }

  return matched.sort((a, b) => b.matchScore - a.matchScore);
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

  const loadMarkets = useCallback(async (categoryKey) => {
    const cat = CATEGORIES[categoryKey];
    setLoading(true);
    setError(null);
    setUnsupported(false);

    if (!cat.supported) {
      // Crypto/Politics tag IDs not found yet — show friendly placeholder
      // rather than a broken fetch. Flip `supported: true` in CATEGORIES
      // above (and fill in the real tag in markets.js) once found.
      setUnsupported(true);
      setMarkets([]);
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`/api/markets?category=${categoryKey}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const { kalshi, poly, unsupported: proxyUnsupported } = await res.json();
      if (proxyUnsupported) {
        setUnsupported(true);
        setMarkets([]);
        return;
      }
      const matched = matchMarketsInCategory(kalshi, poly);
      setMarkets(matched);
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
    return (b.trending ? 1 : 0) - (a.trending ? 1 : 0);
  });

  const arbCount = markets.filter(arbAlert).length;

  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "'Inter', system-ui, sans-serif" }}>
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
        {/* Category tabs — this IS the category gate now, chosen by the user */}
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
              }}
            >
              <span>{cat.icon}</span> {cat.label}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            style={{ padding: "10px 14px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13, color: T.text, background: T.surface, cursor: "pointer", outline: "none" }}
          >
            <option value="trending">Sort: Trending</option>
            <option value="spread">Sort: Biggest spread</option>
            <option value="volume">Sort: Most volume</option>
          </select>
          <button onClick={() => loadMarkets(activeCategory)} style={{ padding: "10px 16px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13, color: T.muted, background: T.surface, cursor: "pointer" }}>
            ↻ Refresh
          </button>
        </div>

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

        {loading && <Skeleton />}

        {unsupported && (
          <div style={{ padding: "24px", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, color: "#92400E", fontSize: 14 }}>
            <strong>{CATEGORIES[activeCategory].label} coming soon</strong> — we haven't mapped the Polymarket tag ID for this category yet. Sports and Economics are live now.
          </div>
        )}

        {error && (
          <div style={{ padding: "24px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, color: T.no, fontSize: 14 }}>
            <strong>Could not load live data:</strong> {error}
            <br /><br />
            <button onClick={() => loadMarkets(activeCategory)} style={{ padding: "8px 16px", background: T.no, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
              Try again
            </button>
          </div>
        )}

        {!loading && !error && !unsupported && sorted.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 0", color: T.muted, fontSize: 14 }}>
            No overlapping {CATEGORIES[activeCategory].label.toLowerCase()} markets found right now.
          </div>
        )}

        {!loading && !error && !unsupported && sorted.length > 0 && (
          <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))" }}>
            {sorted.map(m => <MarketCard key={m.id} market={m} />)}
          </div>
        )}

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