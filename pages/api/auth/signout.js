// POST -> ends the session here and at Supabase.
import { accountsMode } from "../../../lib/auth/config.js";
import { COOKIE, parseCookies } from "../../../lib/auth/cookies.js";
import { signOut } from "../../../lib/auth/gotrue.js";
import { clearSession, sameOrigin } from "../../../lib/auth/session.js";

export default async function handler(req, res) {
  if (accountsMode() === "off") return res.status(404).json({ error: "not found" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!sameOrigin(req)) return res.status(403).json({ error: "cross-site request refused" });
  const at = parseCookies(req.headers.cookie)[COOKIE.access];
  if (at) await signOut(at);   // best effort: the cookies go regardless
  clearSession(res);
  return res.status(200).json({ signedOut: true });
}
