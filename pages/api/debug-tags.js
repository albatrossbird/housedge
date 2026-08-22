// Throwaway diagnostic route — delete once the real econ/crypto/politics
// tag IDs are found and POLY_TAGS in embed.js is updated. Polymarket
// doesn't publish a fixed tag_id list; the only way to find them is to
// page through /tags and match on label/slug, which this does so it can
// run from Vercel (this sandbox can't reach gamma-api.polymarket.com
// directly to do it here).
export default async function handler(req, res) {
  const keywords = (req.query.q || "unemployment,jobs,payroll,nonfarm,pce,cpi,consumer price,interest rate,rate cut,rate decision,jobless,labor")
    .toLowerCase()
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const matches = [];
  const LIMIT = 100;
  const MAX_PAGES = 40; // up to 4000 tags

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * LIMIT;
      const r = await fetch(`https://gamma-api.polymarket.com/tags?limit=${LIMIT}&offset=${offset}`);
      if (!r.ok) break;
      const data = await r.json();
      const tags = Array.isArray(data) ? data : data.tags || [];
      if (!tags.length) break;

      for (const t of tags) {
        const label = (t.label || t.name || "").toLowerCase();
        const slug = (t.slug || "").toLowerCase();
        if (keywords.some(k => label.includes(k) || slug.includes(k))) {
          matches.push({ id: t.id, label: t.label || t.name, slug: t.slug });
        }
      }

      if (tags.length < LIMIT) break;
    }

    res.status(200).json({ keywords, count: matches.length, matches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
