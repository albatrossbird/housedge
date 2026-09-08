// Which Polymarket legs a card shows under the US venue filter.
//
// The rule exists between two measured facts that pull opposite ways:
// 43 of 52 profitable legs are polymarket.com only (so dropping global
// legs removes most of the arb signal), while on cards carrying both
// venues the median price gap is 0.6pt (so showing every global leg
// repeats the row above it).
//
// Run: node scripts/venue-display.test.mjs

import { legsForUsView, MATERIAL_GAP_PTS } from "../lib/venueDisplay.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const leg = (id, { us = false, yes = 0.50, arb = null } = {}) => ({
  pairId: id,
  poly: { usTradable: us, yes },
  arb: arb === null ? null : { profitable: arb },
});
const ids = r => r.legs.map(l => l.pairId);

console.log("\na card with NO US leg shows nothing under the US filter");
{
  // Keeping it looks generous and breaks the control: the filter would
  // stop meaning "what a US account can trade" and the tab would show
  // every card. Measured when this was wrong: the stat row read
  // "Markets compared 662" under a chip reading "US 207".
  //
  // The front door's fallback is the deliberate exception and handles
  // itself — it only calls this for a card that has a US leg.
  const r = legsForUsView([leg("g", { yes: 0.4 })]);
  check("no legs render", r.legs.length === 0, ids(r).join());
  check("and no note claims a leg was collapsed", r.collapsed === null);
}

console.log("\na global leg that agrees with the US one collapses");
{
  const r = legsForUsView([leg("u", { us: true, yes: 0.500 }), leg("g", { yes: 0.506 })]);
  check("only the US leg renders", ids(r).join() === "u", ids(r).join());
  check("the collapse is REPORTED, not silent", r.collapsed != null);
  check("and it names the gap", r.collapsed?.gapPts === 0.6, String(r.collapsed?.gapPts));
}

console.log("\na global leg pricing materially apart keeps its row");
{
  const r = legsForUsView([leg("u", { us: true, yes: 0.50 }), leg("g", { yes: 0.62 })]);
  check("both render", ids(r).join() === "u,g", ids(r).join());
  check("nothing collapsed", r.collapsed === null);
}
{
  // The boundary is inclusive, so a leg exactly at the threshold shows.
  const r = legsForUsView([leg("u", { us: true, yes: 0.50 }), leg("g", { yes: 0.50 + MATERIAL_GAP_PTS / 100 })]);
  check(`a gap of exactly ${MATERIAL_GAP_PTS}pt is material`, ids(r).join() === "u,g", ids(r).join());
}

console.log("\nTHE CASE THE GAP RULE ALONE WOULD GET WRONG");
{
  // An arb comes from the KALSHI-to-Polymarket gap, not the
  // US-to-global one. So a global leg can sit half a point from its US
  // sibling and still be the profitable side of the card. A rule keyed
  // only on the venue gap would collapse exactly the leg a VPN reader
  // came for.
  const r = legsForUsView([leg("u", { us: true, yes: 0.500 }), leg("g", { yes: 0.503, arb: true })]);
  check("a profitable global leg is NEVER collapsed", ids(r).join() === "u,g", ids(r).join());
  check("and no note claims something was hidden", r.collapsed === null);
}
{
  // An unprofitable arb object must not keep the leg — only a real edge.
  const r = legsForUsView([leg("u", { us: true, yes: 0.500 }), leg("g", { yes: 0.503, arb: false })]);
  check("a priced-but-unprofitable leg still collapses", ids(r).join() === "u", ids(r).join());
}

console.log("\nan unreadable gap is not a small gap");
{
  // If either side has no price we cannot claim the two agree, so the
  // leg is shown rather than quietly dropped. Number(null) is 0, and
  // treating a missing price as 0 would read as a 50-point gap or as
  // perfect agreement depending on which side is missing — both are
  // claims about the venues rather than about our data.
  const r = legsForUsView([leg("u", { us: true, yes: null }), leg("g", { yes: 0.51 })]);
  check("missing US price keeps the global leg", ids(r).join() === "u,g", ids(r).join());
  const r2 = legsForUsView([leg("u", { us: true, yes: 0.51 }), leg("g", { yes: null })]);
  check("missing global price keeps it too", ids(r2).join() === "u,g", ids(r2).join());
}

console.log("\nseveral global legs, mixed");
{
  const r = legsForUsView([
    leg("u", { us: true, yes: 0.50 }),
    leg("g1", { yes: 0.501 }),          // agrees, no edge -> collapse
    leg("g2", { yes: 0.70 }),           // materially apart -> keep
    leg("g3", { yes: 0.504, arb: true }),// agrees but profitable -> keep
  ]);
  check("keeps the material and the profitable", ids(r).join() === "u,g2,g3", ids(r).join());
  check("counts what it collapsed", r.collapsed?.count === 1, String(r.collapsed?.count));
  check("US leg always leads", ids(r)[0] === "u");
}
{
  // The note quotes the CLOSEST hidden leg, so it can never overstate
  // how far away the thing it hid was.
  const r = legsForUsView([
    leg("u", { us: true, yes: 0.500 }),
    leg("g1", { yes: 0.519 }),
    leg("g2", { yes: 0.503 }),
  ]);
  check("the note quotes the nearest hidden leg", r.collapsed?.gapPts === 0.3, String(r.collapsed?.gapPts));
  check("and counts both", r.collapsed?.count === 2, String(r.collapsed?.count));
}

console.log("\ndegenerate input does not throw");
{
  check("empty", legsForUsView([]).legs.length === 0);
  check("null", legsForUsView(null).legs.length === 0);
  check("US legs only", ids(legsForUsView([leg("u", { us: true })])).join() === "u");
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
