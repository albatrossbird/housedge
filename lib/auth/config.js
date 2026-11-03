// Accounts: the feature flag, the allowlist, and where the site lives.
//
// ACCOUNTS_MODE
//   off      (default, or anything unrecognised) — nothing changes: no sign-in,
//            every page and API answers exactly as before accounts existed.
//   preview  sign-in works ONLY for emails in ACCOUNTS_ALLOWLIST. The public
//            sports board stays whole; a signed-in tester sees it as their
//            plan would. This is how the gating is tried on production
//            without locking anything for anyone else.
//   on       anyone can sign in, and the public sports board is the free view.
//
// ACCOUNTS_ALLOWLIST  comma-separated emails, case-insensitive (preview only).
// SITE_URL            e.g. https://marketslap.com — where sign-in links and
//                     Google return to. Falls back to the request's host,
//                     which is right for local dev; Supabase also refuses a
//                     redirect that is not on its own allowed list.
export function accountsMode(env = process.env) {
  const m = String(env.ACCOUNTS_MODE || "off").trim().toLowerCase();
  return m === "preview" || m === "on" ? m : "off";
}

export function allowlist(env = process.env) {
  return new Set(String(env.ACCOUNTS_ALLOWLIST || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
}

// May this email have a session at all, under the current mode?
export function emailAllowed(email, env = process.env) {
  const mode = accountsMode(env);
  if (mode === "on") return true;
  if (mode === "preview") return allowlist(env).has(String(email || "").trim().toLowerCase());
  return false;
}

export function siteUrl(req, env = process.env) {
  if (env.SITE_URL) return env.SITE_URL.replace(/\/+$/, "");
  const proto = String(req?.headers?.["x-forwarded-proto"] || "http").split(",")[0];
  return `${proto}://${req?.headers?.host || "localhost:3000"}`;
}

// Only a path on this site may be a post-sign-in destination: "//evil.com"
// and "https://evil.com" are open redirects.
export function safeNext(v, fallback = "/sports") {
  const s = typeof v === "string" ? v : "";
  return /^\/(?![/\\])[^\s]*$/.test(s) ? s : fallback;
}

export const isEmail = s => typeof s === "string" && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
