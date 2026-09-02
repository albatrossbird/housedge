// The non-sports matcher, extracted so the serverless route and the
// GitHub Action run the SAME code.
//
// Politics outgrew Vercel: adding Kalshi's Elections category took the
// category to 12,210 Kalshi rows against 5,458 Polymarket ones, and
// 66M cosine similarities on 1024-dimension vectors does not finish
// inside the 300s function ceiling - the JS matcher and the pgvector
// one both returned no body at all after 4m40s.
//
// A blocking index was tried first and rejected on measurement: scoring
// only pairs that share a content word lost 55 of 208 known-correct
// pairs, because Kalshi says "SOL" where Polymarket says "Solana" and
// "**real GDP**" where it says "US GDP Growth". Those two vocabularies
// not lining up is the reason this project matches on embeddings at
// all, so blocking cannot be made safe here.
//
// So the work moves to a runner with no 300s ceiling instead, and this
// file is what keeps the two callers honest. matchNonSportsMarkets was
// already shared between matchonly and normal mode for exactly this
// reason - they were separately duplicated once and drifted, a
// diagnostic added to one branch missing from the other.

import { scalarSignaturesCompatible } from "./v2/claims.js";
import { POLY_US_PLATFORM } from "./polymarketUs.js";

// ── Cosine similarity ──────────────────────────────────────────
export function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ── Shared embedding-based matcher for non-sports markets ────────
// Used by both matchonly and normal mode so they can't drift apart -
// they duplicated this logic separately for a while this session and
// it caused real bugs (a diagnostic added to one branch and forgotten
// in the other).
// Exclusivity and ordering, shared by both matchers.
//
// Greedy by globally descending score, not by Kalshi row order: when
// several Kalshi rows compete for the same Polymarket market, the
// best-scoring candidate should win it rather than whichever row
// happened to be processed first.
export function assignGreedy(candidates, topScores, threshold, counts = {}) {
  candidates.sort((a, b) => b.score - a.score);

  // A Kalshi market may pair once PER POLYMARKET VENUE, not once
  // overall. polymarket.com and polymarket.us are different exchanges
  // and a US account can only trade the .us one, so letting a single
  // .com match consume the Kalshi row hides the only pair the reader
  // could actually take. That is why 307 ingested and embedded US
  // non-sports markets produced zero pairs: they were not rejected by
  // threshold or by the gate, they simply lost the exclusivity race to
  // a .com candidate that scored higher.
  //
  // The sports join was already one pair per (game, venue); this makes
  // the embedding path agree.
  const usedKalshi = new Set();
  const usedPoly = new Set();
  const venueOf = pm => (pm.platform === POLY_US_PLATFORM ? POLY_US_PLATFORM : "polymarket");
  const newPairs = [];
  const acceptedPairs = [];

  for (const c of candidates) {
    const kalshiSlot = `${c.km.id}|${venueOf(c.pm)}`;
    if (usedKalshi.has(kalshiSlot) || usedPoly.has(c.pm.id)) continue;
    newPairs.push({
      kalshi_id:     c.km.id,
      polymarket_id: c.pm.id,
      similarity:    c.score,
      created_at:    Math.floor(Date.now() / 1000),
    });
    acceptedPairs.push({ score: c.score, kalshi: c.km.title, poly: c.pm.title });
    usedKalshi.add(kalshiSlot);
    usedPoly.add(c.pm.id);
  }

  topScores.sort((a, b) => b.score - a.score);
  acceptedPairs.sort((a, b) => b.score - a.score);

  return {
    newPairs,
    matchDiagnostics: {
      threshold,
      ...counts,
      acceptedPairs: acceptedPairs.slice(0, 100),
      // Uncapped rather than top-10: the head of the list is dominated
      // by one cluster (e.g. GDP buckets), which hides whether other
      // families have real candidates further down.
      topScores,
    },
  };
}

// A stored embedding, as text, into numbers.
//
// The vector column and the JSON column serialise IDENTICALLY — pgvector
// renders `[0.1,0.2,...]`, which is exactly what JSON.stringify produced
// for the array it replaced. embed.js already relies on that in the write
// direction, writing one encoded string to both columns; this is the same
// fact read back.
//
// Kept as a named function rather than an inline JSON.parse because the
// two columns are mid-migration, and a single place to change is the
// difference between one edit and four.
export function parseVector(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v;          // some clients hydrate it already
  let parsed;
  try {
    parsed = JSON.parse(v);
  } catch {
    // Returns null rather than throwing. This runs inside the matching
    // loop over every stored row, so one malformed or empty value must
    // cost that row its candidacy, not the whole category its run. The
    // loss stays visible: kalshiEmbeddedCount counts rows that HAVE a
    // vector, so a gap between that and the candidates built from them
    // is the signal.
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

export function matchNonSportsMarkets(kalshiDb, polyDb, threshold) {
  const polyEmbedded = (polyDb || [])
    .filter(m => m.embedding_v)
    .map(m => ({ ...m, _vec: parseVector(m.embedding_v) }))
    .filter(m => m._vec);

  const topScores = [];
  const candidates = [];

  for (const km of (kalshiDb || [])) {
    if (!km.embedding_v) continue;
    const kVec = parseVector(km.embedding_v);
    if (!kVec) continue;
    let rowBestScore = 0;
    let rowBestPm = null;

    for (const pm of polyEmbedded) {
      if (km.sport_tag !== pm.sport_tag) continue;
      const score = cosineSimilarity(kVec, pm._vec);
      if (score > rowBestScore) {
        rowBestScore = score;
        rowBestPm = pm;
      }
      if (score >= threshold && scalarSignaturesCompatible(km.title, pm.title, km.sport_tag)) {
        candidates.push({ km, pm, score });
      }
    }

    if (rowBestPm) {
      topScores.push({ score: rowBestScore, kalshi: km.title, poly: rowBestPm.title });
    }
  }

  // Greedy by globally descending score, not by Kalshi row order - so
  // when several Kalshi rows compete for the same Polymarket market,
  // the actual best-scoring candidate wins it instead of whichever
  // Kalshi row happened to be processed first.
  return assignGreedy(candidates, topScores, threshold, {
    kalshiEmbeddedCount: (kalshiDb || []).filter(m => m.embedding_v).length,
    polyEmbeddedCount: polyEmbedded.length,
    matcher: "js",
  });
}
