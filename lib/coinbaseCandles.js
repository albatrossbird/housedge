// Coinbase Exchange one-minute candles (public, no key):
//   GET api.exchange.coinbase.com/products/<product>/candles?granularity=60
// Each row is [time, low, high, open, close, volume], `time` the bucket's
// START in seconds. A request is capped at 300 buckets and public requests
// are rate-limited, so the period is walked in 300-minute slices with a
// pause. A failed slice is REPORTED in `errors`, never silently skipped:
// a missing slice would drop markets from a sample and quietly shrink the
// denominator. Shared by scripts/crypto-basis.mjs and the rule-file
// backtest (scripts/m15-rulebook-backtest.mjs).

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function coinbaseCandles(product, fromSecs, toSecs, errors, { fetchImpl = fetch, pauseMs = 250 } = {}) {
  const all = [];
  for (let s = fromSecs; s < toSecs; s += 300 * 60) {
    const e = Math.min(s + 300 * 60, toSecs);
    const u = `https://api.exchange.coinbase.com/products/${product}/candles` +
              `?granularity=60&start=${new Date(s * 1000).toISOString()}&end=${new Date(e * 1000).toISOString()}`;
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      try {
        const r = await fetchImpl(u, { headers: { "User-Agent": "marketslap/1.0" } });
        if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
        if (!r.ok) throw new Error(`coinbase ${r.status}`);
        all.push(...await r.json());
        ok = true;
      } catch (err) { if (attempt === 3) errors.push(`${new Date(s * 1000).toISOString()}: ${err.message}`); }
      if (pauseMs) await sleep(pauseMs);
    }
    if (!ok && !errors.some(x => x.startsWith(new Date(s * 1000).toISOString()))) errors.push(`${new Date(s * 1000).toISOString()}: rate-limited on every attempt`);
  }
  return all;
}
