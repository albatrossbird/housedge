import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  try {
    // Step 1: Just get pairs count to verify connection works
    const { data: pairs, error: pairsError, count } = await supabase
      .from("pairs")
      .select("id, kalshi_id, polymarket_id, similarity", { count: "exact" })
      .limit(5);

    if (pairsError) {
      return res.status(200).json({ 
        step: "pairs query failed",
        error: pairsError.message,
        hint: pairsError.hint,
        details: pairsError.details,
      });
    }

    if (!pairs || pairs.length === 0) {
      return res.status(200).json({ 
        step: "pairs empty",
        count,
        supabaseUrl: process.env.SUPABASE_URL ? "set" : "missing",
        supabaseKey: process.env.SUPABASE_ANON_KEY ? "set" : "missing",
      });
    }

    // Step 2: Try getting one Kalshi market
    const testId = pairs[0].kalshi_id;
    const { data: testMarket, error: marketError } = await supabase
      .from("markets")
      .select("id, title, sport_tag")
      .eq("id", testId)
      .single();

    if (marketError) {
      return res.status(200).json({
        step: "markets query failed",
        testId,
        error: marketError.message,
        pairs: pairs.length,
      });
    }

    // If we get here, both queries work
    return res.status(200).json({
      step: "both queries work",
      pairsCount: pairs.length,
      samplePair: pairs[0],
      sampleMarket: testMarket,
    });

  } catch (err) {
    return res.status(200).json({ 
      step: "exception",
      error: err.message,
      stack: err.stack?.split('\n').slice(0,3),
    });
  }
}
