// Audit an advertised trading strategy against what actually settled.
//
// WHY THIS EXISTS. The prediction-market tooling space is ~200 products
// making performance claims and zero products auditing another's. The
// claims are unfalsifiable as published: a backtest reports a win rate
// and a Sharpe, and neither survives contact with Kalshi's fee curve or
// with the question "at what size".
//
// We can falsify them, because we hold the settled outcomes and a
// recorded price path, and because lib/fees.js already knows what a
// trade costs. This turns that into a harness that takes a strategy as
// DATA rather than as code, so a new claim is a JSON file and not a
// rewrite.
//
// THE ONE RULE THIS ENFORCES: a win rate is not a result. Buying at 92c
// and winning 93% of the time is roughly what a fair market pays; the
// win rate is a fact about the entry price. Only the edge over price,
// NET OF FEES, is a finding — and only when the sample can carry it.

import { feeOf } from "./calibrate.js";

export class SpecError extends Error {}

// A strategy spec, validated loudly. An unknown field is an ERROR, not
// something to ignore: silently dropping a filter would audit a
// DIFFERENT strategy than the one described and report it under the
// claimed name.
const ENTRY_KEYS = new Set(["secsToClose", "spread", "price", "side"]);
const SPEC_KEYS = new Set(["name", "source", "series", "entry", "size", "exit", "notes"]);

export function parseSpec(raw) {
  if (!raw || typeof raw !== "object") throw new SpecError("spec must be an object");
  for (const k of Object.keys(raw)) {
    if (!SPEC_KEYS.has(k)) throw new SpecError(`unknown spec field "${k}" — refusing to audit a strategy I do not fully understand`);
  }
  const { name, series, entry, size, exit } = raw;
  if (!name) throw new SpecError("spec.name is required — a verdict must say what it is about");
  if (!Array.isArray(series) || !series.length) throw new SpecError("spec.series must be a non-empty array");
  if (!entry || typeof entry !== "object") throw new SpecError("spec.entry is required");
  for (const k of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(k)) throw new SpecError(`unknown entry filter "${k}"`);
  }
  const side = entry.side ?? "either";
  if (!["yes", "no", "either"].includes(side)) throw new SpecError(`entry.side must be yes|no|either, got "${side}"`);
  // Hold-to-settlement is the only exit this can score. A stop-loss
  // needs the price path AFTER entry, which is a different and much
  // heavier query — saying so beats silently ignoring the rule and
  // reporting the result as if the stop did not exist.
  if (exit && exit !== "settlement") {
    throw new SpecError(`exit "${exit}" is not supported: only hold-to-settlement can be scored without replaying the post-entry path`);
  }
  if (size != null && !(Number(size) > 0)) throw new SpecError("spec.size must be positive");
  return { ...raw, entry: { ...entry, side }, exit: "settlement", size: size == null ? null : Number(size) };
}

// Does this quote trigger an entry, and at what price on which side?
//
// The NO ask is 1 - yes_bid: Kalshi runs a separate NO book but the
// recorder stores only the YES side, and taking NO at its ask is the
// same trade as selling YES at the bid.
export function entryFor(q, spec) {
  const bid = Number(q.yes_bid), ask = Number(q.yes_ask);
  // A missing side is UNKNOWN. Number(null) is 0 and a fabricated zero
  // would read as a free option.
  if (q.yes_bid == null || q.yes_ask == null) return null;
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;

  const e = spec.entry;

  // NO LOOKAHEAD, UNCONDITIONALLY.
  //
  // A quote at or after expiry cannot be entered: past the bell the
  // "price" IS the settlement, so scoring it hands the backtest the
  // answer and manufactures wins out of nothing. This is not
  // hypothetical — a commercial backtester was confirmed by its own
  // support to do exactly this, because its engine stepped in 60-second
  // cycles and a trade closing inside the last two minutes of a
  // 15-minute market was resolved AFTER the market had settled. Its
  // flagship template enters in the final 90 seconds, so the bug landed
  // squarely on the strategies it was selling.
  //
  // The guard is here rather than in the query on purpose. A filter
  // that lives only in the caller is one refactor away from being
  // absent, and the same lesson is already recorded for the
  // implausible-spread check: the guard belongs WITH the calculation.
  // A spec that states no time filter still cannot look ahead.
  if (q.secs_to_close == null) {
    // Unknown timing cannot be proven to precede expiry.
    if (e.secsToClose != null) return null;
  } else {
    const s = Number(q.secs_to_close);
    if (!Number.isFinite(s)) return null;
    if (s <= 0) return null;
    if (e.secsToClose?.max != null && s > e.secsToClose.max) return null;
    if (e.secsToClose?.min != null && s < e.secsToClose.min) return null;
  }

  if (e.spread?.max != null && ask - bid > e.spread.max) return null;

  const lo = e.price?.min ?? 0, hi = e.price?.max ?? 1;
  const wantYes = e.side === "yes" || e.side === "either";
  const wantNo = e.side === "no" || e.side === "either";

  if (wantYes && ask >= lo && ask <= hi) return { side: "yes", price: ask };
  if (wantNo) {
    const noAsk = 1 - bid;
    if (noAsk >= lo && noAsk <= hi) return { side: "no", price: noAsk };
  }
  return null;
}

