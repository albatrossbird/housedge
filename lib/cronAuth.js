// Optional shared-secret gate for scheduled endpoints.
//
// /api/refresh and /api/embed are cheap to call but not free: they hit
// Kalshi/Polymarket, write to Supabase, and (for embed) spend Voyage
// tokens. The repo is public, so the schedule and the URLs are public
// too — worth being able to lock them down.
//
// Deliberately permissive when CRON_SECRET is unset, so nothing breaks
// today and the secret can be added later without a code change. Once
// it IS set on Vercel, callers must present it. Vercel's own cron sends
// `Authorization: Bearer $CRON_SECRET` automatically; the GitHub Actions
// workflow sends the same header from a repository secret.
export function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: true, enforced: false };

  const auth = req.headers.authorization || "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : req.query.key;

  // Length-independent compare is overkill for a job trigger, but a
  // plain === leaks length via timing and costs nothing to avoid.
  const a = Buffer.from(String(presented || ""));
  const b = Buffer.from(secret);
  const ok = a.length === b.length && require("crypto").timingSafeEqual(a, b);

  return { ok, enforced: true };
}
