// Supabase Auth over plain HTTP, server-side only.
//
// Not supabase-js: its auth client is built to keep tokens in the BROWSER,
// and here the browser holds nothing but httpOnly cookies. Every call keeps
// the HTTP status, so callers can tell a rejected token (401/403: sign out)
// from an outage (5xx/network: keep the cookies, try again later). Treating
// an outage as a sign-out would log every user out on a Supabase blip.
import { createHash, randomBytes } from "node:crypto";
import { authHeaders } from "../supabaseHeaders.js";

const base = () => `${String(process.env.SUPABASE_URL || "").replace(/\/+$/, "")}/auth/v1`;
const anonKey = () => process.env.SUPABASE_ANON_KEY;

async function call(path, { method = "POST", body, token } = {}) {
  const headers = authHeaders(anonKey(), { "Content-Type": "application/json" });
  if (token) headers.Authorization = `Bearer ${token}`;
  let r;
  try {
    r = await fetch(`${base()}${path}`, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  } catch (e) {
    return { ok: false, status: 0, error: `auth unreachable: ${e.cause?.code || e.name || e.message}` };
  }
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) return { ok: false, status: r.status, error: json?.msg || json?.error_description || json?.message || json?.error || text.slice(0, 200) || `HTTP ${r.status}` };
  return { ok: true, status: r.status, data: json };
}

// A rejected credential, as opposed to an outage.
export const rejected = r => !r.ok && r.status >= 400 && r.status < 500;

// Email a sign-in link (and code). `data` is stored on a NEW user only.
export const sendEmailLink = (email, data = {}) => call("/otp", { body: { email, create_user: true, data } });

// The link's token_hash, or the code typed from the email.
export const verifyTokenHash = (tokenHash, type = "email") => call("/verify", { body: { type, token_hash: tokenHash } });
export const verifyCode = (email, token) => call("/verify", { body: { type: "email", email, token } });

export const refreshSession = refreshToken => call("/token?grant_type=refresh_token", { body: { refresh_token: refreshToken } });
export const exchangeCode = (authCode, codeVerifier) => call("/token?grant_type=pkce", { body: { auth_code: authCode, code_verifier: codeVerifier } });
export const getUser = accessToken => call("/user", { method: "GET", token: accessToken });
export const signOut = accessToken => call("/logout?scope=local", { token: accessToken });

const b64url = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function pkcePair() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}
export function googleAuthorizeUrl(redirectTo, challenge) {
  const q = new URLSearchParams({ provider: "google", redirect_to: redirectTo, code_challenge: challenge, code_challenge_method: "s256" });
  return `${base()}/authorize?${q}`;
}
