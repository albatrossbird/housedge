// Labeled pair decisions for evaluating extraction quality.
//
// PROVENANCE MATTERS HERE. Every case tagged `observed: true` is a real
// (Kalshi, Polymarket) pair that this project's matcher actually
// produced and that was verified by hand during the audits — the
// rejections are all false positives the regex gate let through at some
// point and needed patching for. They are the cases that cost real
// debugging time, which makes them the right bar for a replacement.
//
// Cases tagged `observed: false` are constructed paraphrases. The real
// data is badly imbalanced (1 verified true match vs many verified
// false ones) because genuine cross-venue overlap in econ is rare, so
// without these a model that rejected everything would score ~90%.
// They test the true-positive direction and are clearly marked so
// nobody mistakes them for observed data.

export const PAIR_CASES = [
  // ── should ACCEPT ──────────────────────────────────────────────
  {
    id: "gdp-q3-3.0-real",
    observed: true,
    expect: "accept",
    note: "The one genuine econ match found across 163 Kalshi econ markets.",
    kalshi: "Will **real GDP** increase by more than 3.0% in Q3 2026? — Above 3.0%",
    poly: "Will US GDP growth in Q3 2026 be greater than 3.0%?",
  },
  {
    id: "gdp-q3-2.0-paraphrase",
    observed: false,
    expect: "accept",
    note: "Constructed paraphrase — same claim, different wording.",
    kalshi: "Will **real GDP** increase by more than 2.0% in Q3 2026? — Above 2.0%",
    poly: "Will US GDP growth in Q3 2026 be greater than 2.0%?",
  },
  {
    id: "cpi-oct-paraphrase",
    observed: false,
    expect: "accept",
    note: "Constructed — CPI month claim restated.",
    kalshi: "Will CPI rise more than 0.3% in October 2026? — Above 0.3%",
    poly: "Will US CPI increase by over 0.3% in October 2026?",
  },
  {
    id: "fed-sep-4.25-paraphrase",
    observed: false,
    expect: "accept",
    note: "Constructed — Fed rate level restated with FOMC phrasing.",
    kalshi: "Will the upper bound of the federal funds rate be above 4.25% following the Fed's Sep 16, 2026 meeting? — Above 4.25%",
    poly: "Will the Fed funds rate upper bound exceed 4.25% after the September 2026 FOMC meeting?",
  },

  // ── should REJECT — all observed false positives ───────────────
  {
    id: "gdp-wrong-threshold-bucket",
    observed: true,
    expect: "reject",
    note: "Wrong threshold: gt 3.0 vs the 1.0-1.5 bucket. Scored 0.881.",
    kalshi: "Will **real GDP** increase by more than 3.0% in Q3 2026? — Above 3.0%",
    poly: "Will US GDP growth in Q3 2026 be between 1.0% and 1.5%?",
  },
  {
    id: "gdp-wrong-period-and-threshold",
    observed: true,
    expect: "reject",
    note: "Q4 vs full-year AND 1.5 vs 2.5. Scored 0.891.",
    kalshi: "Will **real GDP** increase by more than 1.5% in Q4 2026? — Above 1.5%",
    poly: "Will US GDP growth in 2026 be greater than 2.5%?",
  },
  {
    id: "cpi-vs-gdp",
    observed: true,
    expect: "reject",
    note: "Different indicator entirely — CPI vs GDP. Still scored 0.786.",
    kalshi: "Will CPI rise more than 0.3% in October 2026? — Above 0.3%",
    poly: "Will US GDP growth in Q3 2026 be greater than 3.0%?",
  },
  {
    id: "fed-level-vs-hike-count",
    observed: true,
    expect: "reject",
    note: "Rate LEVEL vs number of HIKES. Correlated, not the same bet. Scored 0.878.",
    kalshi: "Will the upper bound of the federal funds rate be above 5.25% following the Fed's Dec 9, 2026 meeting? — Above 5.25%",
    poly: "Will 5 or more Fed rate hikes happen in 2026?",
  },
  {
    id: "gdp-us-vs-uk",
    observed: true,
    expect: "reject",
    note: "Same threshold and quarter, different country. Scored 0.888.",
    kalshi: "Will **real GDP** increase by more than 1.0% in Q3 2026? — Above 1.0%",
    poly: "Will UK GDP growth in Q3 2026 be at least 1.0%?",
  },
  {
    id: "fed-vs-ecb-bps",
    observed: true,
    expect: "reject",
    note: "US Fed level vs ECB bps change. Names no country — regex missed it. Scored 0.839.",
    kalshi: "Will the upper bound of the federal funds rate be above 2.75% following the Fed's Oct 28, 2026 meeting? — Above 2.75%",
    poly: "Will the ECB announce a 25 bps increase at the October 2026 meeting?",
  },
  {
    id: "fed-vs-boe",
    observed: true,
    expect: "reject",
    note: "US Fed vs Bank of England. Scored 0.816.",
    kalshi: "Will the upper bound of the federal funds rate be above 2.75% following the Fed's Dec 9, 2026 meeting? — Above 2.75%",
    poly: "Bank of England increases interest rates by 25 bps after November 2026 meeting?",
  },
  {
    id: "fed-vs-jgb-yield",
    observed: true,
    expect: "reject",
    note: "Policy rate vs Japanese bond yield. \\bjapan\\b does not match 'Japanese'. Scored 0.783.",
    kalshi: "Will the upper bound of the federal funds rate be above 3.00% following the Fed's Sep 16, 2026 meeting? — Above 3.00%",
    poly: "Will the 10-year Japanese government bond yield on the last reported day of 2026 be at least 3.0%?",
  },
  {
    id: "gdp-us-vs-mexico",
    observed: true,
    expect: "reject",
    note: "Same threshold and quarter, different country. Scored 0.846.",
    kalshi: "Will **real GDP** increase by more than 3.5% in Q3 2026? — Above 3.5%",
    poly: "Will Mexico GDP growth in Q3 2026 be at least 3.5%?",
  },
  {
    id: "gdp-us-vs-germany-direction",
    observed: true,
    expect: "reject",
    note: "Different country AND opposite comparator. Scored 0.808.",
    kalshi: "Will **real GDP** increase by more than 0.5% in Q3 2026? — Above 0.5%",
    poly: "Will Germany GDP growth in Q3 2026 be less than or equal to 0.0%?",
  },
  {
    id: "gdp-us-vs-eurozone",
    observed: true,
    expect: "reject",
    note: "US vs Eurozone at the same threshold. Scored 0.868.",
    kalshi: "Will **real GDP** increase by more than 2.0% in Q3 2026? — Above 2.0%",
    poly: "Will Eurozone GDP growth in Q3 2026 be at least 2.0%?",
  },
  {
    id: "fed-cuts-vs-hikes",
    observed: true,
    expect: "reject",
    note: "Same unit, same count, opposite direction. Produced once per N from 0 to 4. Scored 0.833.",
    kalshi: "Will the Fed cut rates 1 times? \u2014 Exactly 1 cut",
    poly: "Will 1 Fed rate hike happen in 2026?",
  },
  {
    id: "fed-zero-cuts-vs-zero-hikes",
    observed: true,
    expect: "reject",
    note: "Same, at zero \u2014 'no rate hikes' vs 'exactly 0 cuts'. Scored 0.857.",
    kalshi: "Will the Fed cut rates 0 times? \u2014 Exactly 0 cuts",
    poly: "Will no Fed rate hikes happen in 2026?",
  },
  {
    id: "gdp-threshold-vs-untitled-bucket-set",
    observed: true,
    expect: "reject",
    note: "Polymarket's parent market names no threshold; six Kalshi thresholds all paired to it because 'Q3' read as an unparsed value. Scored 0.849-0.856.",
    kalshi: "Will **real GDP** increase by more than 1.5% in Q3 2026? \u2014 Above 1.5%",
    poly: "US GDP Growth in Q3 2026?",
  },
  {
    id: "net-worth-strike-vs-no-strike",
    observed: true,
    expect: "reject",
    note: "Three Kalshi strikes paired to one strikeless Polymarket market because 'December 31' read as an unparsed value. Scored 0.834-0.843.",
    kalshi: "Will Elon Musk's net worth for December 31, 2026 be above $900 billion? \u2014 Above $900 billion",
    poly: "What Will Elon's Net Worth Hit By December 31?",
  },
  {
    id: "gdp-bucket-span-mismatch",
    observed: true,
    expect: "reject",
    note: "Kalshi's bare '2.6% to 3.0%' span parsed to nothing, so it had no signature to disagree with. Scored 0.841.",
    kalshi: "GDP growth in 2026? \u2014 2.6% to 3.0%",
    poly: "Will US GDP growth in 2026 be between 2.0% and 2.5%?",
  },
  {
    id: "gdp-bucket-span-kalshi-edge",
    observed: true,
    expect: "accept",
    note: "Same bucket: Kalshi labels it by its first included value, Polymarket by the boundary. The low edges are 0.1 apart on purpose.",
    kalshi: "GDP growth in 2026? \u2014 1.1% to 1.5%",
    poly: "Will US GDP growth in 2026 be between 1.0% and 1.5%?",
  },
  {
    id: "economy-regime-vs-fed-action",
    observed: true,
    expect: "reject",
    note: "No threshold, period or deadline on either side \u2014 only the metric separates them. Scored 0.816.",
    kalshi: "State of the economy at the end of 2026? \u2014 Slack / disinflation",
    poly: "Fed Rate Hike in 2026?",
  },
  {
    id: "gdp-us-vs-world",
    observed: true,
    expect: "reject",
    note: "US quarterly vs world annual. Scored 0.861.",
    kalshi: "Will **real GDP** increase by more than 3.5% in Q4 2026? — Above 3.5%",
    poly: "Will world GDP growth be 3.4% in 2026?",
  },
];

export const EXPECTED_ACCEPTS = PAIR_CASES.filter(c => c.expect === "accept").length;
export const EXPECTED_REJECTS = PAIR_CASES.filter(c => c.expect === "reject").length;
