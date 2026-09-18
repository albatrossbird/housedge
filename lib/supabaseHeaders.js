// Auth headers for a Supabase REST call, correct for BOTH key formats.
//
// WHY THIS IS NOT JUST `{ apikey, Authorization }`.
//
// Every call site in this repo sent the key twice:
//
//   { apikey: KEY, Authorization: `Bearer ${KEY}` }
//
// which is right for a legacy JWT (`anon` / `service_role`) and wrong
// for the keys that replace them. Supabase's new keys are opaque
// strings — `sb_publishable_...` and `sb_secret_...` — not JWTs, and
// their docs are explicit that a secret key goes on the `apikey` header
// ONLY: the Authorization check is accepted for migration compatibility
// but authenticates nothing, because there is no JWT for anything
// downstream to verify.
//
// THIS MATTERS NOW RATHER THAN IN 2026. Legacy keys can no longer be
// rotated — Supabase removed that — so the only way to retire a leaked
// `service_role` key is to create new-format keys and disable the
// legacy ones. That migration is therefore forced by any leak, and it
// would have broken 24 call sites the moment it happened.
//
// Detection is on the documented prefix rather than on JWT shape,
// because a malformed JWT should still be SENT as one and fail loudly
// as a bad key, not be silently reclassified.
export function isNewFormatKey(key) {
  return /^sb_(publishable|secret)_/.test(String(key || ""));
}

export function authHeaders(key, extra = {}) {
  const k = String(key || "");
  return isNewFormatKey(k)
    ? { apikey: k, ...extra }
    : { apikey: k, Authorization: `Bearer ${k}`, ...extra };
}

// The same, for the write paths that also set content type and Prefer.
export function writeHeaders(key, { prefer, contentType = "application/json" } = {}) {
  return authHeaders(key, {
    "Content-Type": contentType,
    ...(prefer ? { Prefer: prefer } : {}),
  });
}
