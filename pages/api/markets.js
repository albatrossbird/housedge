import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  try {
    const [pairsRes, kalshiRes, polyRes] = await Promise.all([
      supabase.from("pairs").select("id, kalshi_id, polymarket_id").limit(3),
      supabase.from("markets").select("id, sport_tag").ilike("id", "KX%").limit(3),
      supabase.from("markets").select("id, slug").not("id", "ilike", "KX%").limit(3),
    ]);

    return res.status(200).json({
      pairs: pairsRes.data,
      pairsError: pairsRes.error?.message,
      kalshi: kalshiRes.data,
      kalshiError: kalshiRes.error?.message,
      poly: polyRes.data,
      polyError: polyRes.error?.message,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
