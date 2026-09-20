// The box, describing itself into Supabase.
//
// WHY. Everything here records market data; the machine doing the
// recording was observable only by logging into it. Every question
// worth asking — is it on the latest code, did the unit restart, what
// did it say when it failed — needed a person at a terminal. One of
// those questions went unasked for fourteen hours while a recorder
// wrote nothing and warned about it every fifteen seconds.
//
// WHAT IT DOES NOT DO is ship logs. It takes the last few error and
// warning lines, already truncated, which is enough to recognise a
// failure and small enough to upsert every few minutes forever. The
// journal on the box remains the history; this is the doorbell.
//
// Runs as root under systemd, because journalctl for another unit
// needs it. Writes with the service-role key like every other writer.
import { execFileSync } from "child_process";
import { hostname } from "os";
import { authHeaders } from "../lib/supabaseHeaders.js";
import { assertCredential } from "../lib/supabaseCredential.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !KEY) { console.error("::error::SUPABASE_URL / key not set"); process.exit(2); }

const DIR = process.env.MARKETSLAP_DIR || "/opt/marketslap";
// Named rather than discovered: a unit this box does not run should
// report as absent, which is information, where a glob would simply
// not mention it.
const UNITS = (process.env.MARKETSLAP_UNITS
  || "marketslap-m15.service,marketslap-weather.service,marketslap-update.timer,marketslap-sync.timer"
).split(",").map(s => s.trim()).filter(Boolean);

const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 15000 }).trim(); }
  catch (err) { return (err.stdout || "").toString().trim() || null; }
};

// `systemctl show` answers every question in one call and does not
// exit non-zero for an inactive unit, unlike is-active.
function unitState(name) {
  const out = sh("systemctl", ["show", name,
    "--property=ActiveState,SubState,NRestarts,ActiveEnterTimestamp,Result,LoadState"]);
  if (!out) return { state: "unknown" };
  const kv = Object.fromEntries(out.split("\n").map(l => {
    const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)];
  }));
  if (kv.LoadState === "not-found") return { state: "absent" };
  return {
    state: kv.ActiveState || "unknown",
    sub: kv.SubState || null,
    // A unit that is "active" having restarted forty times is not
    // healthy, and reads identically to one that has not.
    restarts: Number(kv.NRestarts) || 0,
    since: kv.ActiveEnterTimestamp || null,
    result: kv.Result || null,
  };
}

const units = Object.fromEntries(UNITS.map(u => [u, unitState(u)]));

// Errors from the units we care about, newest last, deduped — a crash
// loop would otherwise fill the field with one message.
const errors = [];
for (const u of UNITS.filter(u => u.endsWith(".service"))) {
  const out = sh("journalctl", ["-u", u, "--since", "-30min", "-p", "warning", "--no-pager", "-n", "40", "-o", "cat"]);
  if (!out) continue;
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (t) errors.push(`${u}: ${t.slice(0, 200)}`);
  }
}
const recent = [...new Set(errors)].slice(-12);

const df = sh("df", ["-P", DIR]);
const diskPct = df ? Number((df.split("\n").pop().match(/(\d+)%/) || [])[1]) || null : null;
const memLine = sh("free", ["-m"]);
const memUsed = memLine ? Number((memLine.split("\n")[1] || "").split(/\s+/)[2]) || null : null;
const uptime = Number((sh("cat", ["/proc/uptime"]) || "").split(" ")[0]) || null;

const row = {
  host: hostname(),
  reported_at: new Date().toISOString(),
  git_sha: sh("git", ["-C", DIR, "rev-parse", "HEAD"]),
  git_branch: sh("git", ["-C", DIR, "rev-parse", "--abbrev-ref", "HEAD"]),
  units,
  recent_errors: recent,
  disk_pct: diskPct,
  mem_used_mb: memUsed,
  uptime_seconds: uptime == null ? null : Math.round(uptime),
};

await assertCredential(SUPABASE_URL, KEY, { table: "box_health" });

const r = await fetch(`${SUPABASE_URL}/rest/v1/box_health?on_conflict=host`, {
  method: "POST",
  headers: { ...authHeaders(KEY), "Content-Type": "application/json",
             Prefer: "resolution=merge-duplicates,return=minimal" },
  body: JSON.stringify([row]),
});
if (!r.ok) {
  const body = await r.text();
  // Naming the migration, because "column does not exist" sends the
  // reader to the code rather than to the schema.
  if (/box_health/.test(body) && /does not exist|PGRST205/.test(body)) {
    console.error("::error::box_health is missing — run supabase/migrations/0025_box_health.sql");
  }
  console.error(`::error::health write ${r.status}: ${body.slice(0, 300)}`);
  process.exit(1);
}

const bad = Object.entries(units).filter(([, u]) => u.state === "failed");
console.log(`reported ${row.host} sha=${(row.git_sha || "?").slice(0, 7)} `
  + `units=${Object.keys(units).length} failed=${bad.length} errors=${recent.length} disk=${diskPct}%`);
