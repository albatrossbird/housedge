import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";

// Brand palette, sampled from the MarketSlap logo artwork rather than
// eyeballed: the wordmark's two inks and the app-icon tile.
const BRAND = {
  ink:   "#0A1226",  // "MARKET"
  slap:  "#5641D2",  // "SLAP" — the gradient's midpoint; see .ms-slap
  teal:  "#0E7490",  // where the mark's fade lands, = the Kalshi venue colour
  // The dark app-icon ground lives in favicon.svg, which is the only
  // place it is used. It is not a token here because nothing on the page
  // draws on it — the header shows the bare mark.
};

// Colour has three jobs on this page and they must never overlap.
//
//   SIGNAL  what a reader must notice — yes/no, arb, staleness.
//   VENUE   which exchange a row belongs to.
//   ACCENT  interactive chrome — links, active tabs, focus.
//
// They used to be one pool. Colour was spent 22 times on venue identity
// against 11 on state, and 13 of those 22 carried NO venue meaning at
// all: the active category tab was Kalshi-blue, the search box border
// and the "matched" badge were Polymarket-purple. The palette had no
// accent, so the venue colours were borrowed for chrome — which meant a
// colour on this page could not be read.
//
// VENUE is now VALUE, not hue. Every venue name is already spelled out
// beside its price, so the hue was redundant, and hue does not scale:
// three venues today and more coming, each needing a hue that collides
// with neither the others nor signal nor brand. That palette cannot be
// built. Freeing those hues is also what lets the brand gradient exist
// without implying an exchange.
// Neutral space is narrow, and these two steps are the widest pair that
// clears everything at once. The first attempt used slate 500 for
// Polymarket and it landed dE 6 from T.muted — a venue label that read
// as de-emphasised text, which is a collision rather than a step.
// The probability bars. One fill for every venue — see the Row comment.
// The track is lighter than T.border so the bar itself carries the eye;
// at 4.8:1 against the track the fill is a shape, not a tint.
const BAR_FILL  = "#334155";
const BAR_TRACK = "#EDEFF3";

const VENUE = {
  kalshi: "#1E293B",   // 14.6:1 — the anchor side of every pair
  poly:   "#475569",   //  7.6:1 — both .com and .us; the label says which
};                     // dE 19 apart, and dE 13 clear of T.muted

// One accent, not two. A second would re-open the ambiguity this split
// closes.
const ACCENT = "#5641D2";

const T = {
  bg: "#F7F8FA",
  surface: "#FFFFFF",
  border: "#E4E7ED",
  text: "#0F1923",
  muted: "#6B7280",
  yes: "#059669",
  no: "#DC2626",
  arb: "#D97706",
};

const pct = (v) => `${Math.round(v * 100)}%`;
// How stale a price is, in words. Deliberately coarse: the underlying
// number is only accurate to the last cron run, so "2h ago" is honest
// where "2h 14m ago" implies a precision the data does not have.
function ageLabel(seconds) {
  if (seconds == null) return null;
  if (seconds < 90) return "just now";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

// Past this the price is old enough that a reader should be told
// loudly rather than in grey 10px text. Sized to the observed cron
// reality: refresh-prices.yml asks for every 15 minutes and GitHub
// delivers 45 minutes to 3.5 hours on a public repo, so 45 minutes is
// normal and two hours means a run was actually missed.
const STALE_SECONDS = 2 * 3600;

// How old stored prices have to be before an open page goes and gets
// new ones. Below the scheduled interval, so a reader sitting on the
// page is never waiting on the cron; above the time a refresh takes, so
// two visitors seconds apart do not both trigger one.
const ON_DEMAND_AFTER_SECONDS = 180;

// Why a stored pair is not on screen, in the reader's words.
//
// A thin tab is honest work - economics is six verified pairs out of
// 2,208 Kalshi markets, because a wrong pair renders a fake arbitrage
// and precision beats recall. But "we found almost nothing" and "we
// found things and hid them" look identical from the outside, and the
// difference is the whole question of whether the tab can be trusted.
function hiddenReason(hidden) {
  if (!hidden || !hidden.total) return null;
  const parts = [];
  if (hidden.longShots) parts.push(`${hidden.longShots} trading under 5¢ or over 95¢`);
  if (hidden.expired) parts.push(`${hidden.expired} already settled`);
  if (hidden.missingPrice) parts.push(`${hidden.missingPrice} with no price on one side`);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}


// A card carries one Kalshi market and a leg per Polymarket venue.
// Every derived figure reads the legs the venue filter is actually
// showing, never all of them: with "US only" selected, a spread or an
// arb badge computed from the .com leg would describe a trade the
// reader cannot make.
function legsOf(m) { return m.legs || []; }
function widestSpread(m) {
  const gaps = legsOf(m).map(l => Math.abs(m.kalshi.yes - l.poly.yes));
  return gaps.length ? Math.max(...gaps) : 0;
}
// The leg a reader would act on: cheapest to own both sides. Legs with
// no executable price sink rather than sorting as a zero-cost trade.
function bestLeg(m) {
  return legsOf(m).reduce((best, l) => {
    if (!best) return l;
    const c = l.arb ? l.arb.cost : Infinity;
    const b = best.arb ? best.arb.cost : Infinity;
    return c < b ? l : best;
  }, null);
}
// Volume is THREE different quantities across these venues, and the old
// code added them:
//
//   Kalshi          contracts traded   (volume_fp)
//   polymarket.com  US dollars         (volumeNum)
//   polymarket.us   not published at all
//
// So "Total volume $59K" was contracts plus dollars plus a zero we
// invented, and no reader could reconcile it with either exchange. Each
// is now reported in its own unit, and never summed across venues.
function kalshiContracts(m) { return m.kalshi.volume || 0; }
function polyDollars(m) {
  const known = legsOf(m).map(l => l.poly.volume).filter(v => v != null);
  return known.length ? Math.max(...known) : null;
}
const compact = n =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` :
  n >= 1_000 ? `${(n / 1_000).toFixed(0)}K` : `${Math.round(n)}`;
function cardAge(m) {
  const ages = legsOf(m).map(l => l.priceAgeSeconds).filter(a => a != null);
  return ages.length ? Math.max(...ages) : null;
}
// The API now computes this from real books with both venues' taker
// fees applied (see lib/fees.js), so an alert means the two legs
// together cost less than the $1 they pay out — an actual trade rather
// than a midpoint artefact. The old check compared mids and allowed a
// 3-point cushion to stand in for costs it could not measure, which
// flagged edges that vanished the moment you crossed a spread.
//
// m.arb is null when a leg has no executable price. That is not zero
// edge, so it must not be flagged either way.
// The implausible-spread guard now lives in the API alongside the
// calculation, so `profitable` already accounts for it. Keeping a second
// copy here would be two places to update and one to forget.
function arbAlert(m) {
  return legsOf(m).some(l => l.arb && l.arb.profitable);
}

// ── Categories (UI display only) ──────────────────────────────
// Fetch config lives in pages/api/markets.js and pages/api/embed.js
// Display order for the sports sub-tabs. Anything not listed sorts
// last rather than being hidden, so a new league is visible the day it
// starts matching.
const LEAGUE_ORDER = ["mlb", "nfl", "nba", "nhl", "soccer"];
// A card carries its sport_tag ("mlb"), not its tab ("sports").
const CATEGORY_OF_CARD = { mlb: "sports", nfl: "sports", nba: "sports", nhl: "sports", soccer: "sports", econ: "economics", crypto: "crypto", politics: "politics" };
const LEAGUE_LABEL = { mlb: "MLB", nfl: "NFL", nba: "NBA", nhl: "NHL", soccer: "Soccer" };

const CATEGORIES = {
  sports:    { label: "Sports",    icon: "⚽", supported: true  },
  economics: { label: "Economics", icon: "📊", supported: true  },
  crypto:    { label: "Crypto",    icon: "₿",  supported: true  },
  politics:  { label: "Politics",  icon: "🏛️", supported: true  },
};

// ── Fetch from new Supabase-backed API ─────────────────────────
async function fetchMarkets(category, bypassEdgeCache = false) {
  // `/api/markets` is cached at Vercel's edge, and the edge keys on the
  // URL. The read that follows a manual refresh therefore has to ask a
  // DIFFERENT url, or it is served the copy cached before the refresh
  // wrote — the button reads the venues, stores new prices, and then
  // shows the old ones. That is the exact failure this project already
  // fixed once: a refresh button that looks like it works and does not.
  const bust = bypassEdgeCache ? `&fresh=${Date.now()}` : "";
  const res = await fetch(`/api/markets?category=${category}${bust}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return await res.json();
}

