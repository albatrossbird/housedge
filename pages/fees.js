// What a Kalshi or Polymarket trade actually costs.
//
// WHY THIS IS A PAGE AND NOT A PARAGRAPH. Every number on this site
// depends on the fee curve, and the curve is not intuitive: it is
// QUADRATIC, so it peaks at 50/50 and vanishes at the extremes, and
// Kalshi rounds it up to the cent PER ORDER, so a small order pays a
// disproportionate share. Both facts change which trades are worth
// taking, and neither is visible on either venue's own interface.
//
// It imports lib/fees.js rather than restating the arithmetic. A second
// copy of the fee maths is a second place for it to drift, which is the
// lesson already recorded for the implausible-spread guard.
//
// Fee PARAMETERS are per-market and come from the venues' APIs; the
// multiplier here is an input with its default stated, never a constant
// presented as fact.
import { useState, useMemo } from "react";
import Head from "next/head";
import { kalshiTakerFee, polymarketTakerFee } from "../lib/fees";
import { walkBook } from "../lib/bookWalk";

const T = {
  bg: "#F7F8FA", surface: "#FFFFFF", border: "#E4E7ED",
  text: "#0F1923", muted: "#6B7280", yes: "#059669", no: "#DC2626", arb: "#D97706",
};

const c = (n, d = 2) => `${(n * 100).toFixed(d)}¢`;
const num = (v, fallback) => (v === "" || !isFinite(Number(v)) ? fallback : Number(v));

function Field({ label, hint, children }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: T.muted, marginTop: 4, lineHeight: 1.45 }}>{hint}</div>}
    </label>
  );
}

const inputStyle = {
  width: "100%", boxSizing: "border-box", padding: "8px 10px", fontSize: 15,
  border: `1px solid ${T.border}`, borderRadius: 6, fontFamily: "inherit", color: T.text,
};