// A verdict, and it refuses to overclaim.
//
// An auditor that reports a number on 30 correlated trades is doing the
// thing it exists to criticise. The sample is judged FIRST: below a
// floor, and where the edge is inside its own standard error, the
// answer is "cannot tell" — which is a real finding about the claim,
// not a failure of the audit.
export const MIN_ENTRIES = 100;
export const MIN_DAYS = 14;

export function verdict({ n, days, edgeOverPrice, se, netPer }) {
  if (n < MIN_ENTRIES) return { call: "INSUFFICIENT", why: `${n} entries, need ${MIN_ENTRIES}` };
  if (days < MIN_DAYS) return { call: "INSUFFICIENT", why: `${days} distinct days, need ${MIN_DAYS}` };
  // Trades on one underlying across consecutive windows are not
  // independent, so the nominal SE flatters the sample. Requiring two
  // sigma of a DEFLATED standard error is the cheap correction.
  const inflated = se * Math.sqrt(5);
  if (Math.abs(edgeOverPrice) < 2 * inflated) {
    return { call: "NOT PROVEN", why: `edge ${(100 * edgeOverPrice).toFixed(2)}pt is inside 2x the correlation-adjusted SE (${(100 * inflated).toFixed(2)}pt)` };
  }
  if (netPer > 0) return { call: "PROFITABLE", why: `net ${(100 * netPer).toFixed(2)}c/contract, edge survives fees and the sample` };
  return { call: "UNPROFITABLE", why: `net ${(100 * netPer).toFixed(2)}c/contract after fees` };
}

export function audit(observations, resultOf, spec, mult, dayOf) {
  let n = 0, wins = 0, gross = 0, net = 0;
  const sides = { yes: 0, no: 0 };
  const entries = [], days = new Set();
  const byBand = new Map();

  for (const q of observations) {
    const res = resultOf.get(q.ticker);
    if (res !== "yes" && res !== "no") continue;
    const hit = entryFor(q, spec);
    if (!hit) continue;

    const won = hit.side === res;
    const f = feeOf(hit.price, mult);
    n++; if (won) wins++;
    sides[hit.side]++;
    entries.push(hit.price);
    gross += won ? 1 - hit.price : -hit.price;
    net += won ? 1 - hit.price - f : -(hit.price + f);
    const d = dayOf?.(q.ticker);
    if (d) days.add(d);

    const band = Math.floor(hit.price * 20) / 20;
    const b = byBand.get(band) || { lo: band, n: 0, wins: 0, net: 0 };
    b.n++; if (won) b.wins++;
    b.net += won ? 1 - hit.price - f : -(hit.price + f);
    byBand.set(band, b);
  }

  if (!n) return { n: 0, sides, bands: [], verdict: { call: "NO ENTRIES", why: "no quote met the entry filters" } };

  const avgEntry = entries.reduce((a, b) => a + b, 0) / n;
  const winRate = wins / n;
  const edgeOverPrice = winRate - avgEntry;
  const se = Math.sqrt(winRate * (1 - winRate) / n);
  const netPer = net / n;
  const out = {
    n, wins, sides, avgEntry, winRate,
    breakeven: avgEntry + feeOf(avgEntry, mult),
    grossPer: gross / n, netPer, edgeOverPrice, se,
    days: days.size,
    bands: [...byBand.values()].sort((a, b) => a.lo - b.lo),
  };
  out.verdict = verdict({ n, days: days.size, edgeOverPrice, se, netPer });
  return out;
}
