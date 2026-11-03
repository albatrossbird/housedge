// Google comes back here with ?code= (or ?error=). Same browser that left,
// so the PKCE verifier is in its cookie.
import { accountsMode, safeNext } from "../../../lib/auth/config.js";
import { COOKIE, parseCookies, clearCookie } from "../../../lib/auth/cookies.js";
import { exchangeCode } from "../../../lib/auth/gotrue.js";
import { finishSignIn } from "../../../lib/auth/session.js";

const back = (res, why) => res.redirect(302, `/signup?error=${encodeURIComponent(why)}`);

export default async function handler(req, res) {
  if (accountsMode() === "off") return res.status(404).json({ error: "not found" });
  const c = parseCookies(req.headers.cookie);
  for (const k of [COOKIE.pkce, COOKIE.agree, COOKIE.next]) clearCookie(res, k, "/api/auth");
  if (req.query.error) return back(res, String(req.query.error_description || req.query.error).slice(0, 200));
  if (!req.query.code || !c[COOKIE.pkce]) return back(res, "Google sign-in expired. Try again.");
  const r = await exchangeCode(String(req.query.code), c[COOKIE.pkce]);
  if (!r.ok) return back(res, r.status >= 400 && r.status < 500 ? "Google sign-in expired. Try again." : "Sign-in is unavailable right now.");
  try {
    const done = await finishSignIn(res, r.data, { ref: c[COOKIE.ref], agreedAt: c[COOKIE.agree] || null });
    if (!done.ok) return back(res, done.error);
  } catch (e) {
    return back(res, "Signed in, but the account could not be set up. Try again.");
  }
  return res.redirect(302, safeNext(c[COOKIE.next]));
}
