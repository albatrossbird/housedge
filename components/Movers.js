// "Today on the markets": the biggest moves and the most money traded
// over about a day, across Kalshi, Polymarket US and polymarket.com.
//
// Free, on the home page, read from /api/movers (written every 15
// minutes on the box by scripts/movers.mjs). Drawn in the Pro board's
// look: pill chips, a segmented control, 18px rows with the number on
// the left and the venue's price as a tile on the right.
//
// What it must admit, in the footnote: a move is about a day, money is
// contracts x price on two of the three venues, and Polymarket US needs
// a day of our own snapshots before it has a move or a volume at all.
import { useEffect, useState } from "react";

export const VENUE_LABEL = { kalshi: "Kalshi", polymarket_us: "Poly US", polymarket: "Poly Global" };
const VENUE_VAR = { kalshi: "var(--kalshi)", polymarket_us: "var(--polymarket)", polymarket: "var(--polyglobal)" };
const CATS = [["all", "All"], ["sports", "Sports"], ["politics", "Politics"], ["economics", "Economics"], ["crypto", "Crypto"], ["culture", "Culture & more"]];

const CSS = `
.mv { display: grid; gap: 12px; margin-bottom: 30px; }
.mv-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mv-h { font: 800 22px/1.15 var(--display); letter-spacing: -.02em; margin: 0; color: var(--fg); }
.mv-upd { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.mv-upd::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--good); }
.mv-upd.old { color: var(--warn); } .mv-upd.old::before { background: var(--warn); }
.mv-seg { display: inline-flex; background: var(--raised); border-radius: 12px; padding: 3px; gap: 2px; justify-self: start; }
.mv-seg button { border: 0; background: transparent; border-radius: 9px; padding: 7px 14px; font: 650 14px/1.2 var(--ui); color: var(--muted); cursor: pointer; }
.mv-seg button[aria-pressed="true"] { background: var(--surface); color: var(--fg); box-shadow: var(--shadow); }
.mv-chips { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; margin-inline: -16px; padding: 1px 16px; }
.mv-chips::-webkit-scrollbar { display: none; }
.mv-chip { flex: none; display: inline-flex; align-items: center; gap: 7px; min-height: 36px; padding: 0 14px; border-radius: 999px; background: var(--raised); border: 1.5px solid transparent; font: 650 14px/1 var(--ui); color: var(--fg); white-space: nowrap; cursor: pointer; }
.mv-chip[aria-pressed="true"] { background: var(--surface); border-color: var(--fg); }
.mv-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: 10px; }
.mv-row { display: grid; grid-template-columns: 70px minmax(0, 1fr) auto; gap: 12px; align-items: center; background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: 12px 12px 12px 6px; box-shadow: var(--shadow); }
.mv-num { justify-self: center; text-align: center; font: 800 22px/1 var(--display); letter-spacing: -.02em; font-variant-numeric: tabular-nums; color: var(--fg); }
.mv-num small { display: block; margin-top: 3px; font: 700 10.5px/1 var(--ui); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.mv-num.up { color: var(--good); } .mv-num.down { color: var(--bad); }
.mv-main { min-width: 0; display: grid; gap: 4px; }
.mv-t { font: 650 15px/1.25 var(--ui); color: var(--fg); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.mv-o { color: var(--warn); font-weight: 600; font-size: 14px; line-height: 1.25; overflow-wrap: anywhere; }
.mv-meta { display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap; color: var(--muted); font-size: 12.5px; }
.mv-v { display: inline-flex; align-items: center; gap: 6px; font-weight: 650; color: var(--fg); }
.mv-v::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--vc); }
.mv-also a { color: var(--muted); text-decoration: none; }
.mv-also a:hover { color: var(--accent); }
.mv-also b { font-weight: 650; color: var(--fg); font-variant-numeric: tabular-nums; }
.mv-tile { display: grid; justify-items: center; gap: 1px; min-width: 70px; padding: 8px 10px; border-radius: 14px; background: var(--raised); color: var(--fg); text-decoration: none; border: 1px solid transparent; }
.mv-tile:hover { border-color: var(--accent); }
.mv-tile .p { font: 750 17px/1.15 var(--display); font-variant-numeric: tabular-nums; }
.mv-tile .s { font-weight: 700; font-size: 12px; color: var(--accent); }
.mv-empty { margin: 0; padding: 24px 18px; color: var(--muted); text-align: center; background: var(--surface); border: 1px dashed var(--line); border-radius: 18px; font-size: 14px; }
.mv-foot { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
`;

