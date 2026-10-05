// No file in this repo may name a Polymarket US order endpoint.
//
// WHY A TEST AND NOT A NOTE. The box's .us key can trade — Polymarket US
// issues no read-only keys — and this repo uses it only for the market-
// data socket (scripts/pmus15-stream.mjs). The account behind it holds
// REAL MONEY — it is traded from a separate instance with its own key —
// so an order sent from here would spend it. A balance is not a property
// of the code either way. A helper that "just checks open orders" is one refactor away from one
// that places them, so the boundary is enforced where a change would
// have to cross it: any tracked file naming the order routes fails here.
//
// Trading happens from that separate instance with its own key and its
// own repository — never by deleting this test.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Built from pieces so this file does not match itself.
const ROUTE = new RegExp(["\\/v1\\/", "orders?", "(?![A-Za-z])"].join(""), "i");
const SELF = "scripts/no-order-endpoints.test.mjs";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(f => f && f !== SELF);
const hits = [];
for (const f of files) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  if (text.includes("\u0000")) continue;   // binary
  text.split("\n").forEach((line, i) => { if (ROUTE.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`); });
}

// The pattern must be able to fire, or this test proves nothing.
const canFire = ROUTE.test("POST " + "/v1/" + "orders") && ROUTE.test("/v1/" + "order/abc") && !ROUTE.test("/v1/orderbook");
if (!canFire) { console.error("FAIL the pattern does not match what it guards"); process.exit(1); }
if (hits.length) {
  console.error(`FAIL ${hits.length} line(s) name a Polymarket US order endpoint — the box's .us key can trade:\n${hits.join("\n")}`);
  process.exit(1);
}
console.log(`  ok  ${files.length} tracked files, none names an order endpoint`);
console.log("\nall passed");