export default function Fees() {
  const [priceStr, setPrice] = useState("0.80");
  const [sizeStr, setSize] = useState("100");
  const [multStr, setMult] = useState("1");
  const [rateStr, setRate] = useState("0.05");
  // A ladder as text, so it can be pasted straight off a book.
  const [ladderStr, setLadder] = useState("0.82 x 8\n0.83 x 150\n0.84 x 12\n0.86 x 500");

  const price = Math.min(Math.max(num(priceStr, 0.8), 0.01), 0.99);
  const size = Math.max(Math.round(num(sizeStr, 100)), 1);
  const mult = Math.max(num(multStr, 1), 0);
  const rate = Math.max(num(rateStr, 0.05), 0);

  const r = useMemo(() => {
    const kOrder = kalshiTakerFee(price, size, mult);
    const kPer = kOrder / size;
    const pOrder = polymarketTakerFee(price, size, { rate, exponent: 1 });
    return {
      kOrder, kPer, pOrder, pPer: pOrder / size,
      // Settlement is free on both venues, so a hold-to-expiry trade
      // pays the taker fee once. Breakeven is therefore just the cost.
      kBreakeven: price + kPer,
      kMaxProfit: 1 - price - kPer,
    };
  }, [price, size, mult, rate]);

  // "0.82 x 8" per line, tolerant of commas and stray whitespace,
  // because the point is to paste a book rather than fill a form.
  const ladder = useMemo(() => ladderStr.split("\n").map(line => {
    const m = /(-?[\d.]+)\s*[x@,]?\s*(-?[\d.]+)/.exec(line.trim());
    return m ? { price: Number(m[1]), size: Number(m[2]) } : null;
  }).filter(Boolean), [ladderStr]);

  const walk = useMemo(() => walkBook(ladder, size, "buy"), [ladder, size]);
  // Fees are charged on what you ACTUALLY paid, not on the touch.
  const walkFee = walk.avgPrice == null ? 0 : kalshiTakerFee(walk.avgPrice, walk.filled || 1, mult) / (walk.filled || 1);

  // The rounding penalty is LUMPY, not monotonic: it is +0.25c at 1-3
  // contracts on one fixture and exactly 0 at 4. A table beats a
  // sentence here because the shape is the point.
  const sizes = [1, 4, 10, 25, 50, 100, 250, 1000];
  const curve = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <Head>
        <title>What a prediction-market trade actually costs — MarketSlap</title>
        <meta name="description" content="Kalshi and Polymarket taker fees, per contract and per order, with the breakeven price a trade has to clear." />
      </Head>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "clamp(16px, 4vw, 32px)" }}>
        <a href="/" style={{ fontSize: 13, color: T.muted, textDecoration: "none" }}>&larr; MarketSlap</a>

        <h1 style={{ fontSize: "clamp(22px, 5vw, 30px)", margin: "14px 0 8px", lineHeight: 1.2 }}>
          What a trade actually costs
        </h1>
        <p style={{ fontSize: 14, color: T.muted, lineHeight: 1.6, maxWidth: 620, marginTop: 0 }}>
          Both venues charge <strong>takers</strong> and neither charges makers, on the same
          quadratic curve — most expensive at 50/50, near zero at the extremes. Kalshi rounds
          its fee <strong>up to the cent per order</strong>, so a small order pays a
          disproportionate share. Neither fact is shown on the venues&rsquo; own screens.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))", gap: 16, marginTop: 24 }}>
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }}>
            <Field label="Price you pay (the ask)" hint="0.01 to 0.99">
              <input style={inputStyle} inputMode="decimal" value={priceStr} onChange={e => setPrice(e.target.value)} />
            </Field>
            <Field label="Order size (contracts)" hint="Kalshi's rounding is per order, so this changes the per-contract cost.">
              <input style={inputStyle} inputMode="numeric" value={sizeStr} onChange={e => setSize(e.target.value)} />
            </Field>
            <Field label="Kalshi fee multiplier" hint="Per series, from /series/<ticker>. 1 on the 15-minute markets, 0.5 on KXMLBGAME. Defaults to 1 — a MISSING multiplier means 1, never 0.">
              <input style={inputStyle} inputMode="decimal" value={multStr} onChange={e => setMult(e.target.value)} />
            </Field>
            <Field label="Polymarket fee rate" hint="Per market, from feeSchedule.rate. 0.05 on sports. Rates changed mid-2026, so read it rather than assuming.">
              <input style={inputStyle} inputMode="decimal" value={rateStr} onChange={e => setRate(e.target.value)} />
            </Field>
          </div>

          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4, color: T.muted, marginBottom: 10 }}>KALSHI</div>
            <Row k="Fee, whole order" v={`$${r.kOrder.toFixed(2)}`} />
            <Row k="Fee per contract" v={c(r.kPer)} />
            <Row k="Cost per contract" v={c(price + r.kPer)} />
            <Row k="Breakeven win rate" v={`${(100 * r.kBreakeven).toFixed(2)}%`} strong
                 note={`You must be right more than ${(100 * r.kBreakeven).toFixed(2)}% of the time for this to pay.`} />
            <Row k="Max profit per contract" v={c(r.kMaxProfit)}
                 tone={r.kMaxProfit > 0 ? T.yes : T.no} />

            <div style={{ height: 1, background: T.border, margin: "14px 0" }} />
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4, color: T.muted, marginBottom: 10 }}>POLYMARKET</div>
            <Row k="Fee, whole order" v={`$${r.pOrder.toFixed(2)}`} />
            <Row k="Fee per contract" v={c(r.pPer)} />
            <Row k="Cost per contract" v={c(price + r.pPer)} />
          </div>
        </div>

        <Section title="The fee is a curve, not a rate"
          body="Both venues charge on p(1-p), so the same percentage fee costs very different amounts at different prices. A coin-flip market is the expensive one; a heavy favourite is nearly free to trade — and also has almost nothing to win.">
          <Table
            head={["Price", "Kalshi fee/ct", "Breakeven", "Max profit/ct"]}
            rows={curve.map(p => {
              const f = kalshiTakerFee(p, size, mult) / size;
              return [
                p.toFixed(2), c(f), `${(100 * (p + f)).toFixed(2)}%`,
                { v: c(1 - p - f), tone: 1 - p - f > 0 ? T.yes : T.no },
              ];
            })}
            highlight={curve.findIndex(p => Math.abs(p - price) < 0.026)}
          />
        </Section>

        <Section title="Small orders pay more, and not smoothly"
          body="Kalshi rounds up to the cent per ORDER, so the penalty amortises over however many contracts you actually trade. It is lumpy rather than monotonic — on some prices it is worse at 3 contracts than at 7 — which is why a test fixture that lands on a cent boundary can pass while proving nothing.">
          <Table
            head={["Contracts", "Fee, order", "Fee/ct", "vs. 1000-lot"]}
            rows={sizes.map(n => {
              const per = kalshiTakerFee(price, n, mult) / n;
              const base = kalshiTakerFee(price, 1000, mult) / 1000;
              const d = per - base;
              return [
                String(n), `$${kalshiTakerFee(price, n, mult).toFixed(2)}`, c(per),
                { v: d > 1e-9 ? `+${c(d)}` : "—", tone: d > 1e-9 ? T.arb : T.muted },
              ];
            })}
            highlight={sizes.indexOf(size)}
          />
        </Section>

        <Section title="The touch is one number; your order is not"
          body="A book showing 82c might have 8 contracts there and the next 92 at 83c. Paste a ladder (price x size, one level per line) and this walks it: what each level fills, what the whole order averages, and what you could not fill at all.">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))", gap: 16 }}>
            <div>
              <Field label="Ask ladder" hint="price x size, one level per line. Order does not matter — it is sorted.">
                <textarea
                  style={{ ...inputStyle, minHeight: 116, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13, resize: "vertical" }}
                  value={ladderStr} onChange={e => setLadder(e.target.value)} />
              </Field>
            </div>
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }}>
              <Row k="Best price (the touch)" v={walk.best == null ? "\u2014" : c(walk.best)} />
              <Row k={`Average fill, ${walk.filled} ct`} v={walk.avgPrice == null ? "\u2014" : c(walk.avgPrice)} strong />
              <Row k="Slippage vs touch" v={walk.slippage == null ? "\u2014" : `+${c(walk.slippage)}`}
                   tone={walk.slippage > 0 ? T.arb : T.muted} />
              <Row k="Fee per contract" v={c(walkFee)} />
              <Row k="All-in per contract" v={walk.avgPrice == null ? "\u2014" : c(walk.avgPrice + walkFee)} strong />
              <Row k="Depth on this side" v={`${walk.available} ct`} />
              {!walk.complete && walk.requested > 0 && (
                <div style={{ marginTop: 10, padding: "8px 10px", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 6, fontSize: 12, color: "#92400E", lineHeight: 1.5 }}>
                  <strong>{walk.shortfall} of {walk.requested} contracts could not be filled.</strong> The
                  average above covers only what the book holds — it is not the price of the order you asked for.
                </div>
              )}
            </div>
          </div>

          {walk.fills.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <Table
                head={["Level", "Price", "Fills", "Cumulative", "Running avg"]}
                rows={walk.fills.map((f, i) => {
                  const sofar = walk.fills.slice(0, i + 1);
                  const qty = sofar.reduce((a, x) => a + x.size, 0);
                  const spend = sofar.reduce((a, x) => a + x.size * x.price, 0);
                  return [String(i + 1), c(f.price), `${f.size} ct`, `${f.cumulative} ct`, c(spend / qty)];
                })}
              />
            </div>
          )}
        </Section>

        <p style={{ fontSize: 12, color: T.muted, lineHeight: 1.6, marginTop: 28, maxWidth: 620 }}>
          Settlement is free on both venues, so a hold-to-expiry trade pays the taker fee once,
          on entry. <strong>Fees are not the only cost.</strong> This says nothing about the
          spread you cross, or about whether your size is actually available at the touch —
          Kalshi publishes no depth at all on its 15-minute markets, so there a fill is an
          assumption rather than an observation. Not financial advice.
        </p>
      </div>
    </div>
  );
}

