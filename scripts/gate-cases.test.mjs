import { scalarSignaturesCompatible as ok } from "../lib/v2/claims.js";

// Titles copied verbatim from the run-3 dry output.
const REJECT = [
  ["When will OpenAI IPO? — Before Jun 1, 2027", "OpenAI IPO Officially Confirmed By — June 30, 2027", "econ"],
  ["When will OpenAI IPO? — Before Sep 1, 2026", "OpenAI IPO Officially Confirmed By — September 30, 2026", "econ"],
  ["When will OpenAI IPO? — Before Dec 1, 2026", "OpenAI IPO Officially Confirmed By — December 31, 2026", "econ"],
  ["When will OpenAI IPO? — Before Oct 1, 2026", "OpenAI IPO Officially Confirmed By — October 31, 2026", "econ"],
  ["When will OpenAI IPO? — Before Aug 1, 2026", "OpenAI IPO Officially Confirmed By — August 31, 2026", "econ"],
  ["When will OpenAI IPO? — Before Nov 1, 2026", "OpenAI IPO Officially Confirmed By — November 30, 2026", "econ"],
  ["When will Anthropic officially announce an IPO? — Before Dec 1, 2026", "Anthropic IPO Officially Confirmed By — December 31, 2026", "econ"],
  ["When will Anthropic officially announce an IPO? — Before Aug 1, 2026", "Anthropic IPO Officially Confirmed By — June 30, 2026", "econ"],
  ["Will Tesla Inc. report Above 1.7 million total deliveries in 2026?", "Tesla Q3 Total Deliveries? — Above 500k", "econ"],
  ["Will Tesla Inc. report Above 1.5 million total deliveries in 2026?", "Tesla Q3 Total Deliveries? — Above 450k", "econ"],
  ["Will Tesla Inc. report Above 1.9 million total deliveries in 2026?", "Tesla Q3 Total Deliveries? — Above 490k", "econ"],
  ["Will Musk have a net worth more than 1500 billion dollars before Dec 31, 2026?", "What Will Elon's Net Worth Hit By December 31? — $2T", "econ"],
];