// Ask the server to go read the venues, but only if what it has stored
// is already older than `ifStale` seconds.
//
// The scheduled job is the floor, not the ceiling: it runs whether or
// not anyone is looking, and between runs the prices on screen age. A
// reader who has the page open is exactly the person for whom fresh
// prices matter, so their visit is what triggers the read. The
// cooldown is enforced server-side (see /api/refresh), so a hundred
// open tabs still produce one venue fetch.
//
// Failure is deliberately silent. This is an improvement on top of the
// scheduled prices, not a dependency: if CRON_SECRET is set later this
// call starts returning 401, and the page must keep working exactly as
// it does now — just with older numbers.
async function requestPriceRefresh(ifStale = 180) {
  try {
    const res = await fetch(`/api/refresh?ifStale=${ifStale}`);
    if (!res.ok) return false;
    const body = await res.json();
    return !body.skipped;
  } catch {
    return false;
  }
}

// ── Spread bar ─────────────────────────────────────────────────
function SpreadBar({ market }) {
  const kPct = Math.round(market.kalshi.yes * 100);

  // How far the touch prices sit apart on a venue. This is the cost the
  // midpoint hides, and the reason a wide mid gap is often no edge
  // while a narrow one can be.
  const width = (bid, ask) =>
    (bid == null || ask == null) ? null : Math.round((ask - bid) * 1000) / 10;
  const kWide = width(market.kalshi.bid, market.kalshi.ask);
  const legWidths = legsOf(market).map(l => width(l.poly.bid, l.poly.ask));
  const widths = [kWide, ...legWidths].filter(v => v != null);
  const widestBook = widths.length ? Math.max(...widths) : null;

  // ONE bar colour, not one per venue.
  //
  // Two near-identical slates read as an encoding and carried none: at
  // 6px the difference between #1E293B and #475569 is invisible, so the
  // rows looked like they meant something and did not. A single weight
  // is more honest and reads as deliberate rather than drab.
  //
  // What separates the rows is what always separated them — the label,
  // which spells the venue out — plus LENGTH, which is the only thing a
  // reader should be comparing here. Bars go 6px -> 9px and the track
  // lightens, so the comparison the card exists for is the loudest
  // thing in it.
  //
  // Venues still do not own a hue. That is what lets the brand gradient
  // exist and keeps green/red/amber meaning "act on this".
  const Row = ({ label, pct, right }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {/* Wide enough for POLY GLOBAL, the longest label, so no venue
          name wraps or truncates. */}
      <span style={{ width: 96, flexShrink: 0, whiteSpace: "nowrap", fontSize: 11, color: T.text, fontWeight: 700, letterSpacing: "0.03em" }}>{label}</span>
      <div style={{ flex: 1, height: 9, background: BAR_TRACK, borderRadius: 99, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: BAR_FILL, borderRadius: 99, transition: "width 0.6s ease" }} />
      </div>
      <span style={{ width: 34, fontSize: 13, fontWeight: 700, color: T.text, textAlign: "right" }}>{pct}%</span>
      {right}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Row label="KALSHI" pct={kPct} />
      {/* One row per venue rather than one card per venue. The same
          fixture used to render twice, a few cents apart, with nothing
          saying the two cards were the same claim — and since a US
          account cannot trade .com, "which one is this?" was the first
          question the layout raised and the last one it answered. */}
      {legsOf(market).map(l => (
        <Row
          key={l.pairId}
          // "POLY US" AND "POLY" DIFFER BY TWO CHARACTERS, AND THE
          // UNQUALIFIED ONE IS THE ONE YOU CANNOT TRADE.
          //
          // Two near-identical labels a few cents apart read as the
          // same venue listed twice, or a typo — and a reader who has
          // heard of Polymarket takes the bare "POLY" for the real one,
          // which is exactly backwards: that is polymarket.com, closed
          // to US accounts. Both labels name a jurisdiction now, so
          // neither reads as the default and the contrast is the thing
          // that actually differs between them.
          label={l.poly.usTradable ? "POLY US" : "POLY GLOBAL"}
          pct={Math.round(l.poly.yes * 100)}
        />
      ))}
      {/* The bars are MIDPOINTS; the arb is computed from asks. Those
          two disagree constantly, and an older line here made it worse
          by putting a lightning bolt on any mid gap over 5 points — so
          a card could advertise "7pt spread" while costing 131c to own
          both sides, and another could show 2pt and be a real edge.
          What actually decides it is book width. */}
      {/* paddingLeft lines up with where the bars start: label width
          plus the row gap. */}
      {widestBook != null && (
        <span style={{ fontSize: 10, color: T.muted, letterSpacing: "0.03em", paddingLeft: 106 }}>
          widest book {widestBook.toFixed(1)}pt
        </span>
      )}
    </div>
  );
}

// The contract, in the venue's own words.
//
// Every pair on this site is a CLAIM that two markets mean the same
// thing, and until now the reader had no way to check it. Titles are
// not the contract: "above $99,999.99" and "reach $100,000" are one
// market reading as two, while "reach X by Dec 31" and "above X AT Dec
// 31" are two reading as one — the second is a touch market and is
// strictly likelier to resolve Yes. Both texts, side by side, is what
// turns "trust the matcher" into something a person can verify.
function Resolution({ label, color, text }) {
  if (!text) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color, letterSpacing: "0.04em", marginBottom: 3 }}>
        {label} RESOLVES ON
      </div>
      <div style={{ fontSize: 12, color: T.text, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{text}</div>
    </div>
  );
}

function Details({ market, legs }) {
  const anyResolution = market.resolution || legs.some(l => l.resolution);
  return (
    <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12, marginTop: 2 }}>
      {legs.map(leg => leg.arb && leg.arb.breakdown && (
        <div key={`${leg.pairId}-cost`} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, letterSpacing: "0.04em", marginBottom: 4 }}>
            COST TO OWN BOTH SIDES · {leg.poly.venue.toUpperCase()}
          </div>
          {/* The total was asserted and never explained. Owning both
              sides pays exactly $1.00, so what decides whether it is a
              trade is what the two legs cost INCLUDING fees — and the
              fee is the part a reader cannot see on either exchange. */}
          {leg.arb.breakdown.map((b, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: T.muted, padding: "1px 0" }}>
              <span>Buy {b.venue} {b.side}</span>
              <span style={{ color: T.text, fontVariantNumeric: "tabular-nums" }}>{(b.cost * 100).toFixed(2)}¢</span>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 700, borderTop: `1px solid ${T.border}`, marginTop: 4, paddingTop: 4 }}>
            <span style={{ color: T.text }}>Total, fees included</span>
            <span style={{ color: leg.arb.profitable ? T.arb : T.text, fontVariantNumeric: "tabular-nums" }}>
              {(leg.arb.cost * 100).toFixed(2)}¢
            </span>
          </div>
          <div style={{ fontSize: 11, color: T.muted, marginTop: 3 }}>
            Pays $1.00 · {leg.arb.edge >= 0 ? "+" : ""}{(leg.arb.edge * 100).toFixed(2)}¢ per contract
            {leg.arb.maxContracts != null && (
              <> · {leg.arb.depthKnown ? "" : "at most "}{Math.floor(leg.arb.maxContracts)} contract{Math.floor(leg.arb.maxContracts) === 1 ? "" : "s"} at this price</>
            )}
          </div>
          {/* Polymarket publishes no size, so the binding leg may be
              smaller than the one we can see. Saying "at most" is the
              difference between a bound and a promise. */}
          {!leg.arb.depthKnown && (
            <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>
              Size is an upper bound — {leg.poly.venue} publishes no depth.
            </div>
          )}
        </div>
      ))}

      {anyResolution ? (
        <>
          <Resolution label="KALSHI" color={VENUE.kalshi} text={market.resolution} />
          {legs.map(leg => (
            <Resolution key={`${leg.pairId}-res`} label={leg.poly.venue.toUpperCase()} color={VENUE.poly} text={leg.resolution} />
          ))}
          <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.4 }}>
            Read both before trading. A pair is our judgement that these two
            contracts settle the same way; the venues' own words are the evidence.
          </div>
        </>
      ) : (
        /* The column is nullable and populates as discovery re-runs, so
           an empty panel has to say WHY rather than look broken. */
        <div style={{ fontSize: 11, color: T.muted }}>
          Resolution text hasn't been fetched for this market yet.
        </div>
      )}
    </div>
  );
}

