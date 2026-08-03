import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  try {
    const { data: pairs } = await supabase
      .from("pairs")
      .select("id, kalshi_id, polymarket_id")
      .limit(3);

    const firstKalshiId = pairs?.[0]?.kalshi_id;
    const firstPolyId = pairs?.[0]?.polymarket_id;

    const { data: kalshiCheck } = await supabase
      .from("markets")
      .select("id, sport_tag")
      .eq("id", firstKalshiId)
      .single();

    const { data: polyCheck } = await supabase
      .from("markets")
      .select("id, slug")
      .eq("id", firstPolyId)
      .single();

    const { data: sportTagCheck } = await supabase
      .from("markets")
      .select("id, sport_tag")
      .in("sport_tag", ["mlb", "soccer"])
      .limit(3);

    return res.status(200).json({
      firstPair: pairs?.[0],
      kalshiLookup: kalshiCheck,
      polyLookup: polyCheck,
      sportTagSample: sportTagCheck,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
