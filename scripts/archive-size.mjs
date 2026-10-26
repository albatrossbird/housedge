// How big the stream archives are, per hour and per day, from Storage's
// file LISTING — nothing is downloaded but the newest m15x/ file, read to
// say which series it holds. So it answers "is the recorder writing
// m15x/" and "what did it add" for the price of a listing.
//
//   node scripts/archive-size.mjs [--hours=24]
import { archiveReader } from "../lib/archiveRead.js";

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive bucket is private"); process.exit(2); }
const HOURS = Number((process.argv.find(a => a.startsWith("--hours=")) || "--hours=24").split("=")[1]);
const reader = archiveReader({ url: URL, key: KEY });
const now = Date.now(), from = now - HOURS * 3600000;
const MB = b => (b / 1e6).toFixed(1);

console.log(`STREAM ARCHIVE SIZES, last ${HOURS}h (from the listing; nothing downloaded but one file)`);
const totals = {};
for (const top of ["m15", "m15x", "pmus15"]) {
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
