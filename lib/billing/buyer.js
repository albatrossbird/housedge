// The signed-in buyer, for the billing routes: POST only, same origin,
// billing on, signed in, with a profile. -> { profile } or { status, error }.
import { siteUrl } from "../auth/config.js";
import { getSession, sameOrigin } from "../auth/session.js";
import { getProfile, ensureProfile } from "../auth/profiles.js";
import { billingEnabled } from "./stripe.js";

export async function buyer(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "POST") return { status: 405, error: "POST only" };
  if (!sameOrigin(req)) return { status: 403, error: "cross-site request refused" };
  if (!billingEnabled()) return { status: 404, error: "paid plans are not open yet" };
  const s = await getSession(req, res);
  if (s.unavailable) return { status: 503, error: "sign-in is unavailable right now; try again in a minute" };
  if (!s.user) return { status: 401, error: "sign in first" };
  const profile = (await getProfile(s.user.id)) || (await ensureProfile(s.user));
  return { profile, site: siteUrl(req) };
}
