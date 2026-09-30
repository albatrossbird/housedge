// A paired Kalshi market that has STOPPED TRADING, and how to tell.
//
// FOUND 2026-09-29: every leg on the site was ~3 minutes old except one
// economics leg at 1,077,696 seconds — 12.5 days. By the next morning
// there were three:
//
//   FEDHIKE-26DEC31            "Will the Fed hike by Dec 31, 2026?"
//   KXFEDDISSENT-26SEP-MICH    "Who will dissent at the Sept FOMC? — Bowman"
//   KXFEDDISSENT-26SEP-NEEL    "                                  — Kashkari"
//
// All three are `status: finalized` on Kalshi, all closed 2026-09-16 —
// the September FOMC. FEDHIKE is a `can_close_early` market: the Fed
// hiked, it closed that afternoon and settled YES, three and a half
// months before the Dec 31 its stored close_time still said. The card
// went on quoting the last live book (94/95) beside a Polymarket US
// price, and published `profitable: true` on it — a 6.7c "edge" against
// a market that no longer exists.
//
// NOTHING WAS BROKEN IN THE WAY THE ALARMS LOOK FOR. The refresh polls
// each series with `status=open`, a finalized market is not open, so it
// is not returned and its row is simply not written — correctly. It was
// counted in `kalshiPairedMissed`, the bucket documented as "settled
// fixtures and finalized long shots, expected". And /api/markets hid
// only SPORTS pairs past their game date; a non-sports market had no
// rule at all, so a closed one rendered for as long as it stayed paired.
//
// And it stays paired forever. The matcher reads every stored Kalshi row
// with an embedding, whatever its status, so it re-pairs the settled
// market on every daily run; /api/prune never deletes a paired row; so
// the row is always "seen", always protected, always rendered. Nothing
// in that loop ever asks the venue whether the market still trades.
//
// So the refresh ASKS. A paired market the open poll did not return is
// looked up by ticker — Kalshi's /markets?tickers= answers in any
// status, one request for dozens — and the answer is split three ways,
// because "missed" used to be one number that could only ever be
// non-zero:
//
//   closed    — terminal status, or close_time already past. Its real
//               close_time is written back, and /api/markets hides any
//               pair whose Kalshi close_time is past. updated_at is NOT
//               touched: the price really is that old, and the age
//               shown anywhere must keep saying so.
//   stillOpen — Kalshi says it is trading, yet the open poll did not
//               return it. That is a poll bug (a page cap, a throttled
//               series) and the one worth alarming on.
//   notFound  — the lookup did not return it at all. Named, not
//               guessed at.

// Kalshi's market lifecycle. `active` trades; `initialized` is listed
// but not yet open; `inactive` is paused. Everything else is on its way
// to, or at, settlement and will never quote again.
export const KALSHI_TRADING_STATUSES = new Set(["active", "initialized", "inactive", "open", "unopened"]);

function parseTime(t) {
  if (t == null || t === "") return NaN;
  const n = typeof t === "number" ? t : Date.parse(t);
  return Number.isFinite(n) ? n : NaN;
}

// True when a stored Kalshi close_time is in the past. Unparseable or
// missing reads as NOT closed: absence of a close time is not evidence
// the market ended, and hiding on it would empty every row discovery
// stored without one.
export function kalshiCloseHasPassed(closeTime, now = Date.now()) {
  const t = parseTime(closeTime);
  return Number.isFinite(t) && t <= now;
}

// Split the paired-but-not-returned ids by what Kalshi says they are.
// `lookedUp` is the raw market objects from /markets?tickers=.
export function classifyPairedMissed(ids, lookedUp, now = Date.now()) {
  const byTicker = new Map((lookedUp || []).filter(m => m && m.ticker).map(m => [String(m.ticker), m]));
  const closed = [];
  const stillOpen = [];
  const notFound = [];
  for (const id of ids) {
    const m = byTicker.get(String(id));
    if (!m) { notFound.push(String(id)); continue; }
    const status = String(m.status || "").toLowerCase();
    const closeMs = parseTime(m.close_time);
    const pastClose = Number.isFinite(closeMs) && closeMs <= now;
    const terminal = status !== "" && !KALSHI_TRADING_STATUSES.has(status);
    if (terminal || pastClose) {
      // The close_time written back must be in the PAST, because that is
      // what /api/markets reads. Kalshi moves close_time to the actual
      // close on an early close (FEDHIKE: 2027-01-01 -> 2026-09-16), but
      // a terminal market still carrying a future close_time would stay
      // on screen if it were copied verbatim, so it is clamped to now.
      const closedAt = pastClose ? new Date(closeMs).toISOString() : new Date(now).toISOString();
      closed.push({
        id: String(id),
        status: status || null,
        result: m.result || null,
        closeTime: closedAt,
        write: { id: String(id), close_time: closedAt },
      });
    } else {
      stillOpen.push({ id: String(id), status: status || null });
    }
  }
  return { closed, stillOpen, notFound };
}

// One request per LOOKUP_CHUNK tickers. Tickers run to ~40 characters,
// so 50 is a ~2KB query string — well clear of the URL lengths that
// killed `.in()` on 1,774 ids.
const LOOKUP_CHUNK = 50;
const LOOKUP_ATTEMPTS = 4;

// Kalshi's batch lookup. Unknown tickers are simply omitted, so a short
// answer is read per id by classifyPairedMissed rather than trusted as a
// count. A chunk that fails after retries is REPORTED, and its ids come
// back in `failedIds` so the caller can say which markets went unasked
// — never folded into "not found", which would be a claim about Kalshi
// made from our own failed request.
export async function lookupKalshiTickers(ids, { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const markets = [];
  const errors = [];
  const failedIds = [];
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + LOOKUP_CHUNK);
    const url = "https://api.elections.kalshi.com/trade-api/v2/markets" +
      `?limit=${chunk.length}&tickers=${chunk.map(encodeURIComponent).join(",")}`;
    let body = null;
    let lastError = null;
    for (let attempt = 0; attempt < LOOKUP_ATTEMPTS && !body; attempt++) {
      try {
        const r = await fetchImpl(url);
        if (r.ok) { body = await r.json(); break; }
        lastError = `HTTP ${r.status}`;
        // Same rule as the series poll: 429 and 5xx are worth another
        // go, anything else is a real answer.
        if (r.status !== 429 && r.status < 500) break;
      } catch (err) {
        lastError = err.message;
      }
      if (attempt < LOOKUP_ATTEMPTS - 1) await sleep(1500 * Math.pow(2, attempt));
    }
    if (!body) {
      errors.push(`tickers lookup (${chunk.length} ids): ${lastError || "no body"}`);
      failedIds.push(...chunk);
      continue;
    }
    markets.push(...(body.markets || []));
  }
  return { markets, errors, failedIds };
}
