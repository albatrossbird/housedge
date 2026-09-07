// The on-demand half of the price refresh.
//
// The JOB lives in lib/refreshPrices.js and runs in the GitHub Actions
// runner on a schedule — see the banner there for why it moved off
// Vercel. This route is what the BROWSER calls: pages/index.js asks for
// a refresh on every visit where the prices on screen are over three
// minutes old, and that path is what keeps freshness at ~3 minutes
// rather than the 45 minutes to 3.5 hours the throttled cron manages.
//
// Both callers run the same runRefresh(), so the scheduled sweep and
// the on-demand one cannot drift.
import { cronAuthorized, effectiveIfStale } from "../../lib/cronAuth.js";
import { runRefresh, ON_DEMAND_FLOOR_SECONDS } from "../../lib/refreshPrices.js";

export default async function handler(req, res) {
  // REFRESH IS NOT GATED THE WAY THE OTHER JOB ROUTES ARE, and the
  // reason is that the browser calls it.
  //
  // /api/embed spends Voyage credits, /api/v2/extract spends Anthropic
  // credits, /api/prune deletes rows — a stranger running those costs
  // real money, so they 401 the moment CRON_SECRET is set. This route
  // reads two public venues and writes prices, so gating it identically
  // would have turned CRON_SECRET on and silently taken price freshness
  // back to whatever the throttled cron manages.
  //
  // So an unauthenticated caller is ALLOWED, and pays the cooldown:
  // ifStale is floored at ON_DEMAND_FLOOR_SECONDS, which is exactly
  // what the page asks for anyway. Only an authenticated caller can
  // force a read with ifStale=0 — the ↻ button therefore refreshes when
  // the prices are genuinely stale and cannot hammer the venues.
  const auth = cronAuthorized(req);
  const floorCooldown = auth.enforced && !auth.ok;

  try {
    // An unauthenticated caller gets the floor whether or not it asked
    // for one — otherwise omitting ifStale entirely would buy an
    // unconditional venue sweep, which is the thing being bounded.
    const requested = parseInt(req.query.ifStale, 10);
    const ifStale = effectiveIfStale(auth, requested, ON_DEMAND_FLOOR_SECONDS);

    const result = await runRefresh({
      ifStale,
      cooldownFloored: floorCooldown ? ON_DEMAND_FLOOR_SECONDS : null,
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
