// The embedding series gate. Every case here is a real market id from
// the live catalogue, because the failure this gate risks — a series
// that should match being silently skipped — is exactly the shape of
// bug this project keeps rediscovering.
import { seriesTickerOf, buildSeriesGate, allowEmbed } from "../lib/embedGate.js";

let fail = 0;
const ok = (cond, what) => { if (!cond) { console.error("FAIL:", what); fail++; } };

// ── series parsing ──────────────────────────────────────────────
ok(seriesTickerOf("KXGDP-26OCT30-T3.0") === "KXGDP", "Kalshi ticker -> series");
ok(seriesTickerOf("KXMLBGAME-26AUG271910MILNYM-NYM") === "KXMLBGAME", "sports ticker -> series");
// Polymarket ids are numeric strings. Returning a series for one would
// gate the SCARCE side of every pair.
ok(seriesTickerOf("512345") === null, "Polymarket numeric id has no series");
ok(seriesTickerOf("") === null, "empty id");
ok(seriesTickerOf(null) === null, "null id");
ok(seriesTickerOf("KXGDP") === null, "bare series with no event is not a market ticker");

// ── the gate ────────────────────────────────────────────────────
const gate = buildSeriesGate({
  // KXGDP and KXIPOOPENAI have produced pairs. KXIPOOPENAI is in
  // Kalshi's FINANCIALS category — the category a taxonomy gate would
  // have excluded wholesale, costing 4 of the 21 live econ pairs.
  pairKalshiIds: ["KXGDP-26OCT30-T3.0", "KXIPOOPENAI-26DEC01", "KXMUSKNW-26DEC31-T1.0"],
  // KXTSLAA and KXUST have been embedded and never matched.
  embeddedIds: ["KXGDP-26OCT30-T2.0", "KXTSLAA-26SEP30-T400", "KXUST-26DEC-T4.5",
                "KXIPOOPENAI-26NOV01", "KXMUSKNW-26DEC31-T0.9"],
});

// Proven series keep embedding, including new strikes they have not listed before.
ok(allowEmbed("KXGDP-27MAR31-T1.5", gate), "proven series: a NEW strike is still embedded");
ok(allowEmbed("KXIPOOPENAI-27JAN01", gate), "proven Financials series is not excluded by category");
ok(allowEmbed("KXMUSKNW-27DEC31-T2.0", gate), "proven series, new period");

// Tried and never matched: stop paying for it.
ok(!allowEmbed("KXTSLAA-26DEC31-T500", gate), "tried + unproven single-stock ladder is skipped");
ok(!allowEmbed("KXUST-27MAR-T5.0", gate), "tried + unproven treasury ladder is skipped");

// Never seen: a full first chance, not a sample. Missing the one strike
// in a ladder that has a counterpart is the loss this gate must not cause.
ok(allowEmbed("KXNEWTHING-26DEC01-T1", gate), "unseen series gets its first chance");

// Polymarket is never gated — it is the scarce side every pair is built against.
ok(allowEmbed("512345", gate), "Polymarket row is never gated");
ok(allowEmbed("998877", gate), "second Polymarket row is never gated");

// An empty gate (first ever run, nothing embedded, no pairs) must let
// everything through rather than blocking the whole catalogue.
const empty = buildSeriesGate({});
ok(allowEmbed("KXGDP-26OCT30-T3.0", empty), "empty gate embeds everything");
ok(allowEmbed("KXTSLAA-26SEP30-T400", empty), "empty gate embeds an unproven series too");

console.log(fail === 0
  ? "embed gate: all cases correct"
  : `embed gate: ${fail} FAILING`);
process.exit(fail === 0 ? 0 : 1);
