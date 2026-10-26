// The venue comparison one window at a time. scripts/pmus15-compare.mjs
// used to read 24 hours of both archives into memory and reduce them at
// the end: every whole .us book, every Kalshi 1-second book and every
// final-window book change (~11M a day). That passed Node's 4GB heap and
// the daily report's Spread step died with "Reached heap limit" every day
// from at least 2026-10-21.
//
// Each window only needs its own books. So the archives are read hour by
// hour, and once the hour read is SETTLE_MS past a window's close, that
// window is summarized (lib/venueCompare.js) and replayed
// (lib/venueFinal.js) and its books are let go. The results are the
// batch functions' own, window for window: summarize() and finalReplay()
// call the same per-window code.
//
// A line for a window that has already settled cannot change its result,
// so it is dropped. One stamped before that window's close + 2s (the
// latest instant either reduction reads) is counted in `late`: non-zero
// means SETTLE_MS is too short for how far behind a recorder ran.
// scripts/venue-stream.test.mjs checks it against the batch path.

import { newCompare, feedKalshi, feedPmus, newSummary, summarizeWindow, finishSummary } from "./venueCompare.js";
import { newFinal, feedKalshiFinal, newFinalReplay, finalReplayWindow } from "./venueFinal.js";
import { parsePmusSlug, kalshiM15Close } from "./pmus15.js";

export const SETTLE_MS = 10 * 60000;
const READS_PAST_CLOSE_MS = 2000;

export function newCompareRun() {
  return {
    C: newCompare(), F: newFinal(), S: newSummary(), R: newFinalReplay(),
    doneTickers: new Map(), doneSlugs: new Map(),   // -> close (ms) or null
    settled: 0, late: 0,
  };
}

const stamp = o => Number.isFinite(o.x) ? o.x : o.t;
function isLate(done, o) {
  const close = done.get(o.m);
  if (close === undefined) return false;
  if (close == null || !(stamp(o) >= close + READS_PAST_CLOSE_MS)) return "late";
  return "after";
}

export function feedRunPmus(run, o) {
  if (o?.k === "pb" && typeof o.m === "string") {
    const l = isLate(run.doneSlugs, o);
    if (l) { if (l === "late") run.late++; return; }
  }
  feedPmus(run.C, o);
}

export function feedRunKalshi(run, o) {
  if (typeof o?.m === "string") {
    const l = isLate(run.doneTickers, o);
    if (l) { if (l === "late") run.late++; return; }
  }
  feedKalshi(run.C, o);
  feedKalshiFinal(run.F, o);
}

function closeOf(run, ticker) {
  return run.F.win.get(ticker)?.close || parsePmusSlug(run.C.slugOf.get(ticker))?.close || kalshiM15Close(ticker);
}

function settleWindow(run, ticker, close) {
  const { C, F } = run;
  const slug = C.slugOf.get(ticker), ks = C.kalshi.get(ticker), w = F.win.get(ticker);
  // Its .us books already let go: this window's Kalshi lines came late.
  if (slug && !C.pmus.has(slug) && run.doneSlugs.has(slug) && ks?.some(k => k.t < (close ?? Infinity) + READS_PAST_CLOSE_MS)) run.late++;
  if (ks) summarizeWindow(run.S, ticker, ks, slug, slug && C.pmus.get(slug));
  if (w) finalReplayWindow(run.R, C, F, ticker, w);
  C.kalshi.delete(ticker); F.win.delete(ticker);
  run.doneTickers.set(ticker, close ?? null);
  if (slug && C.pmus.has(slug)) { C.pmus.delete(slug); run.doneSlugs.set(slug, parsePmusSlug(slug)?.close ?? null); }
  run.settled++;
}

// Every window that closed more than SETTLE_MS before `watermark` (the
// end of the last hour read, on the box's clock). Kalshi tickers first,
// in the order they were first seen, as summarize() and finalReplay()
// take them; then .us books no Kalshi window claimed.
export function settleRun(run, watermark) {
  const { C, F } = run;
  const ripe = c => c != null && c + SETTLE_MS < watermark;
  for (const ticker of new Set([...C.kalshi.keys(), ...F.win.keys()])) {
    const close = closeOf(run, ticker);
    if (ripe(close)) settleWindow(run, ticker, close);
  }
  for (const slug of [...C.pmus.keys()]) {
    const close = parsePmusSlug(slug)?.close;
    if (ripe(close)) { C.pmus.delete(slug); run.doneSlugs.set(slug, close); }
  }
}

// The end of the read: every window left, whatever its close.
export function finishRun(run) {
  const { C, F } = run;
  for (const ticker of new Set([...C.kalshi.keys(), ...F.win.keys()])) settleWindow(run, ticker, closeOf(run, ticker));
  C.pmus.clear();
  return { S: finishSummary(run.S), R: run.R };
}
