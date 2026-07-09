// Standalone script to find individual-game soccer markets on Polymarket.
// Run with: node explore.js

async function findIndividualGames() {
  const allEvents = [];
  let offset = 0;
  const limit = 50;
  let hasMore = true;

  console.log("Paginating through Soccer tag (100350)...\n");

  while (hasMore && offset < 1000) {
    const url = `https://gamma-api.polymarket.com/events?active=true&closed=false&tag_id=100350&limit=${limit}&offset=${offset}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) {
      hasMore = false;
      break;
    }

    allEvents.push(...data);
    console.log(`Fetched offset ${offset}: ${data.length} events (total so far: ${allEvents.length})`);

    if (data.length < limit) hasMore = false;
    offset += limit;
  }

  console.log(`\nTotal events fetched: ${allEvents.length}\n`);

  // Individual matches typically have exactly 3 markets in the event
  // (Team A win / Team B win / Tie) OR exactly 2 (Team A / Team B, no tie markets).
  // Tournament winner events have dozens of markets (one per competing team).
  const individualGames = allEvents.filter(e => {
    const marketCount = (e.markets || []).length;
    return marketCount >= 2 && marketCount <= 4;
  });

  const tournamentFutures = allEvents.filter(e => {
    const marketCount = (e.markets || []).length;
    return marketCount > 4;
  });

  console.log(`Likely individual games (2-4 markets): ${individualGames.length}`);
  console.log(`Likely tournament futures (5+ markets): ${tournamentFutures.length}\n`);

  console.log("=== SAMPLE INDIVIDUAL GAMES ===");
  individualGames.slice(0, 15).forEach(e => {
    console.log(`- ${e.title || e.ticker} (${(e.markets || []).length} markets) [slug: ${e.slug}]`);
  });

  console.log("\n=== SAMPLE TOURNAMENT FUTURES (for comparison) ===");
  tournamentFutures.slice(0, 5).forEach(e => {
    console.log(`- ${e.title || e.ticker} (${(e.markets || []).length} markets)`);
  });
}

findIndividualGames().catch(err => console.error("Error:", err.message));