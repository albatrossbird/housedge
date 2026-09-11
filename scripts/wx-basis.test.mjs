import { cToF, localDate, dailyExtremes, resolves, marginF, roundings, STATION_TZ } from "../lib/wxBasis.js";

let failures = 0;
const check = (n, ok) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${n}`); if (!ok) failures++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const obs = (ts, c, qc = "V") => ({ properties: { timestamp: ts, temperature: { value: c, qualityControl: qc } } });

console.log("a daily high is a LOCAL calendar day, not a UTC one");
{
  // 2026-09-11T05:00Z is still Sep 10 in Los Angeles. Bucketing by UTC
  // would move this reading into the next day's maximum.
  check("late-evening Pacific stays on the prior local date",
        localDate("2026-09-11T05:00:00Z", "America/Los_Angeles") === "2026-09-10");
  check("the same instant is already Sep 11 in New York",
        localDate("2026-09-11T05:00:00Z", "America/New_York") === "2026-09-11");
  check("an unparseable timestamp is null", localDate("nonsense", "America/New_York") === null);

  // Arizona does not observe DST, so it is not Denver in September.
  check("Phoenix is its own zone", STATION_TZ.KPHX === "America/Phoenix");
  check("...and Denver is not", STATION_TZ.KDEN === "America/Denver");
  check("every mapped station has a zone",
        Object.values(STATION_TZ).every(z => typeof z === "string" && z.includes("/")));
}

console.log("\nCelsius in, Fahrenheit out");
{
  check("0C is 32F", cToF(0) === 32);
  check("26.1C is 78.98F", near(cToF(26.1), 78.98));
  check("null stays null, not 32F", cToF(null) === null);
  // Kalshi's thresholds are whole degrees; the conversion lands between
  // them, so the rounding decides the answer on exactly the markets
  // close enough to trade.
  const r = roundings(78.98);
  check("round gives 79", r.round === 79);
  check("floor gives 78 — a DIFFERENT answer against an 'above 78' strike", r.floor === 78);
}

console.log("\nQC flags are not decoration");
{
  const rows = [
    obs("2026-09-10T16:00:00Z", 20, "V"),
    obs("2026-09-10T17:00:00Z", 99, "X"),   // failed validity — a sensor spike
    obs("2026-09-10T18:00:00Z", 22, "Q"),   // questionable
    obs("2026-09-10T19:00:00Z", 21, null),  // untagged
    obs("2026-09-10T20:00:00Z", null, "V"), // no reading
  ];
  const { byDate, rejected, noTemp } = dailyExtremes(rows, "America/New_York");
  const d = byDate.get("2026-09-10");
  check("the 99C spike is excluded from the daily high", near(d.highF, cToF(21)));
  check("two readings were rejected on QC", rejected === 2);
  check("a null reading is counted separately, not as 0C", noTemp === 1);
  check("only the kept readings are counted", d.n === 2);
}

console.log("\nstrike shapes resolve, and an unknown one admits it");
{
  check("above 86 with 87 observed is YES", resolves(87, { strike_type: "greater", floor_strike: 86 }) === true);
  check("above 86 with exactly 86 is NO", resolves(86, { strike_type: "greater", floor_strike: 86 }) === false);
  check("greater_or_equal at exactly 86 is YES",
        resolves(86, { strike_type: "greater_or_equal", floor_strike: 86 }) === true);
  check("below 95 with 94 is YES", resolves(94, { strike_type: "less", cap_strike: 95 }) === true);
  check("between 84 and 85 includes both ends",
        resolves(84, { strike_type: "between", floor_strike: 84, cap_strike: 85 }) === true &&
        resolves(85, { strike_type: "between", floor_strike: 84, cap_strike: 85 }) === true &&
        resolves(86, { strike_type: "between", floor_strike: 84, cap_strike: 85 }) === false);
  // A wrong guess is a confidently wrong comparison, which is worse
  // than an admitted gap.
  check("an unknown strike type is null, not a guess",
        resolves(87, { strike_type: "wobble", floor_strike: 86 }) === null);
  check("a missing strike is null", resolves(87, { strike_type: "greater" }) === null);
  check("no observation is null", resolves(null, { strike_type: "greater", floor_strike: 86 }) === null);
}

console.log("\nmargin: how far from the line the observation sat");
{
  check("3 degrees clear of an 'above' strike", near(marginF(89, { strike_type: "greater", floor_strike: 86 }), 3));
  check("negative when it missed", near(marginF(84, { strike_type: "greater", floor_strike: 86 }), -2));
  check("a 'below' strike measures the other way", near(marginF(94, { strike_type: "less", cap_strike: 95 }), 1));
  check("a range takes the NEARER edge",
        near(marginF(84.2, { strike_type: "between", floor_strike: 84, cap_strike: 88 }), 0.2));
  check("an unreadable shape is null", marginF(87, { strike_type: "wobble" }) === null);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
