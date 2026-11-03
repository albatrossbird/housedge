// Session cookies. The browser never holds a Supabase key or a token it can
// read: both tokens are httpOnly, so page script (and anything injected into
// it) cannot lift them.
export const COOKIE = {
  access: "ms_at",     // Supabase access token (JWT), ~1h
  refresh: "ms_rt",    // Supabase refresh token
  ref: "ms_ref",       // affiliate code from a ?ref= link, 60 days, first touch wins
  pkce: "ms_pkce",     // Google sign-in: the PKCE verifier, 10 minutes
  agree: "ms_agree",   // Google sign-in: the 18+ confirmation, 10 minutes
  next: "ms_next",     // Google sign-in: where to land afterwards
};
export const REFRESH_MAX_AGE = 60 * 24 * 3600;
export const REF_MAX_AGE = 60 * 24 * 3600;

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, path = "/", httpOnly = true, secure = process.env.NODE_ENV === "production", sameSite = "Lax" } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge != null) s += `; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
  if (httpOnly) s += "; HttpOnly";
  if (secure) s += "; Secure";
  return s;
}

// Append rather than overwrite: a response can set several cookies.
export function addCookie(res, cookie) {
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", prev == null ? [cookie] : [].concat(prev, cookie));
}
export const clearCookie = (res, name, path = "/") => addCookie(res, serializeCookie(name, "", { maxAge: 0, path }));
