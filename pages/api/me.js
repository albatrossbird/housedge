// GET -> who is signed in and what their plan unlocks. Never cached.
import { accountsMode } from "../../lib/auth/config.js";
import { getSession } from "../../lib/auth/session.js";
import { getProfile, ensureProfile, ownCode } from "../../lib/auth/profiles.js";
import { entitlementsOf, PLAN_NAMES } from "../../lib/entitlements.js";
import { billingEnabled, testMode } from "../../lib/billing/stripe.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  const mode = accountsMode();
  if (mode === "off") return res.status(200).json({ enabled: false });
  const billing = { enabled: billingEnabled(), test: billingEnabled() && testMode() };
  const s = await getSession(req, res);
  if (!s.user) return res.status(200).json({ enabled: true, mode, billing, user: null, ...(s.unavailable ? { unavailable: true } : {}) });
  try {
    const profile = (await getProfile(s.user.id)) || (await ensureProfile(s.user));
    const ent = entitlementsOf(profile);
    return res.status(200).json({
      enabled: true, mode, billing,
      user: { email: s.user.email },
      hasBilling: Boolean(profile.stripe_customer_id),
      plan: { id: ent.plan, name: PLAN_NAMES[ent.plan], until: ent.plan === "free" ? null : profile.plan_until, passUntil: ent.pass ? profile.pass_until : null },
      entitlements: { ev: ent.ev, arb: ent.arb },
      affiliateCode: req.query.full === "1" ? await ownCode(s.user.id) : undefined,
    });
  } catch (e) {
    return res.status(502).json({ enabled: true, mode, billing, user: { email: s.user.email }, error: e.message });
  }
}
