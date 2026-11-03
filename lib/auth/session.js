// Who is this request? Reads the httpOnly session cookies, renews an
// expired access token with the refresh token, and says so in cookies on
// the way out.
import { COOKIE, REFRESH_MAX_AGE, parseCookies, serializeCookie, addCookie, clearCookie } from "./cookies.js";
import { getUser, refreshSession, rejected } from "./gotrue.js";
import { accountsMode, emailAllowed } from "./config.js";
import { ensureProfile } from "./profiles.js";

export function setSession(res, s) {
  addCookie(res, serializeCookie(COOKIE.access, s.access_token, { maxAge: Number(s.expires_in) || 3600 }));
  addCookie(res, serializeCookie(COOKIE.refresh, s.refresh_token, { maxAge: REFRESH_MAX_AGE }));
}
export function clearSession(res) {
  clearCookie(res, COOKIE.access);
  clearCookie(res, COOKIE.refresh);
}

// -> { user } signed in; { user: null } signed out; { user: null, unavailable }
// when Supabase Auth could not answer. An outage keeps the cookies — logging
// everyone out on a blip is worse than a minute of the free view.
export async function getSession(req, res) {
  if (accountsMode() === "off") return { user: null };
  const c = parseCookies(req.headers.cookie);
  if (!c[COOKIE.access] && !c[COOKIE.refresh]) return { user: null };
  if (c[COOKIE.access]) {
    const u = await getUser(c[COOKIE.access]);
    if (u.ok) return allowedOrOut(res, u.data);
    if (!rejected(u)) return { user: null, unavailable: u.error };
  }
  if (c[COOKIE.refresh]) {
    const s = await refreshSession(c[COOKIE.refresh]);
    if (s.ok && s.data?.access_token) { setSession(res, s.data); return allowedOrOut(res, s.data.user); }
    if (!rejected(s)) return { user: null, unavailable: s.error };
  }
  clearSession(res);
  return { user: null };
}

// An allowlist edited during preview takes effect on the next request, not
// at the next sign-in.
function allowedOrOut(res, user) {
  if (user && emailAllowed(user.email)) return { user };
  clearSession(res);
  return { user: null };
}

// After a link, a code or Google: refuse an email the mode does not admit,
// make the profile on a first sign-in, set the cookies.
export async function finishSignIn(res, session, { ref = null, agreedAt = null } = {}) {
  const user = session?.user;
  if (!user?.id || !session.access_token) return { ok: false, status: 502, error: "sign-in returned no session" };
  if (!emailAllowed(user.email)) return { ok: false, status: 403, error: "MarketSlap accounts are not open yet." };
  const meta = user.user_metadata || {};
  const profile = await ensureProfile(user, { ref: meta.ref || ref, agreedAt: meta.agreed_18_at || agreedAt });
  setSession(res, session);
  return { ok: true, user, profile };
}

// Cross-site POSTs are already cookie-less under SameSite=Lax; this refuses
// them outright too, for browsers that predate it.
export function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}
