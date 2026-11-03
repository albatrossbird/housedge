// Profiles and affiliate codes, read and written with the service-role key.
//
// No fallback to the anon key here, unlike lib/v2/db.js: both tables revoke
// anon entirely (migration 0033), so an anon fallback could only ever fail,
// and a missing key should say so by name rather than as a 42501.
import { writeHeaders } from "../supabaseHeaders.js";

const rest = () => `${String(process.env.SUPABASE_URL || "").replace(/\/+$/, "")}/rest/v1`;
function key() {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!k) throw new Error("accounts need SUPABASE_SERVICE_ROLE_KEY (server-side only)");
  return k;
}
export const PROFILE_COLS = "id,email,plan,plan_until,pass_until,referred_by,agreed_18_at,created_at";

async function req(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${rest()}${path}`, { method, headers: writeHeaders(key(), { prefer }), body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`profiles ${method} ${path.split("?")[0]}: HTTP ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// Affiliate codes are shown and typed in capitals; a link may carry any case.
export function normalizeCode(v) {
  const s = String(v ?? "").trim().toUpperCase();
  return /^[A-Z0-9_-]{3,32}$/.test(s) ? s : null;
}

export async function getAffiliate(code) {
  const c = normalizeCode(code);
  if (!c) return null;
  const rows = await req(`/affiliates?code=eq.${encodeURIComponent(c)}&active=is.true&select=code,name,profile_id`);
  return rows?.[0] ?? null;
}

export async function getProfile(id) {
  const rows = await req(`/profiles?id=eq.${encodeURIComponent(id)}&select=${PROFILE_COLS}`);
  return rows?.[0] ?? null;
}

// The affiliate code an account owns, for the account page.
export async function ownCode(profileId) {
  const rows = await req(`/affiliates?profile_id=eq.${encodeURIComponent(profileId)}&active=is.true&select=code`);
  return rows?.[0]?.code ?? null;
}

// The first finished sign-in creates the profile; every later one finds it.
// The referral is decided HERE, once, and never rewritten: a code is kept
// only if it is active and is not the user's own.
export async function ensureProfile(user, { ref = null, agreedAt = null } = {}) {
  const existing = await getProfile(user.id);
  if (existing) return existing;
  let referredBy = null;
  const aff = ref ? await getAffiliate(ref) : null;
  if (aff && aff.profile_id !== user.id) referredBy = aff.code;
  const row = { id: user.id, email: String(user.email || "").toLowerCase(), referred_by: referredBy, agreed_18_at: agreedAt };
  const made = await req(`/profiles?on_conflict=id&select=${PROFILE_COLS}`, { method: "POST", body: [row], prefer: "resolution=ignore-duplicates,return=representation" });
  // An empty answer is a concurrent sign-in that inserted first: read its row.
  return made?.[0] ?? await getProfile(user.id);
}
