// A test vector for the sharp-move decider (lib/sharpMove.js): a few
// recorded KXBTC15M windows, with every BRTI tick and the book touch at
// each tick's instant, and every decision and skip the decider made. A copy
// of the decider that replays these ticks must return the same list, value
// for value. scripts/sharp-move.test.mjs replays the saved fixture.
//
// Picks, from the most recent complete windows (no socket event or
// sequence gap in the final two minutes):
//   order       the first event traded
//   skip-order  an event passed over on the book, then a later one traded
//                (the other direction from "order" where one exists)
//   no-order    events, none traded
//   stale       a move measured across a silence, reported and not traded
//                (if one exists in the days read)
//
// The vector is recorded Kalshi data, for this project's own use: it goes
// in this private repository and to our own trader, never anywhere else.
//
// Reads only. Needs SUPABASE_SERVICE_ROLE_KEY (the archive is private).
// Usage: node scripts/sharp-move-vector.mjs [--days=2] [--out=sharp-move-vector.json]

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { authHeaders } from "../lib/supabaseHeaders.js";
import { pageAll } from "../lib/restPage.js";
import { archiveReader } from "../lib/archiveRead.js";
import { newTape, feedTape, disrupted, bookCursor } from "../lib/m15Maker.js";
import { replayVector, SHARP_MOVE } from "../lib/sharpMove.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive bucket is private (migration 0029)"); process.exit(2); }

const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const DAYS = Math.min(Number(opt("days", 2)), 7);
const OUT = opt("out", "sharp-move-vector.json");
const SINCE_MS = Date.now() - DAYS * 86400000;
const SERIES = "KXBTC15M";
const FIRST_MS = 125000;   // ticks from 125s out: the earliest event needs a baseline 1s before 118s

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...authHeaders(KEY) } });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const want = new Map();
for (const m of await pageAll(rest, "m15_markets", "ticker,close_time,result",
  `series=eq.${SERIES}&result=not.is.null&close_time=gte.${new Date(SINCE_MS).toISOString()}`, { key: "close_time", dedupeOn: "ticker" }))
  if (m.result === "yes" || m.result === "no") want.set(m.ticker, { close: Date.parse(m.close_time), result: m.result });
const wantClose = new Map([...want].map(([t, m]) => [t, m.close]));

const tape = newTape();
let ticks = [];   // { t: source_ts_ms, s: value_usd as recorded }
let watermark = 0;
const done = new Set();

// The decider over one window, with the book touch at every tick's instant.
function replay(ticker) {
  const { close, result } = want.get(ticker);
  const w = tape.win.get(ticker);
  tape.win.delete(ticker);
  if (!w || disrupted(tape, w)) return null;
  const tk = ticks.filter(k => k.t >= close - FIRST_MS && k.t <= close - SHARP_MOVE.toSecs * 1000).sort((a, b) => a.t - b.t);
  if (!tk.length) return null;
  const cursor = bookCursor(w, 1), from = close - SHARP_MOVE.fromSecs * 1000;
  const rows = tk.map(k => {
    if (k.t < from) return [k.t, k.s, null, null];
    const s = cursor.at(k.t);
    return [k.t, k.s, s?.bids[0]?.[0] ?? null, s?.asks[0]?.[0] ?? null];
  });
  const decisions = replayVector(close, rows);
  return { ticker, close_ms: close, result, ticks: rows, decisions };
}

function classify(v) {
  const order = v.decisions.find(d => d.order);
  const events = v.decisions.filter(d => d.skip !== "stale baseline" && d.skip !== "out of order");
  const passedFirst = events.length && !events[0].order;
  const kinds = [];
  if (order && events[0] === order) kinds.push("order");
  if (order && passedFirst) kinds.push("skip-order");
  if (!order && events.length) kinds.push("no-order");
  if (v.decisions.some(d => d.skip === "stale baseline")) kinds.push("stale");
  return kinds;
}

const complete = [];   // every complete window, replayed
function finalize(ticker) {
  done.add(ticker);
  const v = replay(ticker);
  if (v) complete.push({ ...v, kinds: classify(v) });
}

