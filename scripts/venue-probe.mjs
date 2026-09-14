// Is THIS box's IP throttled by the venues?
//
// The recorders are network-bound, not CPU-bound — measured at ~5% of
// one core at a 12-second cadence — so the benchmark that separates
// VPS providers is not the one that decides this. What decides it is
// whether Kalshi throttles the address, and that is a fact about the
// provider's IP range rather than about its hardware.
//
// It is not a theoretical concern. Widening the refresh poll list drew
// SIXTEEN STRAIGHT HTTP 429s from Kalshi, and that is the failure mode
// that has actually cost this project data: a series that exhausts its
// retries freezes until the next run.
//
// So: run this on a candidate box before committing to it. Both major
// candidates bill by the hour, so the comparison costs a few cents and
// replaces a guess with a reading.
//
// Reads two public APIs. No credentials, no writes, nothing stored.
//
// Usage: node scripts/venue-probe.mjs [--minutes=10] [--cadence=12]

const arg = (n, d) => {
  const h = process.argv.find(a => a.startsWith(`--${n}=`));
  return h ? Number(h.split("=")[1]) : d;
};
const MINUTES = arg("minutes", 10);
const CADENCE = arg("cadence", 12);

// The real 15-minute family, at the real cadence. A probe that asks for
// one endpoint once proves nothing about a throttle that only appears
// under the request RATE the recorder actually produces.
const SERIES = [
  "KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M", "KXDOGE15M",
  "KXGOLD15M", "KXSILVER15M", "KXWTI15M", "KXNATGAS15M", "KXCOPPER15M",
  "KXPLATINUM15M", "KXPALLADIUM15M", "KXINX15M",
];
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

const stat = { ok: 0, rateLimited: 0, otherErr: 0, netErr: 0, latencies: [] };
const codes = new Map();
const bump = c => codes.set(c, (codes.get(c) || 0) + 1);

async function poll(series) {
  const t = Date.now();
  try {
    const r = await fetch(`${KALSHI}/markets?status=open&limit=100&series_ticker=${series}`);
    stat.latencies.push(Date.now() - t);
    bump(r.status);
    if (r.status === 429) {
      stat.rateLimited++;
      // Retry-After is the difference between backing off and making
      // the throttle worse; report whether the venue even sends one.
      const ra = r.headers.get("retry-after");
      if (stat.rateLimited === 1) console.log(`  first 429 at tick ${tick}, Retry-After: ${ra ?? "(absent)"}`);
      return;
    }
    if (!r.ok) { stat.otherErr++; return; }
    await r.text();
    stat.ok++;
  } catch (err) {
    // A DNS or TLS failure is NOT a throttle and must not be counted as
    // one — they argue for opposite conclusions about the provider.
    stat.netErr++;
    bump(`net:${err?.cause?.code || err.message?.slice(0, 30)}`);
  }
}

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

const ticks = Math.max(1, Math.round((MINUTES * 60) / CADENCE));
console.log(`VENUE PROBE  ${ticks} ticks x ${SERIES.length} series, every ${CADENCE}s (~${MINUTES} min)`);
console.log(`This is the recorder's real request rate against the real endpoints.\n`);

let tick = 0;
for (; tick < ticks; tick++) {
  const started = Date.now();
  await Promise.all(SERIES.map(poll));
  if (tick % 10 === 0 || tick === ticks - 1) {
    process.stdout.write(`  tick ${String(tick + 1).padStart(3)}/${ticks}  ` +
      `ok=${stat.ok} 429=${stat.rateLimited} err=${stat.otherErr + stat.netErr}\n`);
  }
  const wait = CADENCE * 1000 - (Date.now() - started);
  if (wait > 0 && tick < ticks - 1) await new Promise(r => setTimeout(r, wait));
}

const total = stat.ok + stat.rateLimited + stat.otherErr + stat.netErr;
console.log(`\nRESULT over ${total} requests`);
console.log(`  ok              ${stat.ok}`);
console.log(`  429 throttled   ${stat.rateLimited}   (${(100 * stat.rateLimited / total).toFixed(2)}%)`);
console.log(`  other HTTP      ${stat.otherErr}`);
console.log(`  network         ${stat.netErr}`);
console.log(`  latency p50/p95 ${pct(stat.latencies, 0.5)} / ${pct(stat.latencies, 0.95)} ms`);
console.log(`  status codes    ${[...codes].map(([k, v]) => `${k}:${v}`).join("  ")}`);

// The verdict is stated, not left to the reader, because the whole
// point is to replace an impression with a decision.
console.log();
if (stat.rateLimited === 0 && stat.netErr === 0) {
  console.log(`  CLEAN — this address is not being throttled at the recorder's rate.`);
  console.log(`  Latency is NOT the tiebreaker: both venues sit behind a CDN, so`);
  console.log(`  anything on the US east coast is within a few ms. If the cheaper`);
  console.log(`  box comes back clean, take the cheaper box.`);
} else if (stat.rateLimited > 0) {
  console.log(`  ::warning::THROTTLED — ${stat.rateLimited} of ${total} requests got a 429.`);
  console.log(`  This is the failure that freezes series until the next run. Try the`);
  console.log(`  other provider before committing; the difference is the IP range,`);
  console.log(`  not the hardware.`);
} else {
  console.log(`  ::warning::${stat.netErr} network failures and no 429s — that is a`);
  console.log(`  connectivity problem, not a throttle, and argues differently.`);
}