// Every pair verified correct in this file's audit history.
// Politics: Kalshi's Elections category against Polymarket's. Every
// REJECT here was accepted by a real dry run and read wrong by hand.
const REJECT_POL = [
  // ── Live on the site until it was measured ────────────────────
  // Each of these was RENDERING as a card, with the two venues shown
  // disagreeing by 35 to 86 points. The gap was the evidence; the
  // titles are the finding.
  //
  // A claim and its exact complement, 0.908 apart to an embedding and
  // priced 7% against 92%.
  ["Volodymyr Zelenskyy and Vladimir Putin meet before Jan 1, 2027? — Before 2027",
   "Will Zelenskyy and Putin not meet before 2027?"],
  // Every word that carries meaning is shared except the one that
  // reverses it. 0.913, priced 6% against 77%.
  ["Red wave in 2026? — Yes", "Blue wave in 2026?"],
  // Same number, same party, same chamber, different country-sized
  // scope. statesNamed() saw a state on one side and nothing on the
  // other, which the asymmetry rule reads as missing rather than as
  // "all of them".
  ["Will Democrats win exactly 5 seats in the 2026 U.S. House of Representatives elections?",
   "How Many House Seats Will The Democrats Win In Arizona? — 5"],
  ["Will Democrats win exactly 48 seats in the 2026 U.S. House of Representatives elections?",
   "How Many House Seats Will The Democrats Win In California? — 48"],
  // Opposing parties for the same seat are opposite bets.
  ["Will Republicans win the U.S. Senate in 2026? — Republican Party",
   "Will Democrats win the U.S. Senate in 2026?"],

  // Wrong district, wrong state, wrong chamber.
  ["Will Republican win the House race for RI-02? — Republican party", "Will the Republican Party win the CT-02 House seat?"],
  ["Will Democratic win the House race for MI-13? — Donavan McKinney", "Will the Democratic Party win the MI-10 House seat?"],
  ["Will Democrats win the Senate race in Pennsylvania? — Democratic party", "Will the Democratic Party win the PA-10 House seat?"],
  ["Will the Republican party win the governorship in West Virginia — Republican", "Will the Republicans win the West Virginia Senate race in 2026?"],
  // Wrong party — "another party" is close to the opposite bet.
  ["Will Republican win the House race for TX-34? — Eric Flores", "Will another party win the TX-34 House seat?"],
  // A stage of a race is not the race.
  ["Who will run for the Republican presidential nomination in 2028? — J.D. Vance", "Will J.D. Vance win the 2028 Republican presidential nomination?"],
  ["Will Raphaël Glucksmann qualify for the runoff in the 2027 French presidential election? — Raphaël Glucksmann", "Will Raphaël Glucksmann win the 2027 French presidential election?"],
  ["Will Ron DeSantis win the 2028 Iowa Republican caucus? — Ron DeSantis", "Will Ron DeSantis win the 2028 Republican presidential nomination?"],
  ["Will CO-04 have the smallest margin of victory in the November 3, 2026 U.S. House general elections? — CO-04", "Will the Republican Party win the CO-04 House seat?"],
  ["Will Greg Abbott be the nominee for the Presidency for the Republican party? — Greg Abbott", "Will Greg Abbott announce a presidential run before 2027?"],
  ["Will Jamie Dimon be the Democratic Presidential nominee in 2028? — Jamie Dimon", "Will Jamie Dimon win the 2028 US Presidential Election?"],
  ["Will Likud be a part of the next government in Israel? — Likud", "Will Benjamin Netanyahu be the next Prime Minister of Israel?"],
  // A parlay is not one of its legs.
  ["Will Kansas Governor winner be Democratic party and Kansas Senate winner be Democratic party? — Democrats sweep", "Will the Democrats win the Kansas governor race in 2026?"],
  // Different person. The name gate was inert on every "Will <Name> ..."
  // title, which is how these scored 0.90+ and went through.
  ["Will Bruno Le Maire win the 2027 French presidential election? — Bruno Le Maire", "Will François Baroin win the 2027 French presidential election?"],
  ["Will Bezalel Smotrich be the next Prime Minister of Israel? — Bezalel Smotrich", "Will Moshe Feiglin be the next Prime Minister of Israel?"],
  // A placeholder is not a person.
  ["Will Democratic win the House race for NC-1? — Don Davis", "Will Candidate Q win the Alaska Senate race in 2026?"],

  // Found in the second dry run, after the greedy assignment re-opened
  // counterparties that the first round's rejections had freed.
  ["Will Tim Scott be the nominee for the Vice Presidency for the Republican party? — Tim Scott", "Will Tim Scott win the 2028 Republican presidential nomination?"],
  ["Will Elon Musk be the nominee for the Vice Presidency for the Republican party? — Elon Musk", "Will Elon Musk rejoin the Trump Administration in 2026?"],
  ["Will the Democratic party win the Attorney General race in Wisconsin? — Democratic party", "Will the Democrats win the Wisconsin governor race in 2026?"],
  ["Will Democrats win more than 2 seats in the 2026 U.S. House of Representatives elections in Utah? — 2", "Will the Democratic Party win the UT-02 House seat?"],
  ["Who will win the Texas House of Representatives? — Democratic", "How Many House Seats Will The Democrats Win In Texas?"],
  ["Will Democrats win Iowa? — Iowa", "How Many House Seats Will The Democrats Win In Iowa?"],
  ["Will Andy Beshear and JD Vance be the 2028 Democratic and Republican nominees? — Andy Beshear and JD Vance", "Will Andy Beshear win the 2028 US Presidential Election?"],
  ["Will Donald Trump endorse J.D. Vance in the 2028 presidential election before Mar 1, 2028? — J.D. Vance", "Will JD Vance win the 2028 US Presidential Election?"],
  ["Will Latvia First win the 2026 Latvia parliamentary elections? — Latvia First", "Will Party L win the most seats in the 2026 Latvian parliamentary election?"],
  ["Will the Democratic party win the House in 2028? — Democratic party", "Will Party D win the 2028 US Presidential Election?"],
  // Bands, both venues slicing the same quantity and neither the same way.
  ["Will the Republican Party win 198-202 seats  in the 120th Congress? — 198-202", "Will the Republican Party hold between 195 and 199 House seats after the 2026 midterm elections?"],
  ["Will the Republican Party win 233-237 seats  in the 120th Congress? — 233-237", "Will the Republican Party hold 230 or more House seats after the 2026 midterm elections?"],
  ["Will the total 2026 U.S. House turnout be between 115 and 119.99 million? — 115 to 119.99 million", "2026 Midterms: House Turnout — 110-115 Million"],
  ["Will Democrats win exactly 49 seats in the 2026 U.S. House of Representatives elections in California? — 49", "How Many House Seats Will The Democrats Win In California? — 49+"],
  ["Will exactly 3 governors lose re-election in 2026? — Exactly 3", "Will the Republican Party hold exactly 30 or 31 governorships after the 2026 elections?"],
  ["Will the difference between the number of Republican governors and the number of Democratic governors be 4? — 4", "Will the Republican Party hold exactly 26 or 27 governorships after the 2026 elections?"],
  ["Will Greens win the next election to the German Bundestag? — Greens", "Will Grüne win the most seats in the 2026 Berlin state elections?"],
  // Third round: winning a chamber is not winning the popular vote,
  // and "more than 12" is 13 or more.
  ["Will Democrats win the House in 2026? — Democratic Party", "2026 Midterms: House Popular Vote Winner? — Democratic Party"],
  ["Will Republicans win the 2026 U.S. House of Representatives national popular vote? — Republicans win", "Will the Republican Party hold below 190 House seats after the 2026 midterm elections?"],
  ["Will Democrats win more than 12 seats in the 2026 U.S. House of Representatives elections in Pennsylvania? — Above 12", "How Many House Seats Will The Democrats Win In Pennsylvania? — 12+"],
];