function Row({ k, v, note, strong, tone }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
        <span style={{ fontSize: 13, color: T.muted }}>{k}</span>
        <span style={{ fontSize: strong ? 17 : 14, fontWeight: strong ? 700 : 600, color: tone || T.text, fontVariantNumeric: "tabular-nums" }}>{v}</span>
      </div>
      {note && <div style={{ fontSize: 11, color: T.muted, marginTop: 2, lineHeight: 1.45 }}>{note}</div>}
    </div>
  );
}

function Section({ title, body, children }) {
  return (
    <div style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 17, margin: "0 0 6px" }}>{title}</h2>
      <p style={{ fontSize: 13, color: T.muted, lineHeight: 1.6, maxWidth: 620, margin: "0 0 12px" }}>{body}</p>
      {children}
    </div>
  );
}

// Tables get their own horizontal scroll container; the page body must
// never scroll sideways.
function Table({ head, rows, highlight }) {
  return (
    <div style={{ overflowX: "auto", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 380, fontSize: 13 }}>
        <thead>
          <tr>{head.map(h => (
            <th key={h} style={{ textAlign: "left", padding: "10px 12px", fontSize: 11, letterSpacing: 0.3, color: T.muted, borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} style={{ background: i === highlight ? "#EFF6FF" : "transparent" }}>
              {cells.map((cell, j) => {
                const o = typeof cell === "object" ? cell : { v: cell };
                return (
                  <td key={j} style={{ padding: "8px 12px", borderBottom: `1px solid ${T.border}`, color: o.tone || T.text, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", fontWeight: j === 0 ? 600 : 400 }}>{o.v}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
