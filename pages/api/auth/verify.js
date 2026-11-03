// POST { token_hash, type } (from the emailed link) or { email, code }
// (typed from the email) -> signs in, sets the httpOnly session cookies.
//
// The link lands on a PAGE (/auth/confirm) with a button that posts here,
// rather than signing in on the GET itself: mail scanners open every link
// in an email, and a GET that spent the token would leave the person who
// clicks it with "link expired".
import { accountsMode, isEmail } from "../../../lib/auth/config.js";
import { COOKIE, parseCookies } from "../../../lib/auth/cookies.js";
import { verifyTokenHash, verifyCode } from "../../../lib/auth/gotrue.js";
import { finishSignIn, sameOrigin } from "../../../lib/auth/session.js";

const TYPES = new Set(["email", "magiclink", "signup"]);

export default async function handler(req, res) {
  if (accountsMode() === "off") return res.status(404).json({ error: "not found" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!sameOrigin(req)) return res.status(403).json({ error: "cross-site request refused" });
  const b = req.body || {};
  let r;
  if (typeof b.token_hash === "string" && b.token_hash) {
    r = await verifyTokenHash(b.token_hash, TYPES.has(b.type) ? b.type : "email");
  } else {
    const email = String(b.email || "").trim().toLowerCase();
    const code = String(b.code || "").replace(/\s+/g, "");
    if (!isEmail(email) || !/^\d{6,10}$/.test(code)) return res.status(400).json({ error: "Enter the code from the email." });
    r = await verifyCode(email, code);
  }
  if (!r.ok) {
    const expired = r.status >= 400 && r.status < 500;
    return res.status(expired ? 400 : 502).json({ error: expired ? "That link or code has expired or was already used. Request a new one." : `Sign-in failed (${r.error}).` });
  }
  try {
    const done = await finishSignIn(res, r.data, { ref: parseCookies(req.headers.cookie)[COOKIE.ref] });
    if (!done.ok) return res.status(done.status).json({ error: done.error });
    return res.status(200).json({ signedIn: true, email: done.user.email });
  } catch (e) {
    return res.status(500).json({ error: `Signed in, but the account could not be set up (${e.message}).` });
  }
}
