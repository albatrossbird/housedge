// POST { email, agree: true, next? } -> emails a sign-in link and a code.
import { accountsMode, emailAllowed, isEmail } from "../../../lib/auth/config.js";
import { COOKIE, parseCookies } from "../../../lib/auth/cookies.js";
import { sendEmailLink } from "../../../lib/auth/gotrue.js";
import { normalizeCode } from "../../../lib/auth/profiles.js";
import { sameOrigin } from "../../../lib/auth/session.js";

export default async function handler(req, res) {
  if (accountsMode() === "off") return res.status(404).json({ error: "not found" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!sameOrigin(req)) return res.status(403).json({ error: "cross-site request refused" });
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (req.body?.agree !== true) return res.status(400).json({ error: "Please confirm you are 18 or older." });
  if (!emailAllowed(email)) return res.status(403).json({ error: "MarketSlap accounts are not open yet." });
  // Carried on the NEW user, so a link opened on another device still knows
  // who referred them and when they confirmed their age.
  const ref = normalizeCode(parseCookies(req.headers.cookie)[COOKIE.ref]);
  const r = await sendEmailLink(email, { agreed_18_at: new Date().toISOString(), ...(ref ? { ref } : {}) });
  if (!r.ok) {
    if (r.status === 429) return res.status(429).json({ error: "Too many sign-in emails. Wait a minute and try again." });
    return res.status(r.status >= 400 && r.status < 500 ? 400 : 502).json({ error: `Could not send the email (${r.error}).` });
  }
  return res.status(200).json({ sent: true });
}
