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

let bad = 0;
for (const [a, b, tag] of REJECT) if (ok(a, b, tag)) { console.log("STILL ACCEPTED (want reject):\n  ", a, "\n  ", b); bad++; }
for (const [a, b, tag] of ACCEPT) if (!ok(a, b, tag)) { console.log("REGRESSION (want accept):\n  ", a, "\n  ", b); bad++; }
console.log(`\n${REJECT.length} reject + ${ACCEPT.length} accept cases, ${bad} failing`);
process.exit(bad ? 1 : 0);
