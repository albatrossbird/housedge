// Append-only quote recording with write-on-change.
//
// `quotes` is the one table that cannot be backfilled — v1 overwrote
// price in place, so none of that history exists. It is also the only
// table that grows without bound, which matters on Supabase's 500MB free
// tier.
//
// Unconditional polling would write rows(listings) x polls/day forever:
// at ~600 listings on a 5-minute cron that's ~170k rows/day, roughly
// 17MB/day, filling the free tier in about a month while recording
// almost nothing but duplicates (most markets don't move most minutes).
//
// So: only insert when a price actually moved, plus a slow heartbeat so
// a flat market still shows evidence we were watching. That turns the
// steady-state cost into "rows proportional to actual market activity",
// which is both far smaller and the thing you actually want to chart.

import { rest, insert } from "./db.js";

// Half a tick. Prediction-market prices quote in cents, so anything
// below this is float noise rather than a real move.
const PRICE_EPSILON = 0.005;

// Write a row even with no price change if the last one is older than
// this, so a dormant listing still has periodic proof-of-life.
const HEARTBEAT_MS = 6 * 60 * 60 * 1000;

function changed(prev, next) {
  if (!prev) return true;

  for (const field of ["bid", "ask", "mid", "last"]) {
    const a = prev[field];
    const b = next[field];
    if (a == null && b == null) continue;
    if (a == null || b == null) return true;
    if (Math.abs(Number(a) - Number(b)) >= PRICE_EPSILON) return true;
  }

  // Volume is monotonic and its movement is itself signal, but it ticks
  // constantly on liquid markets — only treat a material change as a
  // reason to write a row on its own.
  const pv = prev.volume == null ? null : Number(prev.volume);
  const nv = next.volume == null ? null : Number(next.volume);
  if (pv != null && nv != null && pv > 0 && Math.abs(nv - pv) / pv >= 0.02) return true;
  if (pv == null && nv != null) return true;

  if (prev.ts && Date.now() - new Date(prev.ts).getTime() >= HEARTBEAT_MS) return true;

  return false;
}

/**
 * @param {Array<{listing_id:string,bid?:number,ask?:number,mid?:number,last?:number,volume?:number}>} incoming
 * @returns {Promise<{inserted:number,skipped:number,errors:string[]}>}
 */
export async function recordQuotes(incoming) {
  if (!incoming.length) return { inserted: 0, skipped: 0, errors: [] };

  const errors = [];
  const byId = new Map();

  // Pull current state for just these listings, chunked so the `in.()`
  // filter doesn't produce an unreasonable URL.
  const ids = [...new Set(incoming.map(q => q.listing_id))];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const list = chunk.map(id => `"${id}"`).join(",");
    const { data, error } = await rest(
      `latest_quotes?listing_id=in.(${encodeURIComponent(list)})`
    );
    if (error) {
      errors.push(`latest_quotes: ${JSON.stringify(error)}`);
      continue;
    }
    for (const row of data || []) byId.set(row.listing_id, row);
  }

  const toInsert = [];
  let skipped = 0;
  for (const q of incoming) {
    if (changed(byId.get(q.listing_id), q)) {
      toInsert.push({
        listing_id: q.listing_id,
        bid:    q.bid    ?? null,
        ask:    q.ask    ?? null,
        mid:    q.mid    ?? null,
        last:   q.last   ?? null,
        volume: q.volume ?? null,
      });
    } else {
      skipped++;
    }
  }

  if (toInsert.length) {
    const res = await insert("quotes", toInsert);
    errors.push(...res.errors);
    return { inserted: res.count, skipped, errors };
  }

  return { inserted: 0, skipped, errors };
}

/**
 * Retention: drop quote rows older than `days`.
 *
 * Not wired to a schedule yet — call it manually, or from the refresh
 * cron once one exists. Kept explicit rather than automatic because
 * silently deleting price history should be a decision, not a default.
 */
export async function pruneQuotes(days = 90) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const { error } = await rest(`quotes?ts=lt.${encodeURIComponent(cutoff)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  return error ? { ok: false, error } : { ok: true, cutoff };
}
