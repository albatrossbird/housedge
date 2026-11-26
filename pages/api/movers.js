// GET /api/movers — the home page's "moves" and "most traded" lists.
//
// Reads the `movers` table that scripts/movers.mjs writes on the box
// every 15 minutes; never touches a venue. Public and cached at the edge,
// because it is the same answer for everyone and changes four times an
// hour.
//
// A read that fails is a 502 with the reason, never an empty list:
// "nothing moved today" and "we could not look" must not look alike.
import { authHeaders } from "../../lib/supabaseHeaders.js";
import { shapeMovers } from "../../lib/movers.js";

export default async function handler(req, res) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return res.status(503).json({ error: "not configured" });
  let rows;
  try {
    const r = await fetch(`${url}/rest/v1/movers?select=*&limit=5000`, { headers: authHeaders(key) });
    if (!r.ok) return res.status(502).json({ error: `movers read: HTTP ${r.status}` });
    rows = await r.json();
  } catch (e) {
    return res.status(502).json({ error: `movers read: ${e?.cause?.code || e.message}` });
  }
  res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=600");
  return res.status(200).json(shapeMovers(Array.isArray(rows) ? rows : []));
}
