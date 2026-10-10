// lib/archiveRead.js fetchRetrying: Storage's 429s and 5xx are retried
// with backoff (honouring Retry-After); answers are returned at once.
import { fetchRetrying, archiveReader } from "../lib/archiveRead.js";
import { gzipSync } from "node:zlib";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const res = (status, retryAfter = null) => ({ ok: status < 400, status, headers: { get: h => (h === "retry-after" ? retryAfter : null) } });
const script = list => { let i = 0; return { calls: () => i, f: async () => { const x = list[Math.min(i++, list.length - 1)]; if (x instanceof Error) throw x; return x; } }; };

console.log("retrying archive requests");
{
  const waits = [], s = script([res(429), res(544), res(200)]);
  const r = await fetchRetrying(s.f, { sleep: async ms => waits.push(ms), baseMs: 100 });
  ok(r.status === 200 && s.calls() === 3, "a 429 and a 544 are retried until the file comes back", s.calls());
  ok(waits[0] === 100 && waits[1] === 200, "with doubling backoff", JSON.stringify(waits));
}
{
  const waits = [], s = script([res(429, "7"), res(200)]);
  await fetchRetrying(s.f, { sleep: async ms => waits.push(ms) });
  ok(waits[0] === 7000, "Retry-After is honoured", JSON.stringify(waits));
}
{
  const s = script([res(404)]);
  const r = await fetchRetrying(s.f, { sleep: async () => {} });
  ok(r.status === 404 && s.calls() === 1, "a 404 is an answer, not retried");
}
{
  const s = script([new Error("ECONNRESET"), res(200)]);
  const r = await fetchRetrying(s.f, { sleep: async () => {} });
  ok(r.status === 200 && s.calls() === 2, "a network error is retried");
}
{
  const s = script([res(429)]);
  const r = await fetchRetrying(s.f, { sleep: async () => {}, tries: 3 });
  ok(r.status === 429 && s.calls() === 3, "and gives up after its tries, returning the last answer for the caller to report");
}

console.log("a file that stops early");
{
  // A file whose tail is not gzip: what a recorder that crashed mid-write
  // leaves. gunzip errors (Z_DATA_ERROR) and the read keeps the lines it
  // decoded before the bad bytes, and says so. (zlib drops its last
  // unflushed piece with the error: of 5,000 lines, ~4,930 survive.)
  const body = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ a: i, pad: "x".repeat(50) })).join("\n") + "\n";
  const gz = gzipSync(Buffer.from(body));
  for (const [what, file] of [["a corrupt tail", Buffer.concat([gz, Buffer.from("not-gzip")])], ["a truncated file", gz.subarray(0, Math.floor(gz.length * 0.7))]]) {
    globalThis.fetch = async () => new Response(file);
    const logs = [], got = [];
    const reader = archiveReader({ url: "https://fake", key: "k", log: m => logs.push(m) });
    await reader.eachLine("m15/x.ndjson.gz", o => got.push(o.a));
    ok(got.length > 3000 && got.every((a, i) => a === i), `${what}: keeps what was readable, in order`, got.length);
    ok(logs.some(l => /stopped early/.test(l)), `${what}: and says it stopped early`, logs.join(" | "));
  }
}

console.log("a download cut off part way");
{
  // The connection drops after half the file. Read as it streamed, that
  // was a short file kept as if it were the hour; it is a failed download,
  // and fetching again returns the whole thing.
  const gz = gzipSync(Buffer.from(Array.from({ length: 2000 }, (_, i) => JSON.stringify({ a: i })).join("\n") + "\n"));
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls > 1) return new Response(gz);
    return new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(gz.subarray(0, gz.length >> 1))); c.error(new TypeError("terminated")); },
    }));
  };
  const logs = [], got = [];
  const reader = archiveReader({ url: "https://fake", key: "k", log: m => logs.push(m), retry: { sleep: async () => {} } });
  await reader.eachLine("m15/y.ndjson.gz", o => got.push(o.a));
  ok(calls === 2, "it is fetched again", calls);
  ok(got.length === 2000 && got[1999] === 1999, "and every line is read, not the half that arrived", got.length);
  ok(!logs.some(l => /stopped early/.test(l)), "with no early stop reported", logs.join(" | "));
}
{
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(new ReadableStream({ start(c) { c.error(new TypeError("terminated")); } })); };
  const reader = archiveReader({ url: "https://fake", key: "k", log: () => {}, retry: { sleep: async () => {}, tries: 3 } });
  let err = null;
  try { await reader.eachLine("m15/z.ndjson.gz", () => {}); } catch (e) { err = e; }
  ok(err && /cut off 3 times/.test(err.message) && calls === 3, "a download that never completes fails loudly after its tries", err?.message);
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
