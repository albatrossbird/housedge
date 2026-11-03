// What a plan unlocks on the sports board, and the board a plan may see.
//
// The free view is CUT ON THE SERVER. Blurring in the browser would still
// send every hidden price to anyone who opens the network tab.
//
// Plans: free | ev | arb | pro, each held until plan_until (null = no end).
// A day pass (pass_until) unlocks everything beside whatever plan is held,
// so buying one never overwrites a subscription.
export const FREE_EV_CAP = 0.03;   // free sees +EV prices under 3% in full, like AVO's free tier
export const PLAN_NAMES = { free: "Free", ev: "+EV", arb: "Arbitrage", pro: "Sports Pro" };

const live = (until, now) => until == null || Date.parse(until) > now;

export function entitlementsOf(profile, now = Date.now()) {
  const plan = profile?.plan || "free";
  const held = plan !== "free" && live(profile?.plan_until, now) ? plan : "free";
  const pass = profile?.pass_until != null && Date.parse(profile.pass_until) > now;
  return {
    plan: held,
    pass,
    ev: pass || held === "ev" || held === "pro",
    arb: pass || held === "arb" || held === "pro",
  };
}

const countBy = (xs, f) => xs.reduce((m, x) => { const k = f(x) ?? "other"; m[k] = (m[k] || 0) + 1; return m; }, {});

// A sanitized board (lib/sportsBoard.js) -> what these entitlements may see.
// Locked rows and arbs are COUNTED, by sport, and never sent.
export function limitBoard(board, ent = { ev: false, arb: false }) {
  const out = { ...board, locked: null };
  const locked = {};
  if (!ent.ev) {
    const ev = r => r.evNet ?? r.ev ?? 0;
    const hidden = board.rows.filter(r => ev(r) >= FREE_EV_CAP);
    out.rows = board.rows.filter(r => ev(r) < FREE_EV_CAP);
    locked.ev = { cap: FREE_EV_CAP, count: hidden.length, bySport: countBy(hidden, r => r.sport) };
  }
  if (!ent.arb) {
    out.arbs = [];
    locked.arb = { count: board.arbs.length, bySport: countBy(board.arbs, a => a.sport) };
  }
  if (Object.keys(locked).length) out.locked = locked;
  return out;
}
