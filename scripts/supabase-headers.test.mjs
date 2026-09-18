// Auth headers for both Supabase key formats.
//
// The repo sent every key on BOTH `apikey` and `Authorization: Bearer`,
// which is right for a legacy JWT and wrong for the `sb_secret_` keys
// that replace them — those are opaque strings, not JWTs, and belong on
// `apikey` only. Legacy keys can no longer be rotated, so retiring a
// leaked service_role key FORCES the new format, which would have
// broken 24 call sites the moment it happened.
import { isNewFormatKey, authHeaders, writeHeaders } from "../lib/supabaseHeaders.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig";
const SECRET = "sb_secret_AbCdEf123456";
const PUB = "sb_publishable_AbCdEf123456";

console.log("format detection is on the documented prefix");
{
  ok(isNewFormatKey(SECRET) && isNewFormatKey(PUB), "sb_secret_ and sb_publishable_ are new format");
  ok(!isNewFormatKey(JWT), "a JWT is not");
  ok(!isNewFormatKey(""), "empty is not");
  // A malformed JWT must still be SENT as one, so it fails loudly as a
  // bad key rather than being quietly reclassified into another scheme.
  ok(!isNewFormatKey("eyJbroken"), "a malformed JWT is still treated as legacy");
}

console.log("\na legacy JWT goes on both headers, as before");
{
  const h = authHeaders(JWT);
  ok(h.apikey === JWT, "apikey set");
  ok(h.Authorization === `Bearer ${JWT}`, "Authorization set");
}

console.log("\na new secret key goes on apikey ONLY");
{
  const h = authHeaders(SECRET);
  ok(h.apikey === SECRET, "apikey set");
  ok(!("Authorization" in h), "Authorization is ABSENT, not empty — it authenticates nothing here");
}

console.log("\nwrite headers carry content type and Prefer, under both formats");
{
  const w = writeHeaders(JWT, { prefer: "return=minimal" });
  ok(w["Content-Type"] === "application/json" && w.Prefer === "return=minimal", "legacy write headers");
  ok(w.Authorization === `Bearer ${JWT}`, "and still both auth headers");

  const n = writeHeaders(SECRET, { prefer: "resolution=merge-duplicates" });
  ok(n.Prefer === "resolution=merge-duplicates" && !("Authorization" in n),
     "new-format write headers keep Prefer and drop Authorization");
  ok(n.apikey === SECRET, "and carry the key on apikey");
}

console.log("\nextras never overwrite the key");
{
  const h = authHeaders(JWT, { Accept: "application/json" });
  ok(h.Accept === "application/json" && h.apikey === JWT, "an extra header is merged alongside");
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
