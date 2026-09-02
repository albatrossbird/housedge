// parseVector: the premise of the embedding_v cutover.
//
// The vector column and the JSON column serialise identically —
// pgvector renders `[0.1,0.2,...]`, exactly what JSON.stringify produced
// for the array it replaced. embed.js already relies on that in the
// WRITE direction (one encoded string goes to both columns); these cases
// pin it in the read direction, because if it were false, matching would
// silently return zero candidates rather than fail.
import { parseVector } from "../lib/matcher.js";

let fail = 0;
const ok = (c, what) => { if (!c) { console.error("FAIL:", what); fail++; } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// pgvector's own text output.
ok(eq(parseVector("[0.1,0.2,0.3]"), [0.1, 0.2, 0.3]), "pgvector text form");
// What JSON.stringify writes — the same string.
ok(eq(parseVector(JSON.stringify([0.1, 0.2, 0.3])), [0.1, 0.2, 0.3]), "JSON.stringify form");
ok(JSON.stringify([0.1, 0.2, 0.3]) === "[0.1,0.2,0.3]", "the two forms ARE the same string");

// float4 rounding: the vector column stores less precision than the
// float64 JSON did. Values come back shorter, not malformed.
ok(eq(parseVector("[0.10000000149011612,-0.25]"), [0.10000000149011612, -0.25]), "float4-widened value");
ok(eq(parseVector("[-0.0234,1e-8,-3.5e-4]"), [-0.0234, 1e-8, -3.5e-4]), "exponent notation");

// Absent, which is every sports row and any row not yet embedded.
ok(parseVector(null) === null, "null");
ok(parseVector(undefined) === null, "undefined");
ok(parseVector("") === null || parseVector("") === null, "empty string does not throw a value through");

// Already hydrated by a client that parses arrays for us.
ok(eq(parseVector([1, 2, 3]), [1, 2, 3]), "already an array");

// Valid JSON that is not a vector must yield null, not a truthy
// non-array that cosineSimilarity would then index into.
ok(parseVector("{}") === null, "object is not a vector");
ok(parseVector("null") === null, "JSON null is not a vector");
ok(parseVector("42") === null, "number is not a vector");

console.log(fail === 0 ? "vector parse: all cases correct" : `vector parse: ${fail} FAILING`);
process.exit(fail === 0 ? 0 : 1);