const pts = v => { const n = Math.round(v * 100); return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0"; };
const pct = v => `${Math.round(v * 100)}%`;
export function usd(v) {
  if (v == null) return "—";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
  return `$${Math.round(v)}`;
}
function ago(sec) {
  if (sec == null) return null;
  if (sec < 90) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function Venue({ v }) {
  return <span className="mv-v" style={{ "--vc": VENUE_VAR[v] }}>{VENUE_LABEL[v] || v}</span>;
}

function Row({ r, list }) {
  const move = list === "moves";
  return (
    <div className="mv-row">
      <div className={`mv-num${move ? (r.change > 0 ? " up" : " down") : ""}`}>
        {move ? pts(r.change) : usd(r.volumeUsd)}
        <small>{move ? "pts" : "traded"}</small>
      </div>
      <div className="mv-main">
        <div className="mv-t">{r.title}</div>
        {r.outcome && <div className="mv-o">{r.outcome}</div>}
        <div className="mv-meta">
          <Venue v={r.venue} />
          {move ? <span>was {pct(r.prev)}</span> : r.change != null && <span>{pts(r.change)} pts today</span>}
          {move && r.volumeUsd != null && <span>{usd(r.volumeUsd)} traded</span>}
        </div>
        {r.also?.length > 0 && (
          <div className="mv-meta mv-also">
            <span>Also:</span>
            {r.also.map(a => (
              <a key={a.venue} href={a.url || "#"} target="_blank" rel="noopener noreferrer nofollow">
                {VENUE_LABEL[a.venue]} <b>{pct(a.price)}</b>{a.change != null ? ` (${pts(a.change)})` : ""}
              </a>
            ))}
          </div>
        )}
      </div>
      <a className="mv-tile" href={r.url || "#"} target="_blank" rel="noopener noreferrer nofollow" aria-label={`Open on ${VENUE_LABEL[r.venue]}`}>
        <span className="p">{pct(r.price)}</span>
        <span className="s">Open ↗</span>
      </a>
    </div>
  );
}

export default function Movers() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [list, setList] = useState("moves");
  const [cat, setCat] = useState("all");

  useEffect(() => {
    let cancelled = false;
    const load = () => fetch("/api/movers").then(async r => {
      const j = await r.json().catch(() => ({}));
      if (cancelled) return;
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setData(j); setError(null);
    }).catch(e => { if (!cancelled) setError(e.message); });
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Not set up yet (no table, no job): say nothing rather than show a
  // broken section on the front door.
  if (error && /not configured|HTTP 404|HTTP 401/.test(error)) return null;

  const ages = data ? Object.values(data.venues || {}).map(v => v.ageSeconds).filter(v => v != null) : [];
  const age = ages.length ? Math.max(...ages) : null;
  const rows = data?.[list]?.[cat] || [];
  const usWarm = data && (data.venues?.polymarket_us?.withDayAgo ?? 0) === 0;

  return (
    <section className="mv" aria-label="Today on the markets">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="mv-head">
        <h2 className="mv-h">Today on the markets</h2>
        {age != null && <span className={`mv-upd${age > 45 * 60 ? " old" : ""}`}>Updated {ago(age)}</span>}
      </div>
      <div className="mv-seg" role="group" aria-label="List">
        <button type="button" aria-pressed={list === "moves"} onClick={() => setList("moves")}>Biggest moves</button>
        <button type="button" aria-pressed={list === "traded"} onClick={() => setList("traded")}>Most traded</button>
      </div>
      <div className="mv-chips" role="group" aria-label="Category">
        {CATS.map(([k, l]) => (
          <button key={k} type="button" className="mv-chip" aria-pressed={cat === k} onClick={() => setCat(k)}>{l}</button>
        ))}
      </div>
      {!data && !error && <p className="mv-empty">Loading today's markets…</p>}
      {error && <p className="mv-empty">Today's moves could not be read ({error}). They refresh every few minutes.</p>}
      {data && rows.length === 0 && (
        <p className="mv-empty">{list === "moves" ? "Nothing here has moved 3 points or more today with $5,000 traded behind it." : "Nothing here has traded $1,000 today."}</p>
      )}
      {rows.length > 0 && <div className="mv-list">{rows.map((r, i) => <Row key={`${r.venue}${i}${r.title}`} r={r} list={list} />)}</div>}
      {data && (
        <p className="mv-foot">
          Moves and money are over about the last day, one row per question, and a move needs $5,000 traded behind it. Money is dollars on Poly Global and contracts × price
          on Kalshi and Poly US. Moves skip markets that end within a day and prices now under 3% or over 97%: a game in progress or a
          number released this morning is a question being answered, not opinion changing.{usWarm ? " Poly US publishes no price history, so its moves and money appear once we have a day of our own readings." : " Poly US money is shown for the markets we read it on, since that venue gives volume one market at a time."}
          {" "}Information only, not trading advice.
        </p>
      )}
    </section>
  );
}
