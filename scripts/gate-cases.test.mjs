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
];

// Every pair verified correct in this file's audit history.
// Politics: Kalshi's Elections category against Polymarket's. Every
// REJECT here was accepted by a real dry run and read wrong by hand.
const REJECT_POL = [
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
];

const ACCEPT_POL = [
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
