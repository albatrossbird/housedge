import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  
  if (!url || !key) {
    return res.status(200).json({
      error: "Missing env vars",
      hasUrl: !!url,
      hasKey: !!key,
    });
  }

  const supabase = createClient(url, key);
  
  const { data, error } = await supabase
    .from("pairs")
    .select("id")
    .limit(3);

  return res.status(200).json({
    hasUrl: !!url,
    hasKey: !!key,
    data,
    error: error?.message,
  });
}
