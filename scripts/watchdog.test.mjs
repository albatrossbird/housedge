import { parseWhen } from "../lib/parseWhen.js";

let failures = 0;
const check = (n, ok) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${n}`); if (!ok) failures++; };
const iso = t => (t == null ? null : new Date(t).toISOString());

console.log("the watched tables do not agree on how a time is stored");
{
  // The live value that made this check red for a table one minute old.
  check("markets stores epoch SECONDS",
        iso(parseWhen(1789567876)) === "2026-09-16T14:11:16.000Z");
  check("the quotes tables store ISO strings",
        iso(parseWhen("2026-09-16T14:11:16Z")) === "2026-09-16T14:11:16.000Z");
  check("epoch millis land on the same instant",
        iso(parseWhen(1789567876000)) === "2026-09-16T14:11:16.000Z");
  // PostgREST can render a bigint as a JSON number or a string
  // depending on width; both have to read the same.
  check("a numeric STRING is still epoch, not a date string",
        iso(parseWhen("1789567876")) === "2026-09-16T14:11:16.000Z");
}

console.log("\nseconds and millis are separated by magnitude, not by hope");
{
  // Epoch seconds pass 1e11 in the year 5138; epoch millis passed it in
  // 1973. Nothing this project sees is ambiguous.
  check("seconds stay seconds at the low end of the window",
        iso(parseWhen(1577836800)) === "2020-01-01T00:00:00.000Z");
  check("millis stay millis at the same instant",
        iso(parseWhen(1577836800000)) === "2020-01-01T00:00:00.000Z");
}

console.log("\na unit mistake must report AS a unit mistake");
{
  // This is the whole reason for the sanity window. Reading seconds as
  // millis yields 1970 — not an error, a VALID date that renders as
  // "489,000 hours stale" and sends the reader hunting a dead recorder
  // that is perfectly fine.
  check("zero is rejected, not reported as 1970", parseWhen(0) === null);
  check("a 1970 instant is rejected", parseWhen(1789567) === null);
  check("a year-5138 instant is rejected", parseWhen(99999999999999) === null);
}

console.log("\nabsence is distinguishable from garbage");
{
  check("null", parseWhen(null) === null);
  check("undefined", parseWhen(undefined) === null);
  check("empty string", parseWhen("") === null);
  check("garbage", parseWhen("not a time") === null);
  // Date.parse("1789567876") is NaN, which is what produced the
  // original wrong diagnosis. The numeric path must run FIRST.
  check("the numeric path runs before Date.parse",
        parseWhen(1789567876) !== null);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
