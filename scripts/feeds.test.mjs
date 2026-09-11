import { scalePrice, pythGet, PythKeyMissing, PYTH_FEEDS } from "../lib/pyth.js";
import { twcGet, TwcKeyMissing, num, highLowOf } from "../lib/twc.js";

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failures++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
async function threw(fn, Type) { try { await fn(); return false; } catch (e) { return e instanceof Type; } }

console.log("Pyth reports a price as an integer plus an exponent");
{
  // Number(price) alone is wrong by eight orders of magnitude — and
  // still produces a plausible-looking direction call, which is what
  // makes it dangerous rather than obvious.
  check("scales by the exponent", near(scalePrice({ price: "265432100000", expo: -8 }), 2654.321));
  check("a positive exponent works too", near(scalePrice({ price: "5", expo: 2 }), 500));
  check("a missing price is null", scalePrice(null) === null);
  check("a non-numeric price is null, not NaN", scalePrice({ price: "x", expo: -8 }) === null);
  check("a missing expo is null, NOT treated as 0", scalePrice({ price: "100" }) === null);
}

console.log("\nthe feed ids match what Kalshi's rules name");
{
  check("gold maps to Metal.XAU/USD", PYTH_FEEDS.GOLD.symbol === "Metal.XAU/USD");
  check("oil maps to the feed Kalshi names literally",
        PYTH_FEEDS.PYTHOIL.symbol === "Commodities.Index.PYTHOIL/USD");
  check("every feed carries a 64-char id and a series",
        Object.values(PYTH_FEEDS).every(f => /^[0-9a-f]{64}$/.test(f.id) && f.series.startsWith("KX")));
}

console.log("\na missing or rejected key is its OWN error, not 'no data'");
{
  check("no key throws PythKeyMissing",
        await threw(() => pythGet("/v1/x", { key: "" }), PythKeyMissing));
  check("a 401 throws PythKeyMissing, not a generic failure",
        await threw(() => pythGet("/v1/x", { key: "k", fetchImpl: async () => ({ status: 401, ok: false, text: async () => "" }) }), PythKeyMissing));
  check("a 500 is a generic error, not a credential problem",
        !(await threw(() => pythGet("/v1/x", { key: "k", fetchImpl: async () => ({ status: 500, ok: false, text: async () => "" }) }), PythKeyMissing)));

  check("TWC with no key throws TwcKeyMissing",
        await threw(() => twcGet("/v3/x", { key: "" }), TwcKeyMissing));
  check("TWC 403 throws TwcKeyMissing",
        await threw(() => twcGet("/v3/x", { key: "k", fetchImpl: async () => ({ status: 403, ok: false, text: async () => "" }) }), TwcKeyMissing));
}

console.log("\nthe key never reaches the URL path, and format is set");
{
  let seen = null;
  await twcGet("/v3/wx/history/daily/1day?icaoCode=KNYC",
    { key: "SECRET", fetchImpl: async u => { seen = u; return { ok: true, status: 200, json: async () => ({}) }; } });
  check("the existing query string is preserved", seen.includes("icaoCode=KNYC"));
  check("apiKey is appended with & when a query already exists", seen.includes("&apiKey=SECRET"));
  check("format=json is always requested", seen.includes("format=json"));
}

console.log("\nan absent reading is null, never a fabricated zero");
{
  check("null stays null", num(null) === null);
  check("empty string stays null", num("") === null);
  check("a real zero survives", num(0) === 0);
  check("a real value parses", num("86") === 86);
  const hl = highLowOf({ temperatureMax: 86, temperatureMin: null });
  check("a present high reads", hl.high === 86);
  check("an absent low is null, not 0F", hl.low === null);
  check("no day at all is two nulls", highLowOf(null).high === null);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
