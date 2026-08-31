// cleanTitle is not exported (pages/api/* export only a handler), so the
// helper block is read out of the source and evaluated. That keeps the
// test honest — it exercises the shipped code rather than a copy that
// can drift.
import fs from "node:fs";

const src = fs.readFileSync(new URL("../lib/titles.js", import.meta.url), "utf8");
const body = src.slice(src.indexOf("const REDUNDANT_SIDE")).replace("export function cleanTitle", "function cleanTitle");
const cleanTitle = new Function(`${body}; return cleanTitle;`)();

const cases = [
  // A label the question already states in full is pure repetition.
  ["Will Jon Ossoff be the Democratic Presidential nominee in 2028? — Jon Ossoff", "Will Jon Ossoff be the Democratic Presidential nominee in 2028?"],
  ["Will Marine Le Pen win the 2027 French presidential election? — Marine Le Pen", "Will Marine Le Pen win the 2027 French presidential election?"],
  ["Will J.D. Vance win the 2028 Republican presidential nomination? — J.D. Vance", "Will J.D. Vance win the 2028 Republican presidential nomination?"],

  // MUST NOT CHANGE. A matchup names both sides, so the label is the
  // only thing saying which one the price belongs to. Dropping it is a
  // regression this function was already tightened once to stop.
  ["Miami vs Washington (Aug 29) — Miami", "Miami vs Washington (Aug 29) — Miami"],
  ["San Diego vs Cincinnati (Aug 31) — Cincinnati", "San Diego vs Cincinnati (Aug 31) — Cincinnati"],

  // A label the question does NOT state still carries information.
  ["Will Republican win the House race for LA-03? — Republican party", "Will Republican win the House race for LA-03? — Republican party"],

  // The numeric rule this function started as.
  ["Will real GDP increase by more than 3.0% in Q3 2026? — 3.0%", "Will real GDP increase by more than 3.0% in Q3 2026?"],
];

let bad = 0;
for (const [input, want] of cases) {
  const got = cleanTitle(input);
  if (got !== want) { console.log(`WRONG\n  in:   ${input}\n  got:  ${got}\n  want: ${want}`); bad++; }
}
console.log(bad ? `${bad} failing` : `all ${cases.length} correct`);
process.exit(bad ? 1 : 0);
