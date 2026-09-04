// The game join, pinned against real identifiers from both venues.
//
// A wrong pairing here does not look like a bug — it renders as a large
// arbitrage, because one team's Kalshi price ends up beside the other
// team's Polymarket price. That is why the outcome index is a lookup on
// the slug rather than a keyword match, and why this file exists.
import {
  kalshiGameKey, polyGameKey, polyOutcomeIndex, normalizeTeamCode,
  teamNameKey, nameGameKey, kalshiEventOf, kalshiGameDate, polyGameDate,
  outcomeIndexByName,
} from "../lib/sportsKeys.js";

let bad = 0;
const fail = msg => { console.log(`WRONG ${msg}`); bad++; };
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`WRONG ${label}\n  got:  ${g}\n  want: ${w}`); bad++; }
};

// ── Kalshi tickers ───────────────────────────────────────────────
// NFL carries NO start time where MLB does: "26SEP21NYGLAR" against
// "26SEP031940MIAKC". Both must key.
eq(kalshiGameKey("KXNFLGAME-26SEP21NYGLAR-NYG"),
   { key: "2026-09-21|LA+NYG", date: "2026-09-21", side: "NYG" }, "NFL ticker, no time");
eq(kalshiGameKey("KXNFLGAME-26SEP21NYGLAR-LAR"),
   { key: "2026-09-21|LA+NYG", date: "2026-09-21", side: "LA" }, "NFL ticker, Rams side");
eq(kalshiGameKey("KXMLBGAME-26SEP031940MIAKC-MIA"),
   { key: "2026-09-03|KC+MIA", date: "2026-09-03", side: "MIA" }, "MLB ticker, with time");

// Two-letter codes still split off a concatenated blob.
eq(kalshiGameKey("KXNFLGAME-26SEP20INDKC-KC"),
   { key: "2026-09-20|IND+KC", date: "2026-09-20", side: "KC" }, "two-letter side");

// ── The Los Angeles trap ─────────────────────────────────────────
// Polymarket writes the Rams "LA" and the Chargers "LAC". One rule for
// both LA clubs pairs the wrong team.
eq(normalizeTeamCode("LAR"), "LA",  "Rams alias");
eq(normalizeTeamCode("LAC"), "LAC", "Chargers unchanged");
eq(normalizeTeamCode("JAC"), "JAX", "Jaguars alias");

// ── Slugs, both venues ───────────────────────────────────────────
eq(polyGameKey("nfl-sf-la-2026-09-11"),
   { key: "2026-09-11|LA+SF", date: "2026-09-11", codes: ["SF", "LA"] }, "poly.com NFL slug");
eq(polyGameKey("aec-nfl-dal-nyg-2026-09-14"),
   { key: "2026-09-14|DAL+NYG", date: "2026-09-14", codes: ["DAL", "NYG"] }, "poly.us NFL slug");

// ── The join, end to end ─────────────────────────────────────────
// Same game from both venues must produce the same key.
eq(kalshiGameKey("KXNFLGAME-26SEP20WASDAL-WAS").key,
   polyGameKey("nfl-was-dal-2026-09-20").key, "WAS@DAL joins");

// And the Kalshi side must select the RIGHT Polymarket outcome. The
// slug order is the outcome order: outcomes were ["Commanders","Cowboys"]
// on nfl-was-dal-2026-09-20.
eq(polyOutcomeIndex("KXNFLGAME-26SEP20WASDAL-WAS", "nfl-was-dal-2026-09-20"), 0, "WAS -> outcome 0");
eq(polyOutcomeIndex("KXNFLGAME-26SEP20WASDAL-DAL", "nfl-was-dal-2026-09-20"), 1, "DAL -> outcome 1");
// The Rams resolve through the alias, not by luck.
eq(polyOutcomeIndex("KXNFLGAME-26SEP21NYGLAR-LAR", "nfl-nyg-la-2026-09-21"), 1, "LAR -> LA outcome 1");
eq(polyOutcomeIndex("KXNFLGAME-26SEP21NYGLAR-NYG", "nfl-nyg-la-2026-09-21"), 0, "NYG -> outcome 0");

