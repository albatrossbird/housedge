// GET ?agree=1&next=/sports -> Google, via Supabase Auth, with PKCE.
import { accountsMode, safeNext, siteUrl } from "../../../lib/auth/config.js";
import { COOKIE, addCookie, serializeCookie } from "../../../lib/auth/cookies.js";
import { googleAuthorizeUrl, pkcePair } from "../../../lib/auth/gotrue.js";

export default function handler(req, res) {
  if (accountsMode() === "off") return res.status(404).json({ error: "not found" });
  if (req.query.agree !== "1") return res.redirect(302, "/signup?error=agree");
  const { verifier, challenge } = pkcePair();
  const opts = { maxAge: 600, path: "/api/auth" };
  addCookie(res, serializeCookie(COOKIE.pkce, verifier, opts));
  addCookie(res, serializeCookie(COOKIE.agree, new Date().toISOString(), opts));
  addCookie(res, serializeCookie(COOKIE.next, safeNext(req.query.next), opts));
  return res.redirect(302, googleAuthorizeUrl(`${siteUrl(req)}/api/auth/callback`, challenge));
}
