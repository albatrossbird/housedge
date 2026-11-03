// POST { code } -> remembers an affiliate code for 60 days.
//
// FIRST TOUCH WINS: a valid code already held is not replaced, so the
// creator who sent someone first is the one credited. Only an active code
// that exists is stored, so a mistyped one cannot block a real one later.
import { accountsMode } from "../../../lib/auth/config.js";
import { COOKIE, REF_MAX_AGE, addCookie, parseCookies, serializeCookie } from "../../../lib/auth/cookies.js";
import { getAffiliate, normalizeCode } from "../../../lib/auth/profiles.js";
import { sameOrigin } from "../../../lib/auth/session.js";

export default async function handler(req, res) {
  if (accountsMode() === "off") return res.status(404).json({ error: "not found" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!sameOrigin(req)) return res.status(403).json({ error: "cross-site request refused" });
  const held = normalizeCode(parseCookies(req.headers.cookie)[COOKIE.ref]);
  if (held) return res.status(200).json({ ref: held, kept: true });
  const code = normalizeCode(req.body?.code);
  if (!code) return res.status(400).json({ error: "not a code" });
  let aff;
  try { aff = await getAffiliate(code); } catch (e) { return res.status(502).json({ error: e.message }); }
  if (!aff) return res.status(404).json({ error: "unknown code" });
  addCookie(res, serializeCookie(COOKIE.ref, aff.code, { maxAge: REF_MAX_AGE }));
  return res.status(200).json({ ref: aff.code });
}
