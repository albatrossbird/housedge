// Sports: prices with an edge over the sportsbooks, and arbitrage pairs.
//
// The scanner (its own server) compares every Kalshi, Polymarket US, Novig
// and ProphetX price, and the sportsbooks' own, against a fair price made
// from the sportsbooks' consensus, after each venue's fee. This page shows
// its results, read through /api/sports-board every minute.
//
// What the page must admit, from the scanner's own research:
//   - picks have won ~2 points LESS than the consensus said (adverse
//     selection, 9,355 settled bets), so an EV under ~2% is no edge;
//   - each flag is a measured reason for doubt (longshots, thin or
//     disagreeing books, stale or small quotes), shown, never hidden;
//   - the scan is up to 5 minutes old before a price is read, so the page
//     says how old, and goes amber when the scanner stops updating.
//
// Accounts (ACCOUNTS_MODE, lib/auth/config.js): a signed-in reader reads
// /api/sports-board?tier=member, cut to their plan on the server; everyone
// else reads the public URL. What a plan does not unlock arrives as
// `locked` counts only, never as the prices themselves.
import { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import { venueName, sportName } from "../lib/sportsBoard.js";

const ACCENT = "#5641D2";
const T = {
  bg: "#F7F8FA", surface: "#FFFFFF", border: "#E4E7ED",
  text: "#0F1923", muted: "#6B7280", yes: "#059669", no: "#DC2626", arb: "#D97706",
};
const FLAG_TEXT = {
  longshot: "Longshot: fair under 25%. Longshots on this board have won far less than priced.",
  thin: "Thin: fewer than 4 sportsbooks in the fair price.",
  dispersed: "Dispersed: the sportsbooks disagree by more than 8 points.",
  stale: "Stale: this quote is over 2 minutes older than the scan.",
  small: "Small: under 10 contracts or $10 at this price.",
  "power-only": "Positive only under one way of removing the books' margin, not the other.",
};
const MIN_EVS = [0, 0.02, 0.05];

const pct = (v, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
const odds = am => (am == null ? "—" : am > 0 ? `+${Math.round(am)}` : `${Math.round(am)}`);
const money = v => (v == null ? "—" : `$${v.toFixed(2)}`);
function ago(sec) {
  if (sec == null) return "";
  if (sec < 90) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  return `${Math.round(sec / 3600)}h ago`;
}
function when(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  if (t < Date.now()) return "Live";
  return new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      border: `1px solid ${active ? ACCENT : T.border}`, background: active ? `${ACCENT}10` : T.surface,
      color: active ? ACCENT : T.text, borderRadius: 99, padding: "5px 12px", fontSize: 13, cursor: "pointer", fontFamily: "inherit",
    }}>{children}</button>
  );
}
function Select({ value, onChange, options, label }) {
  return (
    <label style={{ fontSize: 13, color: T.muted, display: "inline-flex", alignItems: "center", gap: 6 }}>
      {label}
      <select value={value} onChange={e => onChange(e.target.value)} style={{
        border: `1px solid ${T.border}`, borderRadius: 6, background: T.surface, color: T.text, padding: "4px 6px", fontSize: 13, fontFamily: "inherit",
      }}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
function OpenLink({ href }) {
  if (!href) return null;
  return <a href={href} target="_blank" rel="noopener noreferrer nofollow" style={{ color: ACCENT, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Open ↗</a>;
}
const signLink = { color: ACCENT, fontSize: 14, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" };

const sportCount = (bySport, sport) => (sport === "all" ? Object.values(bySport ?? {}).reduce((a, b) => a + b, 0) : bySport?.[sport] ?? 0);

function LockedCard({ title, detail, signedIn }) {
  return (
    <div style={{ background: `${ACCENT}08`, border: `1px dashed ${ACCENT}66`, borderRadius: 10, padding: "16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span aria-hidden="true" style={{ fontSize: 18 }}>🔒</span>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 13, color: T.muted, marginTop: 2 }}>{detail}</div>
      </div>
      {signedIn ? <span style={{ fontSize: 13, color: T.muted }}>Paid plans launch soon</span>
        : <a href="/signup?next=/sports" style={signLink}>Sign up free →</a>}
    </div>
  );
}

const card = { background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px" };

function EvCard({ r }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, color: T.muted }}>
        <span>{sportName(r.sport)} · {r.game}</span>
        <span style={{ whiteSpace: "nowrap" }}>{when(r.commence)}</span>
      </div>
      <div style={{ marginTop: 6, fontSize: 15, fontWeight: 600, color: T.text }}>{r.label}</div>
      <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 18px", fontSize: 13, color: T.text }}>
        <span><span style={{ color: T.muted }}>{venueName(r.venue)}</span> <b>{odds(r.am)}</b> <span style={{ color: T.muted }}>({pct(r.price, 0)})</span></span>
        <span><span style={{ color: T.muted }}>Fair</span> {pct(r.p, 0)}</span>
        <span style={{ color: r.evNet >= 0.02 ? T.yes : T.text, fontWeight: 700 }}>EV {r.evNet >= 0 ? "+" : ""}{pct(r.evNet)} <span style={{ fontWeight: 400, color: T.muted }}>after fees</span></span>
        {r.limit != null && <span style={{ color: T.muted }}>Up to {money(r.limit)}</span>}
        <span style={{ marginLeft: "auto" }}><OpenLink href={r.link} /></span>
      </div>
      {r.flags?.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {r.flags.map(f => <span key={f} title={FLAG_TEXT[f] ?? f} style={{ fontSize: 11, color: T.arb, background: `${T.arb}12`, borderRadius: 99, padding: "2px 8px" }}>{f}</span>)}
        </div>
      )}
    </div>
  );
}

function ArbCard({ a }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, color: T.muted }}>
        <span>{sportName(a.sport)} · {a.game}</span>
        <span style={{ whiteSpace: "nowrap" }}>{when(a.commence)}</span>
      </div>
      <div style={{ marginTop: 6, display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: T.yes }}>+{pct(a.ret, 2)} return</span>
        <span style={{ fontSize: 12, color: T.muted }}>both sides, after fees</span>
        {a.maxProfit != null && <span style={{ fontSize: 12, color: T.muted }}>· at most {money(a.maxProfit)} on {money(a.maxStake)}</span>}
      </div>
      <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
        {a.legs.map((l, i) => (
          <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 10, fontSize: 13, flexWrap: "wrap" }}>
            <span style={{ width: 110, color: T.muted, flexShrink: 0 }}>{venueName(l.venue)}</span>
            <span style={{ flex: 1, minWidth: 120, color: T.text }}>{l.label}</span>
            <b>{odds(l.am)}</b>
            {l.limit != null && <span style={{ color: T.muted }}>up to {money(l.limit)}</span>}
            <OpenLink href={l.link} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Sports() {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("ev");
  const [sport, setSport] = useState("all");
  const [venue, setVenue] = useState("all");
  const [minEv, setMinEv] = useState(0.02);
  const [hideFlagged, setHideFlagged] = useState(false);
  const [shown, setShown] = useState(60);
  const [now, setNow] = useState(Date.now());
  const [me, setMe] = useState(null);

  useEffect(() => { fetch("/api/me").then(r => r.json()).then(setMe).catch(() => setMe({ enabled: false })); }, []);

  useEffect(() => {
    if (!me) return undefined;
    let cancelled = false;
    const url = me.user ? "/api/sports-board?tier=member" : "/api/sports-board";
    async function load() {
      try {
        const r = await fetch(url);
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
        setBoard(j); setError(null);
      } catch (e) { if (!cancelled) setError(e.message); }
    }
    load();
    const id = setInterval(() => { load(); setNow(Date.now()); }, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, [me]);

  const ageSec = board ? Math.max(0, Math.round((now - Date.parse(board.scannedAt)) / 1000)) : null;
  const sports = useMemo(() => [...new Set([
    ...[...(board?.rows ?? []), ...(board?.arbs ?? [])].map(x => x.sport),
    ...Object.keys(board?.locked?.ev?.bySport ?? {}), ...Object.keys(board?.locked?.arb?.bySport ?? {}),
  ].filter(s => s && s !== "other"))].sort(), [board]);
  const venues = useMemo(() => [...new Set((board?.rows ?? []).map(r => r.venue).filter(Boolean))].sort((a, b) => venueName(a).localeCompare(venueName(b))), [board]);
  const rows = useMemo(() => (board?.rows ?? [])
    .filter(r => (sport === "all" || r.sport === sport) && (venue === "all" || r.venue === venue) && (r.evNet ?? -1) >= minEv && (!hideFlagged || !r.flags?.length))
    .sort((a, b) => b.evNet - a.evNet), [board, sport, venue, minEv, hideFlagged]);
  const arbs = useMemo(() => (board?.arbs ?? [])
    .filter(a => (sport === "all" || a.sport === sport) && (venue === "all" || a.legs.some(l => l.venue === venue)))
    .sort((a, b) => b.ret - a.ret), [board, sport, venue]);
  const list = tab === "ev" ? rows : arbs;
  const locked = board?.locked ?? null;
  const lockedEv = locked?.ev ? sportCount(locked.ev.bySport, sport) : 0;
  const lockedArb = locked?.arb ? sportCount(locked.arb.bySport, sport) : 0;

  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "'Inter', system-ui, sans-serif", color: T.text }}>
      <Head>
        <title>Sports edges · MarketSlap</title>
        <meta name="description" content="Sports prices that beat the sportsbooks' consensus after fees, and arbitrage pairs across Kalshi, Polymarket US, Novig, ProphetX and the sportsbooks." />
      </Head>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "0 clamp(12px, 4vw, 24px)" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", minHeight: 56, display: "flex", alignItems: "center", gap: 12 }}>
          <a href="/" aria-label="MarketSlap home" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
            <img src="/logo-mark.svg" alt="" aria-hidden="true" width={32} height={33} style={{ display: "block" }} />
            <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: "0.1em", color: T.text }}>MARKET<span className="ms-slap">SLAP</span></span>
          </a>
          <span style={{ width: 1, height: 22, background: T.border }} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>Sports</span>
          {me?.enabled && (
            <span style={{ marginLeft: "auto" }}>
              {me.user ? <a href="/account" style={{ ...signLink, color: T.muted, fontWeight: 500 }}>Account</a> : <a href="/signup?next=/sports" style={{ ...signLink, color: "#fff", background: ACCENT, borderRadius: 8, padding: "7px 14px" }}>Sign up</a>}
            </span>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "20px clamp(12px, 4vw, 24px) 32px" }}>
        <h1 style={{ fontSize: 22, margin: "0 0 6px" }}>Prices that beat the books</h1>
        <p style={{ margin: 0, fontSize: 14, color: T.muted, lineHeight: 1.5 }}>
          Each price is compared with a fair price built from the sportsbooks' consensus, after the venue's fee.
          Picks like these have won about 2 points less often than the consensus said, so treat anything under +2% as no edge.
        </p>
        <div style={{ marginTop: 10, fontSize: 12, color: ageSec != null && ageSec > 900 ? T.arb : T.muted }}>
          {board ? `Scanned ${ago(ageSec)}${ageSec > 900 ? " — the scanner may be behind" : ""}` : error ? "" : "Loading…"}
        </div>
        {error && (/not configured/.test(error)
          ? <div style={{ ...card, marginTop: 12, color: T.muted, fontSize: 14 }}>The sports board is not connected yet.</div>
          : <div style={{ ...card, marginTop: 12, borderColor: `${T.no}55`, color: T.no, fontSize: 13 }}>The board could not be read ({error}). It refreshes every minute.</div>)}

        <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Chip active={tab === "ev"} onClick={() => { setTab("ev"); setShown(60); }}>+EV prices{board ? ` (${rows.length})` : ""}</Chip>
          <Chip active={tab === "arb"} onClick={() => { setTab("arb"); setShown(60); }}>Arbitrage{board ? ` (${locked?.arb ? lockedArb : arbs.length})` : ""}</Chip>
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: "8px 16px", flexWrap: "wrap", alignItems: "center" }}>
          <Select label="Sport" value={sport} onChange={setSport} options={[["all", "All"], ...sports.map(s => [s, sportName(s)])]} />
          <Select label="Venue" value={venue} onChange={setVenue} options={[["all", "All"], ...venues.map(v => [v, venueName(v)])]} />
          {tab === "ev" && (
            <>
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13, color: T.muted }}>
                EV at least {MIN_EVS.map(m => <Chip key={m} active={minEv === m} onClick={() => setMinEv(m)}>{m === 0 ? "0%" : `+${m * 100}%`}</Chip>)}
              </span>
              <label style={{ fontSize: 13, color: T.muted, display: "inline-flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={hideFlagged} onChange={e => setHideFlagged(e.target.checked)} /> Hide flagged
              </label>
            </>
          )}
        </div>

        <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
          {board && list.length === 0 && !(tab === "arb" && locked?.arb) && (
            <div style={{ ...card, color: T.muted, fontSize: 14 }}>
              {tab === "ev" ? "Nothing clears this filter right now." : "No arbitrage at a bettable venue right now. They are rare and short-lived."}
            </div>
          )}
          {tab === "arb" && locked?.arb && (
            <LockedCard signedIn={!!me?.user}
              title={lockedArb ? `${lockedArb} arbitrage ${lockedArb === 1 ? "pair" : "pairs"} right now` : "No arbitrage right now"}
              detail={lockedArb ? `${Object.entries(locked.arb.bySport).filter(([s]) => sport === "all" || s === sport).map(([s, n]) => `${sportName(s)} ${n}`).join(" · ")}. Both legs, stakes and returns come with the Arbitrage plan or Sports Pro.`
                : "Arbitrage is rare and short-lived. The Arbitrage plan or Sports Pro shows every pair the moment it appears."} />
          )}
          {list.slice(0, shown).map((x, i) => tab === "ev" ? <EvCard key={i} r={x} /> : <ArbCard key={i} a={x} />)}
          {list.length > shown && (
            <button onClick={() => setShown(s => s + 60)} style={{ ...card, cursor: "pointer", color: ACCENT, fontWeight: 600, fontFamily: "inherit", fontSize: 14 }}>
              Show more ({list.length - shown} left)
            </button>
          )}
          {tab === "ev" && locked?.ev && lockedEv > 0 && (
            <LockedCard signedIn={!!me?.user}
              title={`${lockedEv} more ${lockedEv === 1 ? "price" : "prices"} at +${Math.round(locked.ev.cap * 100)}% EV or better`}
              detail={`Free shows edges under +${Math.round(locked.ev.cap * 100)}%. The +EV plan or Sports Pro shows all of them.`} />
          )}
        </div>

        <div style={{ marginTop: 24, fontSize: 11, lineHeight: 1.6, color: T.muted }}>
          <p style={{ margin: 0 }}>Information only, not betting advice. Prices move between scans, so check the venue before you bet, and only bet where it is legal for you.</p>
          <p style={{ margin: "4px 0 0" }}>MarketSlap is not affiliated with, endorsed by or operated by any venue shown here.</p>
          <p style={{ margin: "8px 0 0" }}><a href="/terms" style={{ color: "inherit" }}>Terms</a> · <a href="/privacy" style={{ color: "inherit" }}>Privacy</a></p>
        </div>
      </div>
    </div>
  );
}
