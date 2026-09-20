// The box reporting on itself, and the watchdog noticing when it stops.
//
// Everything this project records is market data; the machine doing the
// recording was observable only by logging into it. A recorder wrote
// nothing for fourteen hours, warning every fifteen seconds, while all
// four data tables stayed green — because the other recorder covered
// the same table and nothing was watching the HOST.
import { execFileSync } from "child_process";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };

// Mirror of the optional-check branch in watchdog.mjs.
const skipsQuietly = (optional, at, err) =>
  !!(optional && (at == null || /does not exist|PGRST20[05]|schema cache/.test(String(err || ""))));

console.log("a check that cannot yet pass does not fail every run");
{
  ok(skipsQuietly(true, null, null), "no rows yet — the host has not reported");
  ok(skipsQuietly(true, null, 'relation "box_health" does not exist'),
     "table missing — the migration has not been run");
  ok(skipsQuietly(true, null, "PGRST205 schema cache"), "PostgREST has not seen it either");
  // The point: a daily error nobody can clear teaches you to ignore the
  // channel, which is how a real alarm gets missed later.
}

console.log("\nbut once it reports, it is an ordinary check");
{
  ok(!skipsQuietly(true, Date.now(), null), "a row present means the check is live");
  ok(!skipsQuietly(true, Date.now() - 60 * 60 * 1000, null),
     "and a STALE row is a real alarm, not a skip");
  ok(!skipsQuietly(false, null, "boom"), "a non-optional check never skips");
  // A read that fails for some other reason must still be loud.
  ok(!skipsQuietly(true, Date.now(), "connection reset"),
     "an unrelated error on a reporting host is not swallowed");
}

console.log("\nthe reporter names the migration when the table is missing");
{
  const src = execFileSync("cat", ["scripts/report-health.mjs"], { encoding: "utf8" });
  ok(/0025_box_health\.sql/.test(src),
     "the write path says which migration to run, not just 'does not exist'");
  ok(/assertCredential/.test(src), "and proves its credential before writing, like every writer here");
  ok(/on_conflict=host/.test(src), "upserts one row per host rather than appending forever");
}

console.log("\nunit state carries restarts, not just active/inactive");
{
  const src = execFileSync("cat", ["scripts/report-health.mjs"], { encoding: "utf8" });
  ok(/NRestarts/.test(src),
     "a unit that is active having restarted forty times is not healthy");
  ok(/LoadState/.test(src) && /absent/.test(src),
     "and a unit this box does not run reports as absent rather than silently missing");
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
