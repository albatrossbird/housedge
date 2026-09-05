// What an UNAUTHENTICATED caller can ask /api/refresh to do.
//
// This route is the one job endpoint the browser calls, so it is
// deliberately not gated like /api/embed and /api/v2/extract — those
// spend Voyage and Anthropic credits and 401 the moment CRON_SECRET is
// set. Gating refresh the same way would have silently taken price
// freshness from ~20s back to the throttled cron's 45min-3.5h.
//
// The bound is the cooldown instead: a stranger cannot force a venue
// read, and the ↻ button still works whenever the prices really are
// stale.
import { effectiveIfStale } from "../lib/cronAuth.js";

let bad = 0;
const eq = (got, want, label) => {
  if (got !== want) { console.log(`WRONG ${label}\n  got  ${got}\n  want ${want}`); bad++; }
};

const OPEN     = { ok: true,  enforced: false };  // CRON_SECRET unset
const AUTHED   = { ok: true,  enforced: true  };  // set, correct credential
const STRANGER = { ok: false, enforced: true  };  // set, no or wrong credential
const FLOOR = 180;

// Nothing changes until CRON_SECRET is set. This is the state the site
// is in today, and the change must be a no-op in it.
eq(effectiveIfStale(OPEN, 0, FLOOR), 0, "unset: the ↻ button still forces");
eq(effectiveIfStale(OPEN, 180, FLOOR), 180, "unset: the page's own value passes through");
eq(effectiveIfStale(OPEN, NaN, FLOOR), null, "unset: no ifStale stays absent");

// A credentialed caller — the GitHub workflows — keeps every power.
eq(effectiveIfStale(AUTHED, 0, FLOOR), 0, "authed: can force a read");
eq(effectiveIfStale(AUTHED, NaN, FLOOR), null, "authed: unconditional sweep allowed");

// A STRANGER pays the cooldown. ifStale=0 is the ↻ button's value, so
// the button keeps working — it just cannot bypass the floor.
eq(effectiveIfStale(STRANGER, 0, FLOOR), FLOOR, "stranger: cannot force");
eq(effectiveIfStale(STRANGER, 30, FLOOR), FLOOR, "stranger: cannot undercut the floor");
// The one that matters most: omitting the parameter must NOT buy an
// unconditional sweep, which is exactly what a naive floor would allow.
eq(effectiveIfStale(STRANGER, NaN, FLOOR), FLOOR, "stranger: omitting ifStale is still floored");
// Asking for MORE than the floor is always fine — it is less work.
eq(effectiveIfStale(STRANGER, 600, FLOOR), 600, "stranger: a longer cooldown is honoured");

console.log(bad ? `${bad} failing` : "cron-auth: all cases pass");
process.exit(bad ? 1 : 0);