const ACCEPT_POL = [
  // Kalshi labels a district market with its CANDIDATE where Polymarket
  // names the PARTY. Same claim, two levels of description — and the
  // surnames here are the ones an internal capital breaks.
  ["Will Democratic win the House race for GA-06? — Lucy McBath", "Will the Democratic Party win the GA-06 House seat?"],
  ["Will Democratic win the House race for CT-03? — Rosa DeLauro", "Will the Democratic Party win the CT-03 House seat?"],
  ["Will Republican win the House race for IL-16? — Darin LaHood", "Will the Republican Party win the IL-16 House seat?"],
  ["Will the total 2026 U.S. House turnout be between 110 and 114.99 million? — 110 to 114.99 million", "2026 Midterms: House Turnout — 110-115 Million"],
  // The same convention, correctly aligned: Kalshi closes a band one
  // tick below the boundary Polymarket writes.
  ["Will the total 2026 U.S. House turnout be between 100 and 104.99 million? — 100 to 104.99 million", "2026 Midterms: House Turnout — 100-105 Million"],
  ["Will the total 2026 U.S. House turnout be between 105 and 109.99 million? — 105 to 109.99 million", "2026 Midterms: House Turnout — 105-110 Million"],
  ["Will the Republican party hold exactly 56 Senate seats in the 120th Congress? — 56", "Will the Republican Party hold exactly 56 Senate seats after the 2026 midterm elections?"],
  ["Will Romeu Zema qualify for the runoff in the 2026 Brazilian presidential election? — Romeu Zema", "Will Romeu Zema qualify for Brazil's presidential runoff?"],
  ["Will Republicans win the Senate race in South Dakota? — Republican party", "Will the Republicans win the South Dakota Senate race in 2026?"],
  ["Will Republican win the House race for LA-03? — Republican party", "Will the Republican Party win the LA-03 House seat?"],
  ["Will Pete Buttigieg be the Democratic Presidential nominee in 2028? — Pete Buttigieg", "Will Pete Buttigieg win the 2028 Democratic presidential nomination?"],
  ["Will Josh Hawley be the nominee for the Presidency for the Republican party? — Josh Hawley", "Will Josh Hawley win the 2028 Republican presidential nomination?"],
  ["Will Kamala Harris be the Democratic Presidential nominee in 2028? — Kamala Harris", "2028 Democratic Presidential Nominee — Kamala Harris"],
  ["Will Democrats win exactly 46 seats in the 2026 U.S. House of Representatives elections in California? — 46", "How Many House Seats Will The Democrats Win In California? — 46"],
  ["Will François Ruffin win the 2027 French presidential election? — François Ruffin", "Will François Ruffin win the 2027 French presidential election?"],
  ["Will Itamar Ben-Gvir be the next Prime Minister of Israel? — Itamar Ben-Gvir", "Will Itamar Ben Gvir be the next Prime Minister of Israel?"],
  ["Will Roger Ver receive a presidential pardon before Jan 1, 2027? — Roger Ver", "Will Trump pardon Roger Ver before 2027?"],
  ["Will Kari Lake be the next White House Press Secretary of United States? — Kari Lake", "Next White House Press Secretary? — Kari Lake"],
  ["Will Pete Hegseth leaves Secretary of Defense in before 2027? — Pete Hegseth", "Will Pete Hegseth leave the Trump administration before 2027?"],
  ["Will Israel and Saudi Arabia normalize relations before Jan 1, 2027? — Saudi Arabia", "Will Saudi Arabia join the Abraham Accords before 2027?"],
  ["Will Republicans win the U.S. Senate in 2026? — Republican Party", "Will the Republican Party control the Senate after the 2026 Midterm elections?"],
  ["Will Republican win the Presidency in 2028? — Republican party", "Will the Republicans win the 2028 US Presidential Election?"],
  ["Will the Republican party hold exactly 56 Senate seats in the 120th Congress? — 56", "Will the Republican Party hold exactly 56 Senate seats after the 2026 midterm elections?"],
  ["Will Kamala Harris announce a run for President of the United States before Jan 1, 2027? — Before Jan 1, 2027", "Will Kamala Harris announce a Presidential run before 2027?"],
];

