// lib/archiveRead.js fetchRetrying: Storage's 429s and 5xx are retried
// with backoff (honouring Retry-After); answers are returned at once.
import { fetchRetrying, archiveReader } from "../lib/archiveRead.js";
import { gzipSync } from "node:zlib";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

console.log("the local cache");
{
  // One hour, one file. The listing reports its size and updated time;
  // a run reads it through listRange + eachLine as every script does.
  const T = Date.UTC(2026, 9, 24, 5);
  const gz = gzipSync(Buffer.from(Array.from({ length: 300 }, (_, i) => JSON.stringify({ a: i })).join("\n") + "\n"));
  let updated = "2026-10-24T06:00:01Z", body = gz, listedSize = gz.length, downloads = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/object/list/")) return new Response(JSON.stringify([{ id: "1", name: "a_box.ndjson.gz", updated_at: updated, metadata: { size: listedSize } }]));
    if (u.includes("/object/authenticated/")) { downloads++; return new Response(body); }
    return new Response("{}", { status: 404 });
  };
  const dir = mkdtempSync(join(tmpdir(), "archcache-"));
  const run = async (opts = {}) => {
    const logs = [], got = [];
    const r = archiveReader({ url: "https://fake", key: "k", log: m => logs.push(m), cacheDir: dir, ...opts });
    for (const f of await r.listRange("m15", T, T)) await r.eachLine(f.path, o => got.push(o.a));
    return { got, logs };
  };
  let x = await run();
  ok(downloads === 1 && x.got.length === 300, "first run downloads the file", downloads);
  ok(existsSync(join(dir, "stream-archive", "m15", "2026-10-24", "05", "a_box.ndjson.gz")), "and keeps a copy");
  x = await run();
  ok(downloads === 1 && x.got.length === 300 && x.got[299] === 299, "second run reads the copy: no download, every line", downloads);
  updated = "2026-10-24T07:10:00Z";
  x = await run();
  ok(downloads === 2 && x.got.length === 300, "a file replaced in Storage (new updated time) is downloaded again", downloads);
  x = await run();
  ok(downloads === 2, "and the new copy is used after that", downloads);
  // A download shorter than the listed size is read but never kept.
  updated = "2026-10-24T08:00:00Z"; listedSize = gz.length + 10;
  await run(); await run();
  ok(downloads === 4, "a download that does not match the listed size is never cached", downloads);
  // Read without a listing (a path from elsewhere): always downloaded, never cached.
  listedSize = gz.length;
  const before = downloads;
  const r = archiveReader({ url: "https://fake", key: "k", log: () => {}, cacheDir: dir });
  await r.eachLine("m15/2026-10-24/05/other.ndjson.gz", () => {});
  await r.eachLine("m15/2026-10-24/05/other.ndjson.gz", () => {});
  ok(downloads === before + 2 && !readdirSync(join(dir, "stream-archive", "m15", "2026-10-24", "05")).some(n => n.startsWith("other")), "an unlisted path is downloaded each time and not cached", downloads - before);
  // No cache directory: every run downloads.
  const d0 = downloads;
  await run({ cacheDir: null }); await run({ cacheDir: null });
  ok(downloads === d0 + 2, "without a cache directory every run downloads", downloads - d0);
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
