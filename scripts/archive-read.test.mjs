// lib/archiveRead.js fetchRetrying: Storage's 429s and 5xx are retried
// with backoff (honouring Retry-After); answers are returned at once.
import { fetchRetrying } from "../lib/archiveRead.js";

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

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