const ACCEPT = [
  ["Will **real GDP** increase by more than 3.0% in Q3 2026? — Yes", "Will US GDP growth in Q3 2026 be greater than 3.0%?", "econ"],
  ["Will **real GDP** increase by more than 0.0% in Q3 2026? — Yes", "US GDP Growth in Q3 2026? — Above 0.0%", "econ"],
  ["Will **real GDP** increase by more than 2.5% in Q3 2026? — Yes", "US GDP Growth in Q3 2026? — Above 2.5%", "econ"],
  ["GDP growth in 2026? — 0.0% or Below", "Negative GDP growth in 2026?", "econ"],
  ["GDP growth in 2026? — 0.6% to 1.0%", "Will US GDP growth in 2026 be between 0.5% and 1.0%?", "econ"],
  ["GDP growth in 2026? — 2.1% to 2.5%", "Will US GDP growth in 2026 be between 2.0% and 2.5%?", "econ"],
  ["Will the Federal Reserve Hike rates by 25bps at their September meeting?", "Fed Decision in September — 25 bps Increase", "econ"],
  ["Will XRP trimmed mean be above $6.00 by 11:59 PM ET on Dec 31, 2026?", "Will XRP reach $6.00 by December 31, 2026?", "crypto"],
  ["Will XRP trimmed mean be below $1.00 by 11:59 PM ET on Dec 31, 2026?", "Will XRP dip to $1.00 by December 31, 2026?", "crypto"],
  ["Will Bitcoin be above $199,999.99 by Dec 31, 2026 at 11:59 PM ET?", "Will Bitcoin reach $200,000 by December 31, 2026?", "crypto"],
  ["Will Bitcoin be above $100000 by October 1, 2026 at 12:00AM ET?", "Will Bitcoin hit $100k by September 30, 2026?", "crypto"],
  ["Will SOL trimmed mean be below $40.00 by 11:59 PM ET on Dec 31, 2026?", "Will Solana dip to $40 by December 31, 2026?", "crypto"],
  ["Will Elon Musk's net worth for December 31, 2026 be above $700 billion?", "Elon Musk Net Worth on December 31? — Above $700 B", "econ"],
  ["When will OpenAI IPO? — Before Oct 1, 2026", "OpenAI IPO Officially Confirmed By — September 30, 2026", "econ"],
  ["Will the Federal Reserve Cut rates by 25bps at their September 2026 meeting?", "Fed Decision in September — 25 bps Decrease", "econ"],
  ["Will Musk have a net worth more than 1500 billion dollars before Dec 31, 2026?", "What Will Elon's Net Worth Hit By December 31? — $1.5T", "econ"],
  ["Will Marine Le Pen win the 2027 French presidential election?", "Will Marine Le Pen win the 2027 French presidential election?", "politics"],
  ["Will Trump recognize Somaliland? — Before 2027", "Will Trump recognize Somaliland before 2027?", "politics"],
  ["Will the U.S. confirm that aliens exist before 2027? — Before 2027", "Will the US confirm that aliens exist before 2027?", "politics"],
];

for (const [a, b] of REJECT_POL) REJECT.push([a, b, "politics"]);
for (const [a, b] of ACCEPT_POL) ACCEPT.push([a, b, "politics"]);

let bad = 0;
for (const [a, b, tag] of REJECT) if (ok(a, b, tag)) { console.log("STILL ACCEPTED (want reject):\n  ", a, "\n  ", b); bad++; }
for (const [a, b, tag] of ACCEPT) if (!ok(a, b, tag)) { console.log("REGRESSION (want accept):\n  ", a, "\n  ", b); bad++; }
console.log(`\n${REJECT.length} reject + ${ACCEPT.length} accept cases, ${bad} failing`);
process.exit(bad ? 1 : 0);