function MarketCard({ market, pinned, onPin, showTrending = true }) {
  const isArb = arbAlert(market);
  const legs = legsOf(market);
  const age = cardAge(market);
  const [open, setOpen] = useState(false);

  // Pinned outranks arb for the BORDER, because pinning is a thing the
  // reader just did and the arb badge is still on the card either way.
  const edge = pinned ? ACCENT : (isArb ? T.arb : T.border);
  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${edge}`,
      borderRadius: 10, padding: "18px 20px",
      display: "flex", flexDirection: "column", gap: 14,
      boxShadow: pinned ? `0 0 0 2px ${ACCENT}26`
               : isArb ? `0 0 0 1px ${T.arb}22`
               : "0 1px 3px rgba(0,0,0,0.04)",
    }}>
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
          {/* `trending` is a volume FLOOR (>5000), not a trend, so on a
              page that selects the top-volume market in each category
              it is true on every card by construction — a badge that is
              always lit says nothing and costs the reader a glance. */}
          {showTrending && market.trending && <span style={{ fontSize: 10, fontWeight: 600, color: T.yes, letterSpacing: "0.04em" }}>↑ TRENDING</span>}
          {/* A dedicated control, not a click on the card body. The card
              already carries three links and an expander; making the
              whole surface a pin target would steal those clicks.

              Optional, because pinning answers "keep this one in view
              while I scroll past four hundred others" — a question the
              home page's four cards do not raise. Rendering it there
              would offer a control whose effect is invisible on the
              page you are on. */}
          {onPin && <button
            onClick={() => onPin(pinned ? null : market.id)}
            aria-pressed={!!pinned}
            title={pinned ? "Unpin" : "Pin this matchup to the top while you scroll"}
            style={{
              marginLeft: "auto", border: "none", background: "transparent",
              cursor: "pointer", padding: 0, fontSize: 11, fontWeight: 700,
              letterSpacing: "0.04em", color: pinned ? ACCENT : T.muted,
            }}
          >
            {pinned ? "\u2716 UNPIN" : "\u2295 PIN"}
          </button>}
          {/* Sits next to the arb badge on purpose. A flagged edge on a
              three-hour-old book is the one combination that costs a
              reader money, and it looked exactly like a fresh one. */}
          {age != null && (
            <span
              title="When these books were last read. Prices come from a scheduled job, not a live feed."
              style={{
                fontSize: 10,
                letterSpacing: "0.04em",
                // The pin button carries the auto margin that pushes
                // this row apart. Without it the age would sit against
                // the left edge, so it takes the margin over.
                marginLeft: onPin ? undefined : "auto",
                fontWeight: age > STALE_SECONDS ? 700 : 400,
                color: age > STALE_SECONDS ? T.arb : T.muted,
              }}
            >
              {age > STALE_SECONDS && "⏳ "}{ageLabel(age)}
            </span>
          )}
        </div>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: T.text, lineHeight: 1.4 }}>{market.title}</p>
      </div>

      <SpreadBar market={market} />

      {/* One block per venue. Each states its own cost, its own edge and
          its own match quality, because polymarket.com and
          polymarket.us are separate exchanges with separate books — a
          single blended number would quote a reader an edge on a venue
          they may not be able to trade. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
        {/* Kalshi's link belongs WITH the other venue links, not in the
            footer opposite them. One was top-left of this block and the
            other bottom-right of the card, so two links doing the same
            job sat diagonally apart and neither lined up with anything.
            Every venue link is now the same size, weight and left edge,
            in the same order as the bars above. */}
        <a
          href={market.kalshi.url} target="_blank" rel="noopener noreferrer"
          style={{ fontSize: 11, fontWeight: 700, color: ACCENT, letterSpacing: "0.03em", textDecoration: "none" }}
        >
          Kalshi ↗
        </a>
        {legs.map(l => {
          const legArb = l.arb && l.arb.profitable;
          return (
            <div key={l.pairId} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                {/* The venue name IS the link, on both venues. Kalshi's
                    link read "Kalshi ↗" while Polymarket's read "Open ↗",
                    so two links doing the same job were labelled
                    differently and neither said it went to the same kind
                    of place. Naming the destination is also one word
                    shorter than naming it and then saying "Open". */}
                <a
                  href={l.poly.url} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 11, fontWeight: 700, color: ACCENT, letterSpacing: "0.03em", textDecoration: "none" }}
                >
                  {l.poly.usTradable ? "Polymarket US" : "polymarket.com"} ↗
                  {!l.poly.usTradable && (
                    <span style={{ fontWeight: 400, color: T.muted }}> · can't trade from the US</span>
                  )}
                </a>
                <span style={{ display: "flex", gap: 10, fontSize: 11 }}>
                  {/* Only when it is not a certainty. Sports pairs join on
                      the game identifier, so every one of them scored
                      "100% match" — the same badge on all 25 cards, saying
                      nothing. A similarity below 1 is a real caveat and
                      still shown. */}
                  {l.similarity != null && l.similarity < 0.999 && (
                    <span style={{ color: T.muted }}>{Math.round(l.similarity * 100)}% match</span>
                  )}
                </span>
              </div>
              <div style={{ fontSize: 11, color: legArb ? T.arb : T.muted, fontWeight: legArb ? 700 : 400 }}>
                {/* null is "no executable price on at least one leg",
                    which is a different answer from "no edge" and must
                    never render as a zero. */}
                {!l.arb ? (
                  "no executable price"
                ) : legArb ? (
                  <>
                    ⚡ ARB +{(l.arb.edge * 100).toFixed(1)}¢
                    {l.arb.maxContracts != null && (
                      <span style={{ fontWeight: 400, color: T.muted }}>
                        {" "}· {l.arb.depthKnown ? "" : "≤"}{Math.floor(l.arb.maxContracts)} contracts
                        {l.arb.edgeDollars != null && ` (~$${l.arb.edgeDollars.toFixed(2)})`}
                      </span>
                    )}
                  </>
                ) : (
                  `${(l.arb.cost * 100).toFixed(1)}¢ to own both sides`
                )}
              </div>
              {/* Shown exactly when the pairing was a JUDGEMENT rather than
                  a join. Sports matches on the game identifier, so this
                  line was a paragraph of boilerplate restating the card
                  title on all 25 cards ("Who will win in the upcoming
                  baseball event Miami Marlins vs Washington Nationals
                  scheduled for..."). On econ and crypto the same line is
                  the only way to check WHAT the Kalshi market was matched
                  against, which is the thing most worth checking. */}
              {l.polyTitle && l.polyTitle !== market.title && l.similarity < 0.999 && (
                <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.3 }}>{l.polyTitle}</div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", fontSize: 11, color: T.muted, flexWrap: "wrap", gap: 8 }}>
        {/* Per venue, in that venue's own unit. A cost figure on a market
            nobody has traded is not a quote anyone can take, so zero
            still earns a warning — but only where the venue actually
            reports zero. polymarket.us publishes no volume at all, and
            saying "no trades yet" about it was asserting something we
            do not know. */}
        <span>
          {(() => {
            const k = kalshiContracts(market);
            const p = polyDollars(market);
            const bits = [];
            if (k > 0) bits.push(`Kalshi ${compact(k)} contracts`);
            if (p != null && p > 0) bits.push(`Polymarket $${compact(p)}`);
            if (bits.length) return bits.join(" · ");
            if (k === 0) return "No trades on Kalshi yet — prices are quotes, not fills";
            return "Volume not published";
          })()}
        </span>
      </div>

      {/* Collapsed by default. The grid is for scanning; this is for the
          one card a reader has decided to take seriously, and putting
          the contract text on every card would bury the prices under
          paragraphs of settlement language. */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          border: "none", background: "transparent", padding: 0, cursor: "pointer",
          fontSize: 11, fontWeight: 600, color: T.muted, textAlign: "left",
          fontFamily: "inherit", marginTop: -4,
        }}
      >
        {open ? "Hide details ▲" : "How this settles, and what it costs ▼"}
      </button>

      {open && <Details market={market} legs={legs} />}
    </div>
  );
}

// ── Loading skeleton ───────────────────────────────────────────
function Skeleton() {
  return (
    <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fill, minmax(min(380px, 100%), 1fr))" }}>
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

// The pinned matchup, held under the nav while the list scrolls.
//
// A strip rather than frozen panes. Freezing a column is a desktop-table
// idea that has nowhere to go on a 375px screen, where this site gets
// most of its traffic; a strip is the same affordance in one dimension
// and survives the fold.
//
// Deliberately CONDENSED, not a second copy of the card. Two full cards
// on screen — one pinned, one being read — is the layout the merge into
// `legs` was meant to end. What a reader pins a matchup FOR is its
// numbers, so the strip carries the prices and the cost and drops
// everything else.
function PinnedStrip({ market, onClear }) {
  const legs = legsOf(market);
  const best = bestLeg(market);
  return (
    <div style={{
      maxWidth: 900, margin: "0 auto", paddingBottom: 10,
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
    }}>
      <div style={{
        flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 12,
        flexWrap: "wrap",
        border: `1px solid ${ACCENT}55`, background: `${ACCENT}0A`,
        borderRadius: 8, padding: "8px 12px",
      }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", color: ACCENT }}>PINNED</span>
        <span style={{ flex: 1, minWidth: 120, fontSize: 12, fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {market.title}
        </span>
        <span style={{ display: "flex", gap: 10, fontSize: 11, color: T.muted, flexWrap: "wrap" }}>
          <span><strong style={{ color: T.text }}>{pct(market.kalshi.yes)}</strong> Kalshi</span>
          {legs.map(l => (
            <span key={l.pairId}>
              <strong style={{ color: T.text }}>{l.poly.yes == null ? "—" : pct(l.poly.yes)}</strong>{" "}
              {l.poly.usTradable ? "Poly US" : "Poly"}
            </span>
          ))}
          {/* Same rule as the card: no executable price is not zero edge. */}
          {best?.arb && (
            <span style={{ color: best.arb.profitable ? T.arb : T.muted, fontWeight: best.arb.profitable ? 700 : 400 }}>
              {(best.arb.cost * 100).toFixed(1)}¢ both sides
            </span>
          )}
        </span>
        <button
          onClick={onClear}
          aria-label="Unpin"
          style={{ border: "none", background: "transparent", cursor: "pointer", color: ACCENT, fontSize: 13, padding: 0, lineHeight: 1 }}
        >
          {"\u2715"}
        </button>
      </div>
    </div>
  );
}

function MenuItem({ label, onClick, active, soon }) {
  return (
    <button
      onClick={soon ? undefined : onClick}
      disabled={!!soon}
      style={{
        width: "100%", textAlign: "left", padding: "11px 16px",
        background: active ? `${ACCENT}0E` : "transparent",
        border: "none", borderTop: `1px solid ${T.border}`,
        color: soon ? T.muted : (active ? ACCENT : T.text),
        fontWeight: active ? 700 : 500, fontSize: 14,
        cursor: soon ? "default" : "pointer",
        display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
      }}
    >
      <span>{label}</span>
      {soon && <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.04em", color: T.muted, textTransform: "uppercase" }}>Soon</span>}
    </button>
  );
}

// ── Home ───────────────────────────────────────────────────────
//
// A way in, not a dashboard. Someone arriving from a link has no idea
// what this site compares, and the old front door was the sports tab
// with no explanation.
//
// "Most traded" is ranked by KALSHI CONTRACTS, and says so. It is the
// one figure every card has — Polymarket reports dollars and
// polymarket.us reports nothing — so a combined "volume" would be three
// units added together. The category badge on each row matters: those
// markets run to millions of contracts where a ball game runs to
// thousands, so this list is politics-heavy, and that is a fact about
// the venues rather than a bug.
// One box, rendered in two places — above the category tabs, and inside
// the home hero. Duplicating the markup would be two places for the
// placeholder, the clear button and the Escape key to drift apart.
function SearchBox({ query, setQuery, active, marginBottom }) {
  return (
    <div style={{ position: "relative", marginBottom }}>
      <input
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => { if (e.key === "Escape") setQuery(""); }}
        placeholder="Search every market on Kalshi and Polymarket…"
        aria-label="Search markets"
        style={{
          width: "100%", boxSizing: "border-box",
          padding: "12px 40px 12px 14px",
          fontSize: 15, color: T.text, background: T.surface,
          border: `1px solid ${active ? ACCENT : T.border}`,
          borderRadius: 10, outline: "none",
          fontFamily: "inherit",
        }}
      />
      {query && (
        <button
          onClick={() => setQuery("")}
          aria-label="Clear search"
          style={{
            position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
            border: "none", background: "transparent", color: T.muted,
            fontSize: 18, cursor: "pointer", padding: "4px 10px", lineHeight: 1,
          }}
        >×</button>
      )}
    </div>
  );
}

function HomeView({ data, onCategory, query, setQuery, searchMode }) {
  const cards = data?.pairs || [];
  const counts = data?.byCategory || {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // THE HOME PAGE SHOWS THE VENUE YOU CAN ACTUALLY TRADE.
  //
  // Every category tab defaults to `venue = "us"`, and the front door
  // did not — so the same market rendered three bars here and two
  // there. On the Newsom card that read POLY US 16% above POLY GLOBAL
  // 14%, and the row a US account cannot act on sat there looking like
  // a third opinion.
  //
  // Selection has to move with the filter, though, or it breaks the
  // card. Crypto's most-traded market is listed on polymarket.com and
  // NOT on polymarket.us: drop its only Polymarket leg and what is left
  // is a price-COMPARISON card with one price on it. So the rule is the
  // most-traded market in each category THAT HAS A US LEG.
  const usLegs = m => legsOf(m).filter(l => l.poly.usTradable);
  const toUs = m => ({ ...m, legs: usLegs(m) });

  // The API returns up to three per tab, already ranked by volume. The
  // first US-tradable one of each tab becomes a full card; everything
  // else stays in the list below, so nothing is shown twice and the
  // list keeps its job of showing breadth rather than repeating the
  // four cards above it.
  const featured = [];
  const rest = [];
  const taken = new Set();
  for (const m of cards) {
    const tab = CATEGORY_OF_CARD[m.category] || m.category;
    if (!taken.has(tab) && usLegs(m).length > 0) {
      taken.add(tab);
      featured.push(toUs(m));
    } else {
      rest.push(m);
    }
  }
  // A category with nothing US-tradable in its top three still needs a
  // card, and its global leg beats an empty slot or a lone Kalshi bar —
  // the leg already says "can't trade from the US" on its own line.
  for (const m of cards) {
    const tab = CATEGORY_OF_CARD[m.category] || m.category;
    if (taken.has(tab)) continue;
    taken.add(tab);
    featured.push(m);
    const i = rest.indexOf(m);
    if (i >= 0) rest.splice(i, 1);
  }

  return (
    <div>
      <div style={{ marginBottom: 26 }}>
        <h1 style={{ margin: "0 0 8px", fontSize: 26, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>
          Same event, different market
        </h1>
        <p style={{ margin: 0, fontSize: 14, color: T.muted, lineHeight: 1.5, maxWidth: 620 }}>
          {/* "Polymarket and Polymarket US" is a distinction that costs a
              new reader a paragraph to understand and buys them nothing
              on the first screen — they have not seen a card yet. The
              cards name the venue on every row and the tabs carry the
              full US / Global control, so the split is explained where
              it MATTERS rather than before anything has been shown. */}
          Kalshi and Polymarket, side by side — with fees already in the price.{" "}
          {total > 0 && <><strong style={{ color: T.text }}>{total.toLocaleString()}</strong> matched markets right now.</>}
        </p>
      </div>

      {/* UNDER the hero, not above it. A control before any context
          asks the reader to act before they know what the site is;
          the headline is one line and then the box is the first thing
          they can do. On a category tab the order is reversed — they
          already know, so search leads. */}
      <SearchBox query={query} setQuery={setQuery} active={searchMode} marginBottom={26} />

      {/* THE TILES ARE THE FALLBACK, NOT THE FRONT DOOR.
          Each card below now carries its category, its count and its
          way in, so a row of tiles above them says the same four things
          twice and pushes the actual price comparison off the first
          screen. They stay for the case where there are no cards to
          carry it — a cold cache or a failed read still needs a way
          into every tab. */}
      {featured.length === 0 && (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(190px, 100%), 1fr))", gap: 10, marginBottom: 30 }}>
        {Object.entries(CATEGORIES).map(([key, cat]) => (
          <button
            key={key}
            onClick={() => onCategory(key)}
            style={{
              textAlign: "left", cursor: "pointer", background: T.surface,
              border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px",
              display: "flex", flexDirection: "column", gap: 4, transition: "border-color 0.15s",
            }}
          >
            <span style={{ fontSize: 18 }}>{cat.icon}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{cat.label}</span>
            <span style={{ fontSize: 12, color: T.muted }}>
              {/* undefined and 0 are different answers: one is "still
                  loading", the other is "nothing matched". */}
              {counts[key] == null ? "—" : `${counts[key]} matched`}
            </span>
          </button>
        ))}
      </div>
      )}

      {/* THE FRONT DOOR HAS TO SHOW THE THING.
          Four tiles and a list of titles described a price-comparison
          site without comparing a single price: a new reader understood
          what it was and had no reason to care. These are the real
          cards, one per category, so the first screen answers "what do
          I get" by handing it over rather than describing it. */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: T.text }}>Most traded in each category</h2>
        <span style={{ fontSize: 11, color: T.muted }}>
          most traded on Kalshi, tradable from the US
        </span>
      </div>

      {cards.length === 0 ? (
        <div style={{ padding: 24, border: `1px solid ${T.border}`, borderRadius: 10, background: T.surface, fontSize: 13, color: T.muted, marginBottom: 30 }}>
          Loading the most traded markets…
        </div>
      ) : (
        <div style={{
          display: "grid",
          // Same track rule as the category grids: wider than a phone,
          // clamped to the container, so one declaration gives two
          // columns on a laptop and one on a 375px screen.
          gridTemplateColumns: "repeat(auto-fit, minmax(min(380px, 100%), 1fr))",
          gap: 14, marginBottom: 30, alignItems: "start",
        }}>
          {featured.map(m => {
            const tab = CATEGORY_OF_CARD[m.category] || m.category;
            return (
              <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: "0.05em",
                    textTransform: "uppercase", color: T.muted,
                  }}>
                    {CATEGORIES[tab]?.icon} {CATEGORIES[tab]?.label || tab}
                  </span>
                  <button
                    onClick={() => onCategory(tab)}
                    style={{
                      border: "none", background: "transparent", cursor: "pointer", padding: 0,
                      fontSize: 11, fontWeight: 700, color: ACCENT, letterSpacing: "0.03em",
                    }}
                  >
                    {counts[tab] == null ? "See all" : `See all ${counts[tab]}`} →
                  </button>
                </div>
                {/* No onPin: see MarketCard. */}
                <MarketCard market={m} showTrending={false} />
              </div>
            );
          })}
        </div>
      )}

      {rest.length > 0 && (
        <>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: T.text }}>Also trading</h2>
      </div>

      {(
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, background: T.surface, overflow: "hidden" }}>
          {rest.map((m, i) => {
            const tab = CATEGORY_OF_CARD[m.category] || m.category;
            return (
              <button
                key={m.id}
                onClick={() => onCategory(tab)}
                style={{
                  width: "100%", textAlign: "left", cursor: "pointer", background: "transparent",
                  border: "none", borderTop: i === 0 ? "none" : `1px solid ${T.border}`,
                  padding: "12px 16px", display: "flex", alignItems: "center", gap: 12,
                }}
              >
                {/* The category sits ABOVE the title rather than in a
                    column beside it. A 74px label column plus a volume
                    column left a phone about 120px for the title, which
                    wrapped four lines and made the list taller than the
                    cards it is meant to sit under. */}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{
                    display: "block", fontSize: 10, fontWeight: 700, letterSpacing: "0.04em",
                    textTransform: "uppercase", color: T.muted, marginBottom: 2,
                  }}>
                    {CATEGORIES[tab]?.label || tab}
                  </span>
                  <span style={{ fontSize: 13, color: T.text }}>{m.title}</span>
                </span>
                <span style={{ fontSize: 12, color: T.muted, whiteSpace: "nowrap" }}>
                  {compact(m.kalshi?.volume || 0)} contracts
                </span>
              </button>
            );
          })}
        </div>
      )}
        </>
      )}
    </div>
  );
}

// ── Main app ───────────────────────────────────────────────────
function priceCell(v) {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

// Volume is three different quantities and is never summed or compared
// across venues: Kalshi reports CONTRACTS, polymarket.com US DOLLARS,
// and polymarket.us publishes nothing. A bare number would invite the
// reader to compare them.
function volumeLabel(vol) {
  if (!vol || vol.value == null) return null;
  const n = vol.value >= 1e6 ? `${(vol.value / 1e6).toFixed(1)}M`
          : vol.value >= 1e3 ? `${(vol.value / 1e3).toFixed(0)}K`
          : String(Math.round(vol.value));
  return vol.unit === "usd" ? `$${n}` : `${n} contracts`;
}

function VenueLine({ m, similarity }) {
  const isK = m.platform === "kalshi";
  // A link is a link. Colouring it by destination said nothing the
  // venue name beside it did not already say.
  const color = ACCENT;
  const vol = volumeLabel(m.volume);
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", padding: "3px 0" }}>
      <a href={m.url} target="_blank" rel="noopener noreferrer"
         style={{ color, fontSize: 12, fontWeight: 700, textDecoration: "none", minWidth: 104 }}>
        {m.venue} ↗
      </a>
      <span style={{ fontSize: 14, fontWeight: 700, color: T.text, minWidth: 44 }}>{priceCell(m.yes)}</span>
      {vol && <span style={{ fontSize: 11, color: T.muted }}>{vol}</span>}
      {similarity != null && similarity < 1 && (
        <span style={{ fontSize: 11, color: T.muted }}>{Math.round(similarity * 100)}% match</span>
      )}
    </div>
  );
}

function SearchResult({ r }) {
  const matched = r.kind === "matched";
  return (
    <div style={{
      border: `1px solid ${matched ? `${ACCENT}44` : T.border}`,
      borderRadius: 10, background: T.surface, padding: 14,
      opacity: r.live ? 1 : 0.62,
    }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginBottom: 8 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
          color: matched ? ACCENT : T.muted,
          background: matched ? `${ACCENT}14` : "transparent",
          padding: matched ? "2px 7px" : 0, borderRadius: 99,
        }}>
          {matched ? `On ${r.counterparts.length + 1} venues` : `Only on ${r.market.venue}`}
        </span>
        {r.category && <span style={{ fontSize: 10, color: T.muted }}>{r.category}</span>}
        {/* A settled market is still a real answer to "does this exist".
            Saying so beats hiding it and beats showing 0% unexplained. */}
        {!r.live && <span style={{ fontSize: 10, color: T.muted }}>settled / not quoted</span>}
      </div>

      <div style={{ fontSize: 14, fontWeight: 600, color: T.text, lineHeight: 1.35, marginBottom: 8 }}>
        {r.market.title}
      </div>

      <VenueLine m={r.market} />
      {r.counterparts.map(c => (
        <div key={c.id}>
          <VenueLine m={c} similarity={c.similarity} />
          {c.title !== r.market.title && (
            <div style={{ fontSize: 11, color: T.muted, marginLeft: 112, marginTop: -2, marginBottom: 2 }}>{c.title}</div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function HouseEdge() {
  // Kept as a name because a dozen call sites read it, but it is now
  // DERIVED from the url rather than a second source of truth. Two
  // places holding "which tab" is how a back button ends up showing one
  // tab's data under another tab's heading.
  const [homeData, setHomeData] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Cleared when the tab changes: a matchup pinned on sports has no
  // meaning above a politics list, and leaving it there would be a
  // stale row the reader did not put here.
  const [pinnedId, setPinnedId] = useState(null);
  const [sort, setSort] = useState("trending");
  // Sports is four leagues sharing one tab. Derived from the cards
  // rather than a constant, so a league that starts matching appears
  // without a code change and one that stops does not leave a dead chip.
  const [league, setLeague] = useState("all");

  // THE URL IS THE STATE, not a mirror of it.
  //
  // Everything here used to live in React state alone, so every view had
  // the same address: a reader could not link anyone to the politics tab,
  // the back button left the site, and a refresh dropped them on sports.
  // For a site with a domain and a social account, a page you cannot link
  // to is a page that cannot be shared.
  //
  // Shallow routing rather than separate page files — the data fetch is
  // the same call either way, so splitting the file would buy nothing and
  // cost a rewrite.
  const router = useRouter();
  const urlCategory = typeof router.query.category === "string" ? router.query.category : null;
  const view = urlCategory && CATEGORIES[urlCategory] ? "category" : "home";
  const activeCategory = view === "category" ? urlCategory : "sports";

  const goHome = useCallback(() => {
    router.push("/", undefined, { shallow: true });
  }, [router]);

  const goCategory = useCallback((key) => {
    setQuery("");
    setLeague("all");
    setPinnedId(null);
    router.push({ pathname: "/", query: { category: key } }, undefined, { shallow: true });
  }, [router]);
  // "Show me only the ones I can act on." The arb badge already exists;
  // this makes it a filter rather than something to scroll for.
  const [arbOnly, setArbOnly] = useState(false);
  // Which Polymarket to compare against. They are different exchanges
  // and a US account can only trade the .us one, so this is not cosmetic
  // — it decides whether a card in front of you is actionable.
  // Defaults to the venue the reader can actually trade. A US account
  // cannot trade polymarket.com, so showing .com prices and .com links
  // by default hands them numbers they cannot act on and a link that
  // goes nowhere useful — which is exactly what happened on economics
  // and politics, where every pair is .com.
  const [venue, setVenue] = useState("us");
  const [markets, setMarkets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [unsupported, setUnsupported] = useState(false);
  const [needsEmbed, setNeedsEmbed] = useState(false);
  const [hidden, setHidden] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [searchData, setSearchData] = useState(null);
  const [searching, setSearching] = useState(false);

  const loadMarkets = useCallback(async (categoryKey, bypassEdgeCache = false) => {
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
      const { pairs, needsEmbed: ne, hidden: h } = await fetchMarkets(categoryKey, bypassEdgeCache);
      setMarkets(pairs || []);
      setNeedsEmbed(!!ne);
      setHidden(h || null);
      // Deliberately NOT `new Date()`. That is when this browser asked,
      // which is not a fact about the prices on screen and reads as
      // though it were. The age comes from the data itself, and the
      // stalest leg in the category is the one worth reporting: a reader
      // scanning the list should see the worst case, not an average that
      // hides it.
      setFetchedAt(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Pull fresh prices, then re-read. Used by the ↻ button and by the
  // staleness check below.
  const refreshPrices = useCallback(async (categoryKey, ifStale) => {
    setRefreshing(true);
    try {
      const didWork = await requestPriceRefresh(ifStale);
      // Only re-read when the server actually wrote something. A skipped
      // call means the stored prices were already fresh, and re-fetching
      // to display the same numbers is a spinner for nothing.
      // Bypass the edge cache: the refresh only just wrote the prices
      // this read is meant to show.
      if (didWork) await loadMarkets(categoryKey, true);
    } finally {
      setRefreshing(false);
    }
  }, [loadMarkets]);

  useEffect(() => {
    if (view !== "category") return undefined;
    loadMarkets(activeCategory);
    const interval = setInterval(() => loadMarkets(activeCategory), 60_000);
    return () => clearInterval(interval);
  }, [activeCategory, view, loadMarkets]);


  const venueOf = leg => (leg.poly.usTradable ? "us" : "global");
  // Cards carrying at least one leg on that venue. A card with both is
  // counted under both, which is the honest answer to "how many of
  // these can I trade on Polymarket US?" now that one card can span
  // two exchanges.
  const venueCounts = markets.reduce((acc, m) => {
    for (const v of new Set(legsOf(m).map(venueOf))) acc[v] = (acc[v] || 0) + 1;
    return acc;
  }, {});

  // Filters LEGS and drops cards left with none, rather than filtering
  // whole cards. A game listed on both exchanges is one card; hiding it
  // entirely under "US only" would hide a market the reader can
  // actually trade, and showing it with its .com leg still attached
  // would quote them a price they cannot take.
  const byVenue = venue === "all"
    ? markets
    : markets
        .map(m => ({ ...m, legs: legsOf(m).filter(l => venueOf(l) === venue) }))
        .filter(m => m.legs.length > 0);

  // Derived from the VENUE-FILTERED set, not from every market. Counting
  // the unfiltered list would let a chip read "NFL 25" and then show
  // nothing under the US filter — a label disagreeing with its own
  // result, which is the failure the venue control already avoids.
  const leaguesPresent = [...new Set(byVenue.map(m => m.category).filter(Boolean))]
    .sort((a, b) => (LEAGUE_ORDER.indexOf(a) + 1 || 99) - (LEAGUE_ORDER.indexOf(b) + 1 || 99));

  const byLeague = league === "all" ? byVenue : byVenue.filter(m => m.category === league);
  // Filters the CARDS, and the count beside the toggle counts the same
  // set — a filter whose label disagrees with its result is worse than
  // no filter.
  const visible = arbOnly ? byLeague.filter(arbAlert) : byLeague;

  const sorted = [...visible].sort((a, b) => {
    // The executable ranking, and the one that should be reachable
    // first: mid gap sorts by an appearance, this sorts by what the
    // trade costs. Unpriceable pairs sink rather than sorting as zero.
    if (sort === "cost") {
      const la = bestLeg(a), lb = bestLeg(b);
      const ca = la && la.arb ? la.arb.cost : Infinity;
      const cb = lb && lb.arb ? lb.arb.cost : Infinity;
      return ca - cb;
    }
    if (sort === "spread") return widestSpread(b) - widestSpread(a);
    if (sort === "volume") return kalshiContracts(b) - kalshiContracts(a);
    // Biggest edge first. A pair with no executable price sinks rather
    // than sorting as a zero edge, for the same reason "no price" and
    // "no edge" render differently on the card.
    if (sort === "arb") {
      const ea = bestLeg(a)?.arb?.edge, eb = bestLeg(b)?.arb?.edge;
      return (eb == null ? -Infinity : eb) - (ea == null ? -Infinity : ea);
    }
    if (sort === "similarity") return (bestLeg(b)?.similarity || 0) - (bestLeg(a)?.similarity || 0);
    return (b.trending ? 1 : 0) - (a.trending ? 1 : 0);
  });

  // Counted BEFORE the arb filter. Counting `visible` would make the
  // toggle's own label change when you press it — the number would
  // always equal the row count once on, which tells the reader nothing.
  // Resolved from the CURRENTLY VISIBLE set, not from `markets`. A card
  // filtered out by venue or league is not on screen, and a strip
  // describing something the reader cannot see is a ghost.
  const pinnedCard = pinnedId ? visible.find(m => m.id === pinnedId) || null : null;

  const arbCount = byLeague.filter(arbAlert).length;
  // The stalest leg among what is actually on screen. Reported rather
  // than an average, because the reader is about to act on the worst
  // one, not the typical one.
  const oldestAge = visible.reduce((worst, m) => {
    const a = cardAge(m);
    return a != null && (worst == null || a > worst) ? a : worst;
  }, null);
  // Someone is looking, so it is worth going to get current prices.
  // Guarded on the stored age rather than fired on every render: the
  // server would no-op anyway, but not making the call at all is
  // cheaper than being told it was pointless.
  useEffect(() => {
    if (loading || refreshing) return;
    if (oldestAge == null || oldestAge < ON_DEMAND_AFTER_SECONDS) return;
    refreshPrices(activeCategory, ON_DEMAND_AFTER_SECONDS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oldestAge, loading, activeCategory]);

  // Debounced, and every in-flight response is checked against the
  // query that is current when it lands. Without that, a slow response
  // for "bit" arrives after a fast one for "bitcoin" and overwrites it —
  // the results then disagree with the box the reader is looking at.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setSearchData(null); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const j = await r.json();
        setQuery(cur => {
          if (cur.trim() === q) { setSearchData(j.error ? { error: j.error } : j); setSearching(false); }
          return cur;
        });
      } catch (e) {
        setQuery(cur => { if (cur.trim() === q) { setSearchData({ error: String(e) }); setSearching(false); } return cur; });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // The home page asks for every category at once, which is only
  // affordable because ?top= trims server-side: politics alone is 930KB
  // of cards and the home page needs twelve of them.
  useEffect(() => {
    if (view !== "home") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/markets?category=all&perCategory=3");
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const body = await res.json();
        if (!cancelled) setHomeData(body);
      } catch {
        // Silent by design. The home page is a way in, not a place to
        // report an outage — every category tile still works, and the
        // tab itself surfaces a read failure properly.
        if (!cancelled) setHomeData({ pairs: [], byCategory: {} });
      }
    })();
    return () => { cancelled = true; };
  }, [view]);

  const searchMode = query.trim().length >= 2;

  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Nav */}
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "0 clamp(12px, 4vw, 24px)", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 900, margin: "0 auto", minHeight: 56, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", paddingTop: 6, paddingBottom: 6 }}>
          <button
            onClick={goHome}
            aria-label="MarketSlap home"
            style={{
              display: "flex", alignItems: "center", gap: 12, minWidth: 0,
              background: "transparent", border: "none", padding: 0,
              cursor: view === "home" ? "default" : "pointer", font: "inherit",
            }}
          >
            {/* No tile on the page. The tile was there to stop an S set
                flush against a wordmark beginning with M reading as one
                word, but the RULE below does that job now, and the mark
                carries a violet-to-teal gradient the near-black MARKET
                does not — two separations where the run-on needed one.
                What the tile added on top was weight: even as a tint it
                was a box drawn around the one element that did not need
                one.

                The FAVICON keeps its dark tile. A tab icon sits at 16px
                against browser chrome of unknown colour and needs its own
                ground; a 44px mark on a known white header does not. They
                are the same artwork with different jobs. */}
            <img
              src="/logo-mark.svg"
              alt=""
              aria-hidden="true"
              width={44}
              height={45}
              style={{ display: "block", flexShrink: 0 }}
            />
            {/* Carries the separation the tile used to. */}
            <span aria-hidden="true" style={{ width: 1, height: 28, background: T.border, flexShrink: 0 }} />
            <span style={{ fontSize: 21, fontWeight: 800, letterSpacing: "0.1em", whiteSpace: "nowrap", lineHeight: 1 }}>
              <span style={{ color: BRAND.ink }}>MARKET</span>
              <span className="ms-slap">SLAP</span>
            </span>
          </button>

          <button
            onClick={() => setMenuOpen(o => !o)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            style={{
              width: 38, height: 38, borderRadius: 8, flexShrink: 0,
              border: `1px solid ${menuOpen ? ACCENT : T.border}`,
              background: menuOpen ? `${ACCENT}12` : T.surface,
              color: menuOpen ? ACCENT : T.text,
              cursor: "pointer", fontSize: 16, lineHeight: 1,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            }}
          >
            {menuOpen ? "\u2715" : "\u2630"}
          </button>
        </div>

        {menuOpen && (
          <div style={{ maxWidth: 900, margin: "0 auto", paddingBottom: 14 }}>
            <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, background: T.surface, overflow: "hidden" }}>
              <MenuItem label="Home" onClick={() => { goHome(); setMenuOpen(false); }} active={view === "home"} />
              {Object.entries(CATEGORIES).map(([key, cat]) => (
                <MenuItem
                  key={key}
                  label={`${cat.icon}  ${cat.label}`}
                  onClick={() => { goCategory(key); setMenuOpen(false); }}
                  active={view === "category" && activeCategory === key}
                />
              ))}
              {/* Labelled, not linked. A menu item that navigates nowhere
                  reads as a broken site; one that says "soon" reads as a
                  roadmap, and costs nothing to leave in place until the
                  page behind it exists. */}
              {["About", "Contact", "Pricing", "FAQ", "Sign in"].map(label => (
                <MenuItem key={label} label={label} soon />
              ))}
            </div>
          </div>
        )}

        {/* Inside the sticky nav rather than a sibling with a top offset:
            the nav wraps at narrow widths, so any hard-coded offset would
            be wrong on exactly the screens this matters most on. */}
        {pinnedCard && <PinnedStrip market={pinnedCard} onClear={() => setPinnedId(null)} />}
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "28px clamp(12px, 4vw, 24px)" }}>
        {/* SEARCH IS ABOVE EVERYTHING, ON EVERY VIEW.
            It used to live inside the category branch, so the home
            page — the first thing anyone sees — had no way to ask
            about a specific market. The grid answers "what did you
            find"; the box answers "what about this one", which is the
            question a reader arrives with, and the catalogue is ~86,000
            markets against the ~960 that are paired. A market with no
            counterpart still comes back, and "only on Kalshi" is an
            answer rather than a failure. */}


        {/* Searching replaces whatever view you were on, home or tab.
            Leaving the home cards under the results would answer a
            question nobody asked, below the answer to the one they
            did. Clearing the box puts the view back. */}
        {searchMode ? (
          <>
          {/* The box has to survive the view it replaced, or typing
              makes the thing you are typing into disappear. */}
          <SearchBox query={query} setQuery={setQuery} active marginBottom={18} />
          <div style={{ marginBottom: 28 }}>
            {searching && !searchData && (
              <div style={{ color: T.muted, fontSize: 13, padding: "20px 0" }}>Searching…</div>
            )}
            {searchData && searchData.error && (
              <div style={{ color: T.arb, fontSize: 13, padding: "20px 0" }}>Search failed: {searchData.error}</div>
            )}
            {searchData && !searchData.error && (
              <>
                <div style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>
                  {searchData.counts.total === 0 ? (
                    <>No markets matching “{searchData.query}”.</>
                  ) : (
                    <>
                      <strong style={{ color: T.text }}>{searchData.counts.total}</strong>{" "}
                      {searchData.counts.total === 1 ? "market" : "markets"} ·{" "}
                      <strong style={{ color: ACCENT }}>{searchData.counts.matched}</strong> quoted on more
                      than one venue
                      {searchData.counts.returned < searchData.counts.total && <> · showing {searchData.counts.returned}</>}
                    </>
                  )}
                </div>
                <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(min(340px, 100%), 1fr))" }}>
                  {searchData.results.map(r => <SearchResult key={`${r.kind}:${r.market.id}`} r={r} />)}
                </div>
                {searchData.counts.total > 0 && (
                  <p style={{ marginTop: 14, fontSize: 11, color: T.muted }}>
                    Prices are the last quotes we read. Cost to own both sides, fees and any
                    arbitrage are worked out on the category tabs, where the books are priced
                    properly — a midpoint gap is not an edge.
                  </p>
                )}
              </>
            )}
          </div>
          </>
        ) : view === "home" ? (
          <HomeView
            data={homeData}
            onCategory={goCategory}
            query={query}
            setQuery={setQuery}
            searchMode={searchMode}
          />
        ) : (
        <>
        <SearchBox query={query} setQuery={setQuery} active={searchMode} marginBottom={18} />

        {/* Category tabs */}
        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          {Object.entries(CATEGORIES).map(([key, cat]) => (
            <button
              key={key}
              /* The venue choice survives a category switch. Resetting it
                 silently re-showed .com markets the reader had just
                 chosen to hide. */
              onClick={() => goCategory(key)}
              style={{
                padding: "8px 16px", borderRadius: 99, fontSize: 13, fontWeight: 600,
                cursor: "pointer", border: `1px solid ${activeCategory === key ? ACCENT : T.border}`,
                background: activeCategory === key ? `${ACCENT}12` : T.surface,
                color: activeCategory === key ? ACCENT : T.muted, transition: "all 0.15s",
                display: "flex", alignItems: "center", gap: 6,
                opacity: cat.supported ? 1 : 0.5,
              }}
            >
              <span>{cat.icon}</span> {cat.label}
            </button>
          ))}
        </div>

        {/* Sports is four leagues sharing one tab, and "39 MLB cards and
            25 NFL ones" is two questions in one list. Rendered only when
            there is a choice to make: one league means the row would be
            a control with a single option. */}
        {!searchMode && activeCategory === "sports" && leaguesPresent.length > 1 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
            {[{ key: "all", label: "All" },
              ...leaguesPresent.map(l => ({ key: l, label: LEAGUE_LABEL[l] || l.toUpperCase() }))
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setLeague(key)}
                style={{
                  padding: "5px 12px", borderRadius: 99, fontSize: 12,
                  fontWeight: league === key ? 700 : 500, cursor: "pointer",
                  border: `1px solid ${league === key ? ACCENT : T.border}`,
                  background: league === key ? `${ACCENT}12` : T.surface,
                  color: league === key ? ACCENT : T.muted, transition: "all 0.15s",
                }}
              >
                {label}
                {key !== "all" && (
                  <span style={{ fontWeight: 400, opacity: 0.7 }}>
                    {" "}{byVenue.filter(m => m.category === key).length}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* The browse view. Search replaces it rather than pushing it
            down the page: results and an unrelated grid of pairs on
            screen together is two answers to one question. */}
        {!searchMode && (
        <>
        {/* Sort controls */}
        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            style={{ padding: "10px 14px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13, color: T.text, background: T.surface, cursor: "pointer", outline: "none" }}
          >
            <option value="trending">Sort: Trending</option>
            <option value="arb">Sort: Biggest edge</option>
            <option value="cost">Sort: Cheapest to own both sides</option>
            <option value="spread">Sort: Biggest mid gap</option>
            <option value="volume">Sort: Most volume</option>
            <option value="similarity">Sort: Best match</option>
          </select>
          {/* Always rendered, never conditionally. Hiding it when only
              one venue had pairs stranded the reader: pick "US" on
              sports, switch to politics, and the control vanished while
              the filter kept applying — an empty tab with no way out.
              A segmented control also states the current venue at a
              glance, which a dropdown only does once you read it. */}
          {/* A filter, not just a badge. The arb count was already on the
              page; scrolling a 373-card politics tab to find four of
              them was the reader's job. Disabled rather than hidden at
              zero, so the control does not appear and vanish as prices
              move. */}
          <button
            onClick={() => setArbOnly(v => !v)}
            disabled={arbCount === 0 && !arbOnly}
            title={arbCount === 0 ? "No pair on this tab currently costs less than $1.00 including fees" : "Show only pairs that cost less than $1.00 to own both sides"}
            style={{
              padding: "10px 14px", fontSize: 13, fontWeight: arbOnly ? 700 : 500,
              borderRadius: 8, flexShrink: 0,
              border: `1px solid ${arbOnly ? T.arb : T.border}`,
              background: arbOnly ? `${T.arb}18` : T.surface,
              color: arbCount === 0 && !arbOnly ? T.muted : (arbOnly ? T.arb : T.text),
              cursor: arbCount === 0 && !arbOnly ? "not-allowed" : "pointer",
              opacity: arbCount === 0 && !arbOnly ? 0.55 : 1,
              transition: "all 0.15s",
            }}
          >
            ⚡ Arb only <span style={{ fontWeight: 400, opacity: 0.75 }}>{arbCount}</span>
          </button>

          <div style={{ display: "flex", border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", background: T.surface, flexShrink: 0 }}>
            {[
              { key: "us",     label: "US",     n: venueCounts.us || 0 },
              { key: "global", label: "Global", n: venueCounts.global || 0 },
              { key: "all",    label: "Both",   n: markets.length },
            ].map(({ key, label, n }, i) => (
              <button
                key={key}
                onClick={() => setVenue(key)}
                title={
                  key === "us" ? "Polymarket US — the exchange a US account can trade"
                  : key === "global" ? "polymarket.com — a separate exchange, not tradable from a US account"
                  : "Both exchanges, side by side"
                }
                style={{
                  padding: "10px 14px", fontSize: 13, fontWeight: venue === key ? 700 : 500,
                  cursor: "pointer", border: "none",
                  borderLeft: i === 0 ? "none" : `1px solid ${T.border}`,
                  background: venue === key ? `${ACCENT}14` : "transparent",
                  color: venue === key ? ACCENT : T.muted,
                  transition: "all 0.15s",
                }}
              >
                {label} <span style={{ fontWeight: 400, opacity: 0.75 }}>{n}</span>
              </button>
            ))}
          </div>
          {/* Reads the venues, rather than re-reading the database.
              Labelled "Refresh", it previously fetched the same stored
              prices again and returned instantly — which looks like a
              working refresh button and is not one. `ifStale=0` means
              this always does the work, because a person who clicked it
              is asking for exactly that. */}
          <button
            onClick={() => refreshPrices(activeCategory, 0)}
            disabled={refreshing}
            style={{
              padding: "10px 16px", border: `1px solid ${T.border}`, borderRadius: 8,
              fontSize: 13, color: T.muted, background: T.surface,
              cursor: refreshing ? "default" : "pointer", opacity: refreshing ? 0.6 : 1,
            }}
          >
            {refreshing ? "↻ Reading books…" : "↻ Refresh prices"}
          </button>
        </div>

        {/* The fact the venue filter exists for, stated once. Without it
            the control asks the reader to choose between two things the
            page never names. */}
        <p style={{ margin: "-8px 0 20px", fontSize: 11, color: T.muted, lineHeight: 1.5 }}>
          Polymarket US and polymarket.com are <strong>separate exchanges</strong> with
          different books and different prices. A US account can only trade Polymarket US.
        </p>

        {/* Stats bar */}
        {/* Stats describe what is on screen. Leaving them on the full
            set would report a spread and a volume for pairs the venue
            filter is hiding. */}
        {!loading && visible.length > 0 && (
          <div style={{ display: "flex", gap: 24, marginBottom: 24, padding: "14px 18px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, flexWrap: "wrap" }}>
            {[
              { label: "Markets matched", value: visible.length },
              { label: "Arb signals", value: arbCount, color: T.arb },
              { label: "Avg spread", value: visible.length ? `${Math.round(visible.reduce((s, m) => s + widestSpread(m), 0) / visible.length * 100)}pt` : "—" },
              { label: "Kalshi contracts", value: `${compact(visible.reduce((s, m) => s + kalshiContracts(m), 0))}` },
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
            <strong>{CATEGORIES[activeCategory].label} coming soon</strong> — we're working on adding this category.
          </div>
        )}

        {needsEmbed && !loading && (
          <div style={{ padding: "24px", background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10, color: "#1E40AF", fontSize: 14 }}>
            <strong>No matched markets yet.</strong> The embedding engine needs to run first to match markets across platforms.
            <br /><br />
            <a href="/api/embed" target="_blank" rel="noopener noreferrer"
              style={{ padding: "8px 16px", background: ACCENT, color: "#fff", borderRadius: 6, textDecoration: "none", fontSize: 13, fontWeight: 600 }}>
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
            {venue !== "all" && markets.length > 0 ? (
              /* The default is US-only, so this is the state economics,
                 crypto and politics land in — Kalshi and Polymarket US
                 barely overlap outside sports. An empty tab with no
                 explanation reads as a broken site, and silently
                 showing .com instead would hand the reader prices they
                 cannot trade and links that go to the wrong exchange.
                 So: say what is missing, say what exists, and make
                 taking the other venue one deliberate click. */
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                <div style={{ fontSize: 15, color: T.text, fontWeight: 600 }}>
                  Nothing on {venue === "us" ? "Polymarket US" : "Polymarket global"} for{" "}
                  {CATEGORIES[activeCategory].label.toLowerCase()} yet
                </div>
                <div style={{ fontSize: 13, color: T.muted, maxWidth: 440, lineHeight: 1.5 }}>
                  {venue === "us"
                    ? `Kalshi and Polymarket US list almost the same games, but barely the same ${CATEGORIES[activeCategory].label.toLowerCase()} markets. ${markets.length} ${markets.length === 1 ? "pair exists" : "pairs exist"} on polymarket.com — a separate exchange a US account cannot trade.`
                    : `${markets.length} ${markets.length === 1 ? "pair is" : "pairs are"} listed on Polymarket US.`}
                </div>
                <button
                  onClick={() => setVenue(venue === "us" ? "global" : "us")}
                  style={{
                    padding: "9px 16px", border: `1px solid ${ACCENT}`, borderRadius: 8,
                    background: `${ACCENT}12`, color: ACCENT, cursor: "pointer",
                    fontSize: 13, fontWeight: 600,
                  }}
                >
                  {venue === "us"
                    ? `Show polymarket.com anyway (${markets.length})`
                    : `Show Polymarket US (${markets.length})`}
                </button>
              </div>
            ) : hidden && hidden.total > 0 ? (
              <>
                No {CATEGORIES[activeCategory].label.toLowerCase()} pairs are tradable right now —{" "}
                {hiddenReason(hidden)}.
              </>
            ) : (
              <>No overlapping {CATEGORIES[activeCategory].label.toLowerCase()} markets found right now.</>
            )}
          </div>
        )}

        {!loading && !error && !unsupported && sorted.length > 0 && (
          <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fill, minmax(min(380px, 100%), 1fr))" }}>
            {/* pairId, not id: `id` is the Kalshi market, and one Kalshi
                market now yields two pairs (one per Polymarket venue).
                Keying on it gave both cards the same key, so React reused
                stale children and the list only looked right after a
                manual refresh — while the stat row, being plain numbers,
                updated instantly. */}
            {sorted.map(m => <MarketCard key={m.id} market={m} pinned={pinnedId === m.id} onPin={setPinnedId} />)}
          </div>
        )}

        {/* A non-empty tab hides pairs too, and silently. Six shown
            beside two suppressed long shots is a different picture from
            six being everything there is, and only one of them explains
            why the number is small. */}
        {!loading && !error && sorted.length > 0 && hiddenReason(hidden) && (
          <p style={{ marginTop: 14, fontSize: 11, color: T.muted, textAlign: "center" }}>
            Not shown: {hiddenReason(hidden)}. Pairs are only listed once both sides
            are confirmed to resolve on the same number.
          </p>
        )}
        </>
        )}

        {/* Legend */}
        <div style={{ marginTop: 32, padding: "14px 18px", border: `1px solid ${T.border}`, borderRadius: 10, display: "flex", gap: 20, flexWrap: "wrap", fontSize: 11, color: T.muted }}>
          {/* No venue swatches. Venue is not colour-coded any more — the
              bars share one fill and the row label names the exchange —
              so a coloured square beside "Kalshi" would advertise an
              encoding the page does not use, which is worse than no
              legend at all. What IS colour-coded stays listed below. */}
          <span><span style={{ color: T.arb, fontWeight: 700 }}>⚡</span> Arb = both legs cost &lt; $1.00 including fees</span>
          {/* The page re-polls every 60s; the PRICES behind it come from
              a scheduled job that GitHub throttles to somewhere between
              45 minutes and 3.5 hours. Saying only the first invites the
              reader to assume the second. */}
          <span>Page reloads every 60s · prices from the last scheduled venue read</span>
        </div>
        </>
        )}
      </div>
    </div>
  );
}