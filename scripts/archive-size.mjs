// How big the stream archives are, per hour and per day, from Storage's
// file LISTING — nothing is downloaded but the newest m15x/ file, read to
// say which series it holds. So it answers "is the recorder writing
// m15x/" and "what did it add" for the price of a listing. --total adds
// what each folder holds in all, which is what the bucket is billed on.
//
//   node scripts/archive-size.mjs [--hours=24] [--total]
import { archiveReader } from "../lib/archiveRead.js";
import { authHeaders } from "../lib/supabaseHeaders.js";

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive bucket is private"); process.exit(2); }
const HOURS = Number((process.argv.find(a => a.startsWith("--hours=")) || "--hours=24").split("=")[1]);
const reader = archiveReader({ url: URL, key: KEY });
const now = Date.now(), from = now - HOURS * 3600000;
const MB = b => (b / 1e6).toFixed(1);

if (process.argv.includes("--ladder")) {
  // The ladder recorder's folder (docs/research/ladder-step2-plan.md): the
  // size per hour from the listing, and ONE file read for its health lines
  // (receive lag, memory), its selections and what filled it. The newest
  // file may still be the hour being written, so the one before is read.
  const files = await reader.listRange("ladder", from, now);
  const byHour = new Map();
  for (const f of files) { const h = f.path.split("/").slice(1, 3).join(" "); byHour.set(h, (byHour.get(h) || 0) + (f.size || 0)); }
  const bytes = files.reduce((s, f) => s + (f.size || 0), 0);
  console.log(`LADDER ARCHIVE, last ${HOURS}h: ${files.length} files, ${MB(bytes)} MB over ${byHour.size} hours${byHour.size ? ` (${MB(bytes / byHour.size)} MB an hour, ~${MB(bytes / byHour.size * 24)} MB a day, ~${(bytes / byHour.size * 24 * 14 / 1e9).toFixed(1)} GB over 14 days)` : ""}`);
  for (const [h, b] of [...byHour].slice(-8)) console.log(`  ${h}h  ${MB(b)} MB`);
  const pick = files.filter(f => (f.size || 0) > 100000).at(-1) || files.at(-1);
  if (pick) {
    const kinds = {}, deltas = {}, health = [], sels = [], notes = [];
    await reader.eachLine(pick.path, o => {
      kinds[o.k] = (kinds[o.k] || 0) + 1;
      if (o.k === "d") { const s = o.m.split("-")[0]; deltas[s] = (deltas[s] || 0) + 1; }
      if (o.k === "health") health.push(o);
      if (o.k === "sel") sels.push(o);
      if (o.k === "gap" || o.k === "err" || (o.k === "conn" && o.ev !== "open" && o.ev !== "subscribed")) notes.push(o);
    });
    console.log(`\nread ${pick.path} (${MB(pick.size || 0)} MB)`);
    console.log(`  lines by kind ${JSON.stringify(kinds)}`);
    console.log(`  changes by series ${JSON.stringify(deltas)}`);
    for (const s of sels) console.log(`  selection ${s.close}: ${s.n} markets, ref ${s.ref}, ${s.inBand} in band of ${s.listed} listed${s.late ? " (started late)" : ""}${s.why ? `, ${s.why}` : ""}`);
    const busy = health.filter(h => h.frames > 0);
    const mx = k => busy.length ? Math.max(...busy.map(h => h[k] ?? 0)) : null, md = k => { const v = busy.map(h => h[k]).filter(x => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
    console.log(`  health, ${busy.length} busy minutes of ${health.length}: receive lag p50 median ${md("lagP50")}ms, p99 median ${md("lagP99")}ms, worst p99 ${mx("lagP99")}ms, worst max ${mx("lagMax")}ms; event loop busiest ${mx("elu")}; frames a minute median ${md("frames")}; memory available min ${health.length ? Math.min(...health.map(h => h.memMB ?? Infinity)) : "—"}MB; recorder RSS max ${health.length ? Math.max(...health.map(h => h.rssMB ?? 0)) : "—"}MB`);
    console.log(`  gaps, errors, drops: ${notes.length ? notes.slice(0, 10).map(o => JSON.stringify(o)).join(" ") : "none"}`);
  }
  process.exit(0);
}

console.log(`STREAM ARCHIVE SIZES, last ${HOURS}h (from the listing; nothing downloaded but one file)`);
const totals = {};
const TOPS = ["m15", "m15x", "m15c", "pmus15"];
for (const top of TOPS) {
  const files = await reader.listRange(top, from, now);
  const byHour = new Map();
  for (const f of files) { const h = f.path.split("/").slice(1, 3).join(" "); byHour.set(h, (byHour.get(h) || 0) + (f.size || 0)); }
  const bytes = files.reduce((s, f) => s + (f.size || 0), 0);
  totals[top] = { files: files.length, bytes, hours: byHour.size };
  console.log(`\n${top}/: ${files.length} files, ${MB(bytes)} MB over ${byHour.size} hours${byHour.size ? ` (${MB(bytes / byHour.size)} MB an hour, ~${MB(bytes / byHour.size * 24)} MB a day)` : ""}`);
  for (const [h, b] of [...byHour].slice(-6)) console.log(`  ${h}h  ${MB(b)} MB`);
  if (top === "m15x" && files.length) {
    const last = files[files.length - 1], kinds = {}, series = {};
    await reader.eachLine(last.path, o => {
      kinds[o.k] = (kinds[o.k] || 0) + 1;
      const ms = Array.isArray(o.m) ? o.m : typeof o.m === "string" ? [o.m] : [];
      for (const m of ms) { const s = m.split("-")[0]; series[s] = (series[s] || 0) + 1; }
    });
    console.log(`  newest file ${last.path} (${MB(last.size || 0)} MB): lines by kind ${JSON.stringify(kinds)}`);
    console.log(`  lines by series ${JSON.stringify(series)}`);
  }
}
if (!totals.m15x.files) console.log(`\n::warning::no m15x/ files in the last ${HOURS}h — the recorder has not picked up the commodity and FX series yet (it cycles hourly after the box pulls main)`);
const day = t => t.hours ? t.bytes / t.hours * 24 : 0;
console.log(`\nm15x/ adds ~${MB(day(totals.m15x))} MB a day (~${(day(totals.m15x) * 30 / 1e9).toFixed(1)} GB a month) beside m15/'s ~${MB(day(totals.m15))} MB a day.`);
const all = TOPS.reduce((s, t) => s + day(totals[t]), 0);
console.log(`All folders: ~${MB(all)} MB a day, ~${(all * 30 / 1e9).toFixed(1)} GB a month at this rate.`);

if (process.argv.includes("--total")) {
  // Everything held. Each folder from just before its recorder started, so
  // the listing does not walk empty hours.
  const START = { m15: "2026-09-20", m15x: "2026-10-25", m15c: "2026-10-29", pmus15: "2026-09-20" };
  console.log("\nHELD IN TOTAL (every file listed)");
  let sum = 0;
  const line = (name, n, bytes) => console.log(`  ${name.padEnd(10)} ${String(n).padStart(7)} files  ${(bytes / 1e9).toFixed(2).padStart(7)} GB`);
  for (const top of TOPS) {
    const files = await reader.listRange(top, Date.parse(`${START[top]}T00:00:00Z`), now);
    const bytes = files.reduce((s, f) => s + (f.size || 0), 0); sum += bytes; line(top + "/", files.length, bytes);
  }
  // The CME files bought from Databento sit flat under databento/.
  const r = await fetch(`${URL}/storage/v1/object/list/stream-archive`, {
    method: "POST", headers: authHeaders(KEY, { "Content-Type": "application/json" }),
    body: JSON.stringify({ prefix: "databento/", limit: 1000, offset: 0 }),
  });
  const db = r.ok ? (await r.json()).filter(e => e.id) : [];
  const dbBytes = db.reduce((s, e) => s + (e.metadata?.size || 0), 0); sum += dbBytes; line("databento/", db.length, dbBytes);
  console.log(`  ${"total".padEnd(10)} ${"".padStart(7)}        ${(sum / 1e9).toFixed(2).padStart(7)} GB`);
}