// A futures market has no date and must never join a game.
eq(polyGameKey("nfl-super-bowl-champion-2027"), null, "futures slug does not key");


// ── College football: keyed by NAME, not code ──────────────────
//
// Every case here is from the live slate. CFB is the league that broke
// the code-based join: 178 of 275 Kalshi codes disagree with
// Polymarket's, and three are REUSED for different schools, so no flat
// alias map can be correct at any size.
{
  // The collisions themselves. If these ever normalise to the same
  // string, two different fixtures key to one game and the matcher
  // pairs the wrong teams.
  for (const [a, b] of [
    ["Colorado St.", "Central State (OH) Marauders"],
    ["Kansas St.", "Kentucky State Thorobreds"],
    ["Weber St.", "Webber International Warriors"],
  ]) {
    if (teamNameKey(a) === teamNameKey(b)) {
      fail(`COLLISION: "${a}" and "${b}" normalise to the same key`);
    }
  }

  // The two venues abbreviate differently and neither is wrong.
  eq(teamNameKey("Colorado St."), teamNameKey("Colorado State"), "St. -> State");
  eq(teamNameKey("Southern University"), teamNameKey("Southern"), "University suffix");
  eq(teamNameKey("Alabama A&M"), teamNameKey("Alabama A&M"), "ampersand");

  // Near-misses that MUST stay distinct — a fuzzy token matcher paired
  // all of these wrongly, which is what ruled that approach out.
  for (const [a, b] of [
    ["Michigan", "Eastern Michigan"],
    ["Michigan", "Michigan St."],
    ["Illinois", "Northern Illinois"],
    ["Florida", "Florida International"],
    ["Clemson", "Boston College"],
    ["Iowa St.", "Northern Iowa"],
  ]) {
    if (teamNameKey(a) === teamNameKey(b)) fail(`"${a}" and "${b}" must not collide`);
  }

  // Both Kalshi sides of one game regroup to the same event and key.
  eq(kalshiEventOf("KXNCAAFGAME-26SEP17SYRPITT-SYR"), kalshiEventOf("KXNCAAFGAME-26SEP17SYRPITT-PITT"), "event regroup");
  eq(kalshiGameDate("KXNCAAFGAME-26SEP17SYRPITT-SYR"), "2026-09-17", "kalshi date");

  // CFB codes carry DIGITS ("lcdbfc25"), which the letters-only code
  // pattern rejects — the date has to come out without them.
  eq(polyGameDate("cfb-lcdbfc25-nwst-2026-08-27"), "2026-08-27", "poly date, digits in code");
  eq(polyGameDate("cfb-sjst-emich-2026-09-04"), "2026-09-04", "poly date, plain");

  // Order-independent: Kalshi lists away/home in the ticker blob,
  // Polymarket in the slug, and they do not always agree.
  eq(nameGameKey("2026-09-04", "San Jose State", "Eastern Michigan"),
     nameGameKey("2026-09-04", "Eastern Michigan", "San Jose State"), "key is order independent");
  eq(nameGameKey("2026-09-04", "San Jose State", "Eastern Michigan"),
     nameGameKey("2026-09-04", "San Jose St.", "Eastern Michigan"), "same game across venues");
  eq(nameGameKey("2026-09-05", "San Jose State", "Eastern Michigan") ===
     nameGameKey("2026-09-04", "San Jose State", "Eastern Michigan"), false, "different date is a different game");
  eq(nameGameKey("2026-09-04", "Syracuse", "Syracuse"), null, "a team cannot play itself");

  // The read path picks the Polymarket outcome by name, which is exact
  // where the keyword fallback guesses.
  eq(outcomeIndexByName("Eastern Michigan", ["San Jose State", "Eastern Michigan"]), 1, "outcome index by name");
  eq(outcomeIndexByName("Colorado St.", ["Colorado State", "Utah"]), 0, "outcome index, abbreviated side");
  eq(outcomeIndexByName("Rutgers", ["San Jose State", "Eastern Michigan"]), null, "no match returns null, never a guess");
}

console.log(bad ? `${bad} failing` : "all sports-key cases correct");
process.exit(bad ? 1 : 0);