const reader = archiveReader({ url: URL, key: KEY });
const files = await reader.listRange("m15", SINCE_MS - 2 * 3600000, Date.now());
const needle = `"m":"${SERIES}-`;
const keep = line => (line.startsWith('{"k":"i5"') && line.includes('"id":"BRTI"'))
  || ((line.startsWith('{"k":"d"') || line.startsWith('{"k":"full"') || line.startsWith('{"k":"final"')) && line.includes(needle))
  || line.startsWith('{"k":"conn"') || line.startsWith('{"k":"gap"');
for (const f of files) {
  await reader.eachLine(f.path, o => {
    if (Number.isFinite(o.t) && o.t > watermark) watermark = o.t;
    if (o.k === "i5") {
      if (!Number.isFinite(o.x) || o.v == null || o.v === "" || !Number.isFinite(Number(o.v))) return;
      ticks.push({ t: o.x, s: String(o.v) });
      return;
    }
    feedTape(tape, o, wantClose);
  }, keep);
  for (const [ticker, m] of want) if (!done.has(ticker) && m.close + 10000 < watermark) finalize(ticker);
  ticks = ticks.filter(k => k.t >= watermark - 1800000);
}
for (const ticker of want.keys()) if (!done.has(ticker)) finalize(ticker);

// The most recent window of each kind, none twice; "order" in the other
// direction from "skip-order" where the days hold one.
complete.sort((a, b) => b.close_ms - a.close_ms);
const sideOf = v => v.decisions.find(d => d.order)?.order.side;
const chosen = [], taken = new Set();
const take = (why, v) => { if (v) { chosen.push({ why, ...v, kinds: undefined }); taken.add(v.ticker); } };
const so = complete.find(v => v.kinds.includes("skip-order"));
const orders = complete.filter(v => v.kinds.includes("order") && v.ticker !== so?.ticker);
take("order", orders.find(v => sideOf(v) !== sideOf(so ?? {})) ?? orders[0]);
take("skip-order", so);
for (const k of ["no-order", "stale"]) take(k, complete.find(v => v.kinds.includes(k) && !taken.has(v.ticker)));
const windowsSeen = complete.length;
if (chosen.length < 3) { console.error(`::error::only ${chosen.length} of the wanted windows found in ${windowsSeen} complete windows; widen --days`); process.exit(1); }

const vector = {
  about: "Sharp-move decider test vector (KXBTC15M). Feed each window's ticks in order to the decider; the non-null returns must equal `decisions` exactly. Recorded Kalshi data: this project's own use only.",
  decider: "lib/sharpMove.js",
  params: SHARP_MOVE,
  ticks: "[source_ts_ms, value_usd as recorded (a string), YES bid, YES ask]: the touch as it stood at that instant on Kalshi's clock; null before 118s out (the decider never asks) or for an empty side",
  windows: chosen,
};
const json = JSON.stringify(vector);
writeFileSync(OUT, json + "\n");
console.log(`SHARP-MOVE VECTOR — ${windowsSeen} complete windows read; ${chosen.length} chosen, ${json.length} bytes -> ${OUT}`);
for (const v of chosen) {
  console.log(`\n  ${v.why}: ${v.ticker} (closed ${new Date(v.close_ms).toISOString()}, settled ${v.result}), ${v.ticks.length} ticks`);
  for (const d of v.decisions) console.log(`    ${((v.close_ms - d.t) / 1000).toFixed(3)}s out  ${d.order ? `ORDER ${d.order.side} seen ${d.order.seen} limit ${d.order.limit}` : d.skip}  bp ${d.bp?.toFixed(3) ?? "—"}  book ${d.bid ?? "—"}/${d.ask ?? "—"}`);
}
// The file in the log as well, gzipped: the job's artifact is the other copy.
const b64 = gzipSync(Buffer.from(json)).toString("base64");
console.log(`\nVECTOR-GZ-BASE64 ${b64.length} chars`);
for (let i = 0; i < b64.length; i += 2000) console.log(`VGZ ${b64.slice(i, i + 2000)}`);
console.log("VECTOR-END");
